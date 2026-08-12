// Autoplay recommendation engine — YouTube's native radio (RD mix) with hardened dedup.
// Seeds YouTube's server-side radio from the last played track (and recent history when
// one mix is short), accumulates a deduplicated batch of related tracks, and filters out
// non-music. No external services or credentials.

const { normalizeString, displayMetadata } = require('./trackText');
const logger = require('./logger');

const AUTOPLAY_TARGET = Math.max(1, parseInt(process.env.AUTOPLAY_TARGET_COUNT || '25', 10) || 25);
const MAX_SEEDS = Math.max(1, parseInt(process.env.AUTOPLAY_MAX_SEEDS || '3', 10) || 3);
const HISTORY_WINDOW = 50;

// Seed scoring: recency dominates, but a clean "song entity" seed (Art Track / ISRC)
// yields a far better radio mix than a random upload, and autoplay-injected tracks
// reflect the engine's own guesses rather than the listener's taste.
const RECENCY_DECAY = 0.9;
const SONG_LIKE_BONUS = 0.35;
const AUTOPLAY_SEED_PENALTY = 0.4;
const SKIPPED_SEED_PENALTY = 0.6;

// Per-guild memory of autoplay picks the listener skipped early, used as negative
// feedback on the next refill. Bounded so a long session cannot grow it without limit.
const MAX_SKIP_MEMORY = 50;
const skipMemory = new Map();

// Clearly non-music uploads to skip. Kept deliberately small to avoid false positives.
// NOTE: "live"/"cover" are intentionally NOT here — they are music; the title normaliser
// already collapses live/alternate re-uploads of an already-played song during dedup.
const NON_MUSIC = /\b(reaction|trailer|teaser|interview|podcast|review|tutorial|gameplay|highlights?|behind\s+the\s+scenes|full\s+(?:movie|album|concert))\b/i;
const TOPIC_AUTHOR = /-\s*topic\s*$/i;

function isYouTubeSource(track) {
    const source = track?.info?.sourceName;
    return source === 'youtube' || source === 'youtubemusic';
}

function getRecentIdentifiers(player) {
    const ids = new Set();
    if (player.queue.current) ids.add(player.queue.current.info.identifier);
    for (const t of player.queue.previous.slice(-HISTORY_WINDOW)) {
        ids.add(t.info.identifier);
    }
    for (const t of player.queue.tracks) {
        if (t.info) ids.add(t.info.identifier);
    }
    return ids;
}

// 3-layer match: exact id, ISRC (same recording across uploads), normalised title
// (covers re-uploads / official-video vs audio / lyric videos).
function isDuplicate(track, recentIds, history) {
    if (recentIds.has(track.info.identifier)) return true;

    if (track.info.isrc) {
        for (const h of history) {
            if (h.info.isrc && h.info.isrc === track.info.isrc) return true;
        }
    }

    const normalized = normalizeString(track.info.title);
    if (!normalized) return false;
    for (const h of history) {
        const hNorm = normalizeString(h.info.title);
        if (normalized === hNorm) return true;
        if (normalized.length > 10 && hNorm.length > 10) {
            if (normalized.includes(hNorm) || hNorm.includes(normalized)) return true;
        }
    }
    return false;
}

function looksLikeNonMusic(track) {
    if (track.info.isStream) return true;
    return NON_MUSIC.test(track.info.title || '');
}

// Songs/audio (Art Tracks, YT Music, ISRC-bearing) are preferred over plain videos so
// that, when duplicates collapse or the batch overflows, the music-video copy is dropped.
function isSongLike(track) {
    const info = track.info;
    return Boolean(info.isrc) || info.sourceName === 'youtubemusic' || TOPIC_AUTHOR.test(info.author || '');
}

function skipKey(info = {}) {
    const title = normalizeString(info.title || '');
    const author = normalizeString(info.author || '');
    return title ? `${title}|${author}` : '';
}

/** Remembers an autoplay pick the listener skipped early, as negative feedback. */
function recordAutoplaySkip(guildId, track) {
    const key = skipKey(track?.info);
    if (!guildId || !key) return;

    let keys = skipMemory.get(guildId);
    if (!keys) {
        keys = new Set();
        skipMemory.set(guildId, keys);
    }
    keys.delete(key);
    keys.add(key);
    while (keys.size > MAX_SKIP_MEMORY) {
        keys.delete(keys.values().next().value);
    }
}

/** Call right before skipping: remembers the track only when autoplay picked it. */
function noteAutoplaySkip(player) {
    const current = player?.queue?.current;
    if (current?.userData?.autoplay) recordAutoplaySkip(player.guildId, current);
}

function getAutoplaySkips(guildId) {
    return skipMemory.get(guildId) || new Set();
}

function clearAutoplaySkips(guildId) {
    skipMemory.delete(guildId);
}

