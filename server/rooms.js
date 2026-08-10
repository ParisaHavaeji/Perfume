// Game rooms: server-authoritative state, pushed to clients over WebSockets.
//
// Phases: lobby -> (guessing -> reveal)* -> final
// The host drives every transition. Players can join at any phase (the join
// link is the game URL and stays live for the whole game); late joiners score
// 0 for rounds they weren't in.
import { randomBytes, randomUUID } from 'node:crypto';
import { getPerfume, tiersOf, allNotes, norm } from './data.js';
import { buildColumns } from './decoys.js';
import { cacheImage, imageUrl } from './images.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export const CODE_LENGTH = 5;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PLAYERS = 50;
const MAX_NAME_LENGTH = 24;
const MAX_QUEUE = 30;
const HOST_PLAYER_ID = 'host';

// The two ways a game can score, chosen by the host:
// - open: pick as many notes as you like; wrong picks cost points.
// - limited: pick only your best few notes; wrong picks are free.
// Each round snapshots its mode's rules at start and every state push carries
// them, so the UI never hardcodes the numbers and rooms.js is the only place
// they exist.
const MODES = {
  open: { hit: 10, wrong: -10 },
  limited: { hit: 10, wrong: 0 },
};
// In limited mode players get 5 picks, or 4 when the perfume has fewer notes.
const LIMITED_PICKS = { min: 4, max: 5 };

function maxPicksFor(mode, entry) {
  if (mode !== 'limited') return null;
  return Math.max(LIMITED_PICKS.min, Math.min(LIMITED_PICKS.max, allNotes(entry).length));
}

const rooms = new Map(); // code -> Room

const cleanName = (raw) => String(raw ?? '').trim().slice(0, MAX_NAME_LENGTH);

/** Error with a machine-readable code; the message is display copy only. */
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function getRoom(code) {
  return rooms.get(String(code ?? '').toUpperCase()) ?? null;
}

// Every game is the same occasion, so rooms all share one title.
export const GAME_TITLE = "Smell Things";

