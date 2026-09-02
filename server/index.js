// HTTP + WebSocket server for the perfume note guessing game.
// Serves the static frontend, the search index, cached bottle images, a tiny
// JSON API for creating/inspecting games, and the realtime game protocol.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { initData, searchIndexGzip } from './data.js';
import { initImageCache, serveImage } from './images.js';
import { initSmellList, handleStores, handleNotesVocab, handleBrandsVocab, handleSmellList } from './smelllist.js';
import { createRoom, getRoom, GameError, CODE_LENGTH, GAME_TITLE } from './rooms.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CODE_PATTERN = new RegExp(`^/[A-Za-z0-9]{${CODE_LENGTH}}$`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Parsed JSON request body, or null if malformed / over the size cap. */
function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function serveStatic(res, file) {
  let decoded;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const info = await stat(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (req.method === 'GET' && pathname === '/') {
      return await serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && CODE_PATTERN.test(pathname)) {
      return await serveStatic(res, 'game.html');
    }
    if (req.method === 'GET' && pathname === '/data/search_index.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=300',
      });
      return res.end(searchIndexGzip());
    }
    if (req.method === 'GET' && pathname.startsWith('/img/')) {
      return await serveImage(Number(pathname.slice('/img/'.length)), res);
    }
    if (req.method === 'POST' && pathname === '/api/games') {
      const room = createRoom();
      return sendJson(res, 201, { code: room.code, hostKey: room.hostKey });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/games/')) {
      const room = getRoom(pathname.slice('/api/games/'.length));
      if (!room) return sendJson(res, 404, { error: 'No such game. Check the link.' });
      return sendJson(res, 200, { code: room.code, title: GAME_TITLE });
    }
    // SMELL LIST — /list is deliberately 4 characters; CODE_PATTERN above
    // swallows any 5-char alphanumeric path into game.html.
    if (req.method === 'GET' && pathname === '/list') {
      return await serveStatic(res, 'list.html');
    }
    if (req.method === 'GET' && pathname === '/api/stores') {
      return handleStores(res);
    }
    if (req.method === 'GET' && pathname === '/api/notes-vocab') {
      return handleNotesVocab(url, res);
    }
    if (req.method === 'GET' && pathname === '/api/brands-vocab') {
      return handleBrandsVocab(url, res);
    }
    if (req.method === 'GET' && pathname === '/api/smell-list') {
      return await handleSmellList(url, res);
    }
    if (req.method === 'GET') {
      return await serveStatic(res, pathname.slice(1));
    }
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
  }
});

// ---- WebSocket game protocol ------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null;
  let conn = null;

  const fail = (code, message) => ws.send(JSON.stringify({ t: 'error', code, message }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return fail('BAD_MESSAGE', 'Invalid message.');
    }
    try {
      if (msg.t === 'hello') {
        if (room && conn) room.detach(conn); // re-hello on the same socket replaces the attachment
        room = getRoom(msg.code);
        if (!room) return fail('NOT_FOUND', 'No such game. Check the link.');
        if (msg.role === 'host') {
          if (msg.hostKey !== room.hostKey) return fail('NOT_HOST', 'Not the host of this game.');
          conn = room.attach(ws, 'host', null);
        } else {
          const player = room.joinPlayer(msg.name, msg.playerId);
          conn = room.attach(ws, 'player', player.id);
          ws.send(JSON.stringify({ t: 'joined', playerId: player.id }));
        }
        return ws.send(JSON.stringify(room.stateFor(conn)));
      }

      if (!room || !conn) return fail('HELLO_FIRST', 'Say hello first.');

      const actorId = room.effectivePlayerId(conn);
      switch (msg.t) {
        case 'picks':
          if (!actorId) return fail('NOT_PLAYING', 'You are not playing this game.');
          return room.setPicks(actorId, msg.notes);
        case 'lock':
          if (!actorId) return fail('NOT_PLAYING', 'You are not playing this game.');
          return room.lock(actorId);
      }

      if (conn.role !== 'host') return fail('NOT_HOST', 'Host only.');
      switch (msg.t) {
        case 'options':
          return room.setOptions(msg);
        case 'queue-add':
          return await room.queueAdd(Number(msg.id));
        case 'queue-remove':
          return room.queueRemove(Number(msg.id));
        case 'start-round':
          return room.startRound();
        case 'reveal':
          return room.reveal();
        case 'finish':
          return room.finish();
        default:
          return fail('UNKNOWN_MESSAGE', 'Unknown message.');
      }
    } catch (err) {
      if (err instanceof GameError) return fail(err.code, err.message);
      console.error(err);
      return fail('SERVER_ERROR', 'Server error.');
    }
  });

  ws.on('close', () => {
    if (room && conn) room.detach(conn);
  });
});

await Promise.all([initImageCache(), initData()]);
await initSmellList();
server.listen(PORT, () => console.log(`smell-things listening on http://localhost:${PORT}`));