// Newest-first candidates, scored so the last played track still leads but a clean
// song-entity a few tracks back can outrank a noisy upload right behind it.
function buildSeeds(lastPlayedTrack, history, skips = new Set()) {
    const seen = new Set();
    const scored = [];
    const candidates = [lastPlayedTrack, ...history.slice().reverse()];

    candidates.forEach((t, index) => {
        const id = t?.info?.identifier;
        if (!id || !isYouTubeSource(t) || seen.has(id)) return;
        seen.add(id);

        let score = RECENCY_DECAY ** index;
        if (isSongLike(t)) score += SONG_LIKE_BONUS;
        if (t.userData?.autoplay) score -= AUTOPLAY_SEED_PENALTY;
        if (skips.has(skipKey(t.info))) score -= SKIPPED_SEED_PENALTY;

        scored.push({ track: t, score, index });
    });

    return scored
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, MAX_SEEDS)
        .map((entry) => entry.track);
}

// lavasrc's Spotify recommendation search — clean song entities with ISRCs, which
// dedup and match lyrics far better than raw YouTube uploads. `sprec:` needs a Spotify
// track id, so the seed is resolved through spsearch first. Optional: a missing plugin,
// disabled Spotify, or an unresolvable seed simply yields nothing.
async function fetchRecommendations(player, seed) {
    if (process.env.SPOTIFY_ENABLED !== 'true') return [];

    const { title, artist } = displayMetadata(seed?.info || {});
    if (!title) return [];

    try {
        let spotifyId = seed.info.sourceName === 'spotify' ? seed.info.identifier : null;

        if (!spotifyId) {
            const lookup = await player.search({ query: `spsearch:${artist} ${title}`.trim() });
            spotifyId = lookup?.tracks?.[0]?.info?.identifier || null;
        }
        if (!spotifyId) return [];

        const res = await player.search({ query: `sprec:seed_tracks=${spotifyId}` });
        return res?.tracks || [];
    } catch {
        return [];
    }
}

// Stable ordering within a pool: song entities before plain videos, and among those,
// ISRC-bearing uploads first — so when the dedup collapses variants of one recording,
// the cleaner copy is the one that survives.
function orderCandidates(tracks) {
    return tracks
        .filter((t) => t?.info)
        .map((track, index) => ({ track, index }))
        .sort((a, b) =>
            Number(isSongLike(b.track)) - Number(isSongLike(a.track))
            || Number(Boolean(b.track.info.isrc)) - Number(Boolean(a.track.info.isrc))
            || a.index - b.index
        )
        .map((entry) => entry.track);
}

async function fetchMix(player, videoId) {
    try {
        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
        const res = await player.search({ query: mixUrl });
        return res?.tracks || [];
    } catch {
        return [];
    }
}

/**
 * Builds an autoplay batch from YouTube's native radio (RD mix), seeded from the last
 * played track and recent history. Returns up to AUTOPLAY_TARGET unique, deduplicated
 * tracks, or [] when no usable recommendations are found.
 */
async function findAutoplayTracks(player, lastPlayedTrack, skips = getAutoplaySkips(player?.guildId)) {
    if (!lastPlayedTrack?.info) return [];

    const history = player.queue.previous.slice(-HISTORY_WINDOW);
    const seen = getRecentIdentifiers(player);
    seen.add(lastPlayedTrack.info.identifier);
    // ISRC/title dedup baseline — include currently playing, queued, and the just-finished
    // track so same-song variants with a different identifier are still caught.
    const dedupHistory = [
        ...(player.queue.current?.info ? [player.queue.current] : []),
        ...history.filter((t) => t?.info),
        ...player.queue.tracks.filter((t) => t?.info),
        lastPlayedTrack,
    ];

    const collected = [];
    const nonMusic = []; // deduped fallback, used only if everything else is filtered out
    const seeds = buildSeeds(lastPlayedTrack, history, skips);

    // Recommendations first (clean song entities), then one candidate list per seed mix.
    const pools = [];
    let recommendedCount = 0;

    for (const seed of seeds) {
        if (pools.length) break; // one recommendation pool is enough to steer the batch
        const recommended = await fetchRecommendations(player, seed);
        if (recommended.length) {
            recommendedCount = recommended.length;
            pools.push(orderCandidates(recommended));
        }
    }

    for (const seed of seeds) {
        const tracks = await fetchMix(player, seed.info.identifier);
        if (tracks.length) pools.push(orderCandidates(tracks));
    }

    // Round-robin across pools so a single mix cannot monopolise the batch.
    const maxDepth = Math.max(0, ...pools.map((p) => p.length));
    for (let depth = 0; depth < maxDepth && collected.length < AUTOPLAY_TARGET; depth++) {
        for (const pool of pools) {
            if (collected.length >= AUTOPLAY_TARGET) break;

            const track = pool[depth];
            if (!track?.info) continue;
            if (skips.has(skipKey(track.info))) continue;
            if (isDuplicate(track, seen, dedupHistory)) continue;

            seen.add(track.info.identifier);
            dedupHistory.push(track);

            if (looksLikeNonMusic(track)) nonMusic.push(track);
            else collected.push(track);
        }
    }

    const result = (collected.length ? collected : nonMusic).slice(0, AUTOPLAY_TARGET);
    logger.debug(
        `Autoplay: ${result.length} track(s) from ${seeds.length} seed(s) `
        + `(${recommendedCount} recommendation candidate(s), ${pools.length} pool(s))`
    );
    return result;
}

module.exports = {
    findAutoplayTracks,
    recordAutoplaySkip,
    noteAutoplaySkip,
    getAutoplaySkips,
    clearAutoplaySkips,
};