export function createRoom() {
  let code;
  do {
    code = Array.from(randomBytes(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

class Room {
  constructor(code) {
    this.code = code;
    this.hostKey = randomBytes(18).toString('hex');
    this.lastActivity = Date.now();
    this.options = { hideNames: false, hostPlays: false, mode: 'open' };
    this.queue = []; // [{id, entry}]
    this.players = new Map(); // playerId -> {id, name, roundScores: (number|null)[]}
    this.phase = 'lobby';
    this.roundIndex = -1;
    this.round = null; // {columns, offered: Set, picks: Map<playerId, string[]>, locked: Set, results: Map|null}
    this.sockets = new Set(); // {ws, role: 'host'|'player', playerId}
  }

  /** The queue item currently being played (valid whenever roundIndex >= 0). */
  get current() {
    return this.queue[this.roundIndex];
  }

  /**
   * The player identity a connection acts as: the host player when a host
   * connection is playing along, null when it is spectating. Every host
   * special case in the app routes through here.
   */
  effectivePlayerId(conn) {
    if (conn.role !== 'host') return conn.playerId;
    return this.options.hostPlays ? HOST_PLAYER_ID : null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---- connections ----------------------------------------------------------

  attach(ws, role, playerId) {
    const conn = { ws, role, playerId };
    this.sockets.add(conn);
    this.touch();
    return conn;
  }

  detach(conn) {
    this.sockets.delete(conn);
    this.broadcast(); // connected flags changed
  }

  joinPlayer(name, playerId) {
    const trimmed = cleanName(name);
    if (playerId && this.players.has(playerId)) return this.players.get(playerId);
    if (!trimmed) throw new GameError('NAME_REQUIRED', 'Enter a display name.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('GAME_FULL', 'This game is full.');
    const player = { id: randomUUID(), name: trimmed, roundScores: [] };
    this.players.set(player.id, player);
    this.touch();
    this.broadcast();
    return player;
  }

  // ---- host actions ---------------------------------------------------------

  setOptions({ hideNames, hostPlays, hostName, mode }) {
    if (typeof hideNames === 'boolean') this.options.hideNames = hideNames;
    if (typeof mode === 'string' && Object.hasOwn(MODES, mode)) this.options.mode = mode;
    if (typeof hostPlays === 'boolean') {
      this.options.hostPlays = hostPlays;
      if (hostPlays) {
        const name = cleanName(hostName);
        const existing = this.players.get(HOST_PLAYER_ID);
        if (existing) {
          if (name) existing.name = name;
        } else {
          if (!name) throw new GameError('NAME_REQUIRED', 'Enter your display name to play along.');
          this.players.set(HOST_PLAYER_ID, { id: HOST_PLAYER_ID, name, roundScores: [] });
        }
      } else if (this.players.has(HOST_PLAYER_ID) && this.roundIndex < 0) {
        this.players.delete(HOST_PLAYER_ID); // only unregister before any round was scored
      }
    }
    this.broadcast();
  }

  async queueAdd(perfumeId) {
    if (this.queue.length >= MAX_QUEUE) throw new GameError('QUEUE_FULL', `Queue is limited to ${MAX_QUEUE} perfumes.`);
    if (this.queue.some((q) => q.id === perfumeId)) throw new GameError('QUEUE_DUPLICATE', 'Already in the queue.');
    const entry = await getPerfume(perfumeId);
    if (!entry) throw new GameError('UNKNOWN_PERFUME', 'Unknown perfume.');
    if (tiersOf(entry).length === 0) throw new GameError('NO_NOTES', 'No notes in the dataset for that perfume.');
    this.queue.push({ id: perfumeId, entry });
    cacheImage(perfumeId, entry, () => this.broadcast());
    this.touch();
    this.broadcast();
  }

  queueRemove(perfumeId) {
    const index = this.queue.findIndex((q) => q.id === perfumeId);
    if (index < 0) return;
    if (index <= this.roundIndex) throw new GameError('ROUND_PLAYED', 'That round was already played.');
    this.queue.splice(index, 1);
    this.broadcast();
  }

  startRound() {
    if (this.phase !== 'lobby' && this.phase !== 'reveal') throw new GameError('NOT_BETWEEN_ROUNDS', 'Not between rounds.');
    if (this.roundIndex + 1 >= this.queue.length) throw new GameError('QUEUE_EMPTY', 'The queue is empty — add a perfume first.');
    this.roundIndex += 1;
    const columns = buildColumns(this.current.entry);
    this.round = {
      columns,
      offered: new Set(columns.flatMap((c) => c.notes.map(norm))),
      picks: new Map(),
      locked: new Set(),
      results: null,
      // Rules are frozen per round: a mode switch mid-round can't rewrite it.
      scoring: MODES[this.options.mode],
      maxPicks: maxPicksFor(this.options.mode, this.current.entry),
    };
    this.phase = 'guessing';
    this.touch();
    this.broadcast();
  }

  /** Player ids with at least one live socket. */
  connectedPlayerIds() {
    return new Set([...this.sockets].map((s) => this.effectivePlayerId(s)).filter(Boolean));
  }

  /** Players who have not locked this round; offline ones don't block the reveal. */
  pendingPlayers() {
    const connected = this.connectedPlayerIds();
    return [...this.players.values()]
      .filter((p) => !this.round.locked.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, connected: connected.has(p.id) }));
  }

  reveal() {
    if (this.phase !== 'guessing') throw new GameError('NO_ROUND', 'No round in progress.');
    const blocking = this.pendingPlayers().filter((p) => p.connected);
    if (blocking.length) {
      // reveal() is host-invoked, so the host player reads as "you".
      const names = blocking.map((p) => (p.id === HOST_PLAYER_ID ? 'you' : p.name));
      throw new GameError('NOT_LOCKED', `Waiting on ${names.join(', ')} to lock in.`);
    }
    const real = allNotes(this.current.entry);
    const realKeys = new Set(real.map(norm));
    this.round.results = new Map();
    for (const player of this.players.values()) {
      // Dedup picks by note identity, keeping the display string.
      const picked = new Map((this.round.picks.get(player.id) ?? []).map((n) => [norm(n), n]));
      const hits = [];
      const wrong = [];
      for (const [key, display] of picked) (realKeys.has(key) ? hits : wrong).push(display);
      const missed = real.filter((n) => !picked.has(norm(n)));
      const score = this.round.scoring.hit * hits.length + this.round.scoring.wrong * wrong.length;
      player.roundScores[this.roundIndex] = score;
      this.round.results.set(player.id, { hits, wrong, missed, score });
    }
    this.phase = 'reveal';
    this.touch();
    this.broadcast();
  }

  finish() {
    if (this.phase !== 'reveal') throw new GameError('ROUND_IN_PROGRESS', 'Finish the current round first.');
    this.phase = 'final';
    this.touch();
    this.broadcast();
  }

  // ---- player actions -------------------------------------------------------

  setPicks(playerId, notes) {
    if (this.phase !== 'guessing') throw new GameError('GUESSING_CLOSED', 'Guessing is closed.');
    if (!this.players.has(playerId)) throw new GameError('NOT_JOINED', 'Join the game first.');
    if (this.round.locked.has(playerId)) throw new GameError('LOCKED', 'Your guesses are locked.');
    // Dedup by note identity while filtering, so the pick cap counts distinct notes.
    const picked = new Map();
    for (const n of Array.isArray(notes) ? notes : []) {
      if (typeof n === 'string' && this.round.offered.has(norm(n))) picked.set(norm(n), n);
    }
    this.round.picks.set(playerId, [...picked.values()].slice(0, this.round.maxPicks ?? this.round.offered.size));
    this.touch();
    // No broadcast: picks are private, and nothing anyone else sees depends
    // on them until lock/reveal. This is the hottest path in the app.
  }

  lock(playerId) {
    if (this.phase !== 'guessing') throw new GameError('GUESSING_CLOSED', 'Guessing is closed.');
    if (!this.players.has(playerId)) throw new GameError('NOT_JOINED', 'Join the game first.');
    this.round.locked.add(playerId);
    this.touch();
    this.broadcast(); // lockedCount is public
  }

  // ---- state fan-out --------------------------------------------------------

  total(player) {
    return player.roundScores.reduce((sum, s) => sum + (s ?? 0), 0);
  }

  ranking(roundIndex) {
    return [...this.players.values()]
      .map((p) => ({ playerId: p.id, name: p.name, roundScore: p.roundScores[roundIndex] ?? 0, total: this.total(p) }))
      .sort((a, b) => b.total - a.total || b.roundScore - a.roundScore || a.name.localeCompare(b.name));
  }

  /** Player-facing label for the current round; force reveals the real name. */
  roundLabel(force = false) {
    if (!force && this.options.hideNames) return `Perfume #${this.roundIndex + 1}`;
    const { entry } = this.current;
    return `${entry.name} — ${entry.brand}`;
  }

  /** State tailored to one connection. Players never receive real notes before the reveal. */
  stateFor(conn, connectedIds = this.connectedPlayerIds()) {
    const isHost = conn.role === 'host';
    const playerId = this.effectivePlayerId(conn);
    const you = playerId ? this.players.get(playerId) : null;

    const state = {
      t: 'state',
      code: this.code,
      title: GAME_TITLE,
      phase: this.phase,
      roundIndex: this.roundIndex,
      roundCount: this.queue.length,
      options: this.options,
      role: isHost ? (this.options.hostPlays ? 'host-playing' : 'host-spectating') : 'player',
      players: [...this.players.values()].map((p) => ({
        name: p.name,
        connected: connectedIds.has(p.id),
        total: this.total(p),
      })),
      you: you ? { playerId: you.id, name: you.name, total: this.total(you) } : null,
    };

    if (isHost) {
      state.host = {
        queue: this.queue.map(({ id, entry }, i) => ({
          id,
          name: entry.name,
          brand: entry.brand,
          structure: entry.structure,
          played: i <= this.roundIndex,
          image: imageUrl(id),
        })),
      };
    }

    if (this.phase === 'guessing') {
      const { columns, locked, picks } = this.round;
      // One visibility rule: a spectating host sees everything; with names
      // visible there is nothing to spoil, so everyone gets name and photo.
      const spectating = isHost && !playerId;
      const spoil = spectating || !this.options.hideNames;
      state.round = {
        label: this.roundLabel(spoil),
        structure: this.current.entry.structure,
        columns,
        scoring: this.round.scoring,
        maxPicks: this.round.maxPicks,
        lockedCount: locked.size,
        playerCount: this.players.size,
      };
      if (playerId) {
        state.round.picks = picks.get(playerId) ?? [];
        state.round.locked = locked.has(playerId);
      }
      if (spoil) state.round.image = imageUrl(this.current.id);
      if (isHost) {
        state.round.pending = this.pendingPlayers().map(({ id, name, connected }) => ({
          name,
          connected,
          you: id === playerId,
        }));
      }
      if (spectating) state.round.real = allNotes(this.current.entry); // decoys shown dimmed
    }

    if (this.phase === 'reveal') {
      const { entry } = this.current;
      state.reveal = {
        name: entry.name,
        brand: entry.brand,
        image: imageUrl(this.current.id),
        scoring: this.round.scoring,
        ranking: this.ranking(this.roundIndex).map((r) => ({
          ...r,
          you: r.playerId === playerId,
          playerId: undefined,
        })),
        lastRound: this.roundIndex + 1 >= this.queue.length,
      };
      const result = playerId ? this.round.results.get(playerId) : null;
      if (result) state.reveal.result = result;
      else state.reveal.real = entry.notes; // spectating host sees the full pyramid instead
    }

    if (this.phase === 'final') {
      state.final = {
        roundCount: this.roundIndex + 1,
        standings: this.ranking(this.roundIndex).map((r) => ({
          name: r.name,
          total: r.total,
          you: r.playerId === playerId,
          rounds: Array.from({ length: this.roundIndex + 1 }, (_, i) => this.players.get(r.playerId).roundScores[i] ?? 0),
        })),
      };
    }

    return state;
  }

  broadcast() {
    const connectedIds = this.connectedPlayerIds(); // shared across the fan-out
    for (const conn of this.sockets) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify(this.stateFor(conn, connectedIds)));
      }
    }
  }
}
