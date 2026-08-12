// Read-only HTTP API exposing the bot's current playback state, so external clients
// (the FeelaSync mobile app) can display synced lyrics for whatever the bot is playing.
// Node's built-in http server — no extra dependency, no outbound calls.

const http = require('node:http');
const crypto = require('node:crypto');

const { displayMetadata } = require('./trackText');
const logger = require('./logger');

const DEFAULT_PORT = 8778;
const REQUEST_TIMEOUT_MS = 10000;

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

// Hashing both sides first keeps the comparison constant-time regardless of length.
function isAuthorized(req, tokenDigest) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return crypto.timingSafeEqual(digest(match[1]), tokenDigest);
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

// Position is interpolated client-side by lavalink-client between node updates
// (clientBasedPositionUpdateInterval). Fall back to the last known value.
function readPosition(player, durationMs) {
    const raw = Number.isFinite(player.position) ? player.position : Number(player.lastPosition) || 0;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return Math.max(0, Math.round(raw));
    return Math.min(Math.max(0, Math.round(raw)), durationMs);
}

// Stable across restarts and re-queues, so the app can key its lyric cache and
// per-track offsets on it.
function trackId(info) {
    const source = info.sourceName === 'youtube' || info.sourceName === 'youtubemusic'
        ? 'yt'
        : (info.sourceName || 'unknown');
    return `${source}:${info.identifier}`;
}

function pickPlayer(client, guildId) {
    const players = [...(client.lavalink?.players?.values() || [])].filter((p) => p?.queue?.current);
    if (guildId) return players.find((p) => p.guildId === guildId) || null;
    if (!players.length) return null;

    const startedAt = (p) => client.activePlayers.get(p.guildId)?.startedAt || 0;
    const rank = (p) => (p.playing && !p.paused ? 1 : 0);
    return players.sort((a, b) => rank(b) - rank(a) || startedAt(b) - startedAt(a))[0];
}

function buildState(client, guildId) {
    const player = pickPlayer(client, guildId);
    if (!player) return { active: false, serverTime: Date.now() };

    const track = player.queue.current;
    const info = track.info || {};
    const durationMs = Number(info.duration) || 0;
    const { title, artist } = displayMetadata(info);

    return {
        active: true,
        guildId: player.guildId,
        isPlaying: Boolean(player.playing && !player.paused),
        paused: Boolean(player.paused),
        positionMs: readPosition(player, durationMs),
        serverTime: Date.now(),
        queueLength: player.queue.tracks?.length || 0,
        autoplay: Boolean(client.autoplayEnabled.get(player.guildId)),
        track: {
            id: trackId(info),
            identifier: info.identifier || null,
            title,
            artist,
            rawTitle: info.title || '',
            rawAuthor: info.author || '',
            durationMs,
            artworkUrl: info.artworkUrl || null,
            uri: info.uri || null,
            sourceName: info.sourceName || null,
            isrc: info.isrc || null,
            isStream: Boolean(info.isStream),
        },
    };
}

/**
 * Starts the sync API when SYNC_API_TOKEN is set. Returns the http.Server, or null
 * when the API is disabled (no token configured).
 */
function startSyncServer(client) {
    const token = process.env.SYNC_API_TOKEN;
    if (!token) {
        logger.debug('Sync API disabled (SYNC_API_TOKEN not set)');
        return null;
    }

    const port = parseInt(process.env.SYNC_API_PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT;
    const tokenDigest = digest(token);

    const server = http.createServer((req, res) => {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return sendJson(res, 400, { error: 'bad_request' });
        }

        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

        if (url.pathname === '/health') return sendJson(res, 200, { ok: true });

        if (url.pathname !== '/now-playing') return sendJson(res, 404, { error: 'not_found' });

        if (!isAuthorized(req, tokenDigest)) return sendJson(res, 401, { error: 'unauthorized' });

        try {
            sendJson(res, 200, buildState(client, url.searchParams.get('guildId') || null));
        } catch (err) {
            logger.error('Sync API failed to build state:', err);
            sendJson(res, 500, { error: 'internal_error' });
        }
    });

    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;

    server.on('error', (err) => {
        logger.error('Sync API server error:', err.message);
    });

    server.listen(port, '0.0.0.0', () => {
        logger.info(`Sync API listening on port ${port}`);
    });

    return server;
}

module.exports = { startSyncServer, buildState, trackId };
