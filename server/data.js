// Access to the browser-ready dataset in data/out/.
// Shards in data/out/notes/ are keyed by floor(id / 1000).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'out');
const SHARD_SIZE = 1000; // mirrors clean_dataset.py
export const SEARCH_INDEX_PATH = path.join(OUT_DIR, 'search_index.json');
export const VOCAB_PATH = path.join(OUT_DIR, 'notes_vocab.json');

/**
 * Canonical note identity. Scoring, decoy exclusion, and pick dedup all
 * compare notes through this one function (the client mirrors it in game.js).
 */
export const norm = (s) => s.trim().toLowerCase();

const shards = new Map(); // shardNo -> Promise<Record<string, PerfumeEntry>>

function loadShard(shardNo) {
  let shard = shards.get(shardNo);
  if (!shard) {
    shard = readFile(path.join(OUT_DIR, 'notes', `${shardNo}.json`), 'utf8').then(JSON.parse);
    shard.catch(() => shards.delete(shardNo)); // don't cache failures
    shards.set(shardNo, shard);
  }
  return shard;
}

// ---- search index -----------------------------------------------------------
// The server owns the parsed index (ids are array positions, 0..N-1) plus a
// pre-gzipped copy for serving; both refresh when a perfume is added live.

let searchIndex = [];
let searchIndexGz = null;

export async function initData() {
  searchIndex = JSON.parse(await readFile(SEARCH_INDEX_PATH, 'utf8'));
  searchIndexGz = gzipSync(JSON.stringify(searchIndex));
}

export function searchIndexGzip() {
  return searchIndexGz;
}

let fidToId = null; // built from every shard on the first URL-add, then kept fresh

async function fidMap() {
  if (!fidToId) {
    fidToId = new Map();
    const maxShard = Math.floor(Math.max(0, searchIndex.length - 1) / SHARD_SIZE);
    for (let shardNo = 0; shardNo <= maxShard; shardNo++) {
      let shard;
      try {
        shard = await loadShard(shardNo);
      } catch {
        continue;
      }
      for (const [id, entry] of Object.entries(shard)) {
        if (entry.fid != null) fidToId.set(entry.fid, Number(id));
      }
    }
  }
  return fidToId;
}

/** Search-index entry {i, n, b, y, s} for a Fragrantica id already in the dataset, or null. */
export async function findByFid(fid) {
  const id = (await fidMap()).get(fid);
  return id == null ? null : (searchIndex.find((e) => e.i === id) ?? null);
}

const STRUCTURE_CHAR = { pyramid: 'p', flat: 'f', partial: 'x' };

/**
 * Append a perfume to the live dataset: memory, search_index.json, and its
 * notes shard. Caller (fragrantica.js) serializes calls — no concurrent adds.
 * @returns {Promise<object>} the new search-index entry {i, n, b, y, s}
 */
export async function addPerfume({ name, brand, year, structure, notes, fid }) {
  const id = searchIndex.length;
  const shardNo = Math.floor(id / SHARD_SIZE);
  const shard = await loadShard(shardNo).catch(() => ({}));
  shard[String(id)] = { notes, structure, name, brand, fid };
  shards.set(shardNo, Promise.resolve(shard));
  await writeFile(path.join(OUT_DIR, 'notes', `${shardNo}.json`), JSON.stringify(shard), 'utf8');

  const entry = { i: id, n: name, b: brand, y: year, s: STRUCTURE_CHAR[structure] };
  searchIndex.push(entry);
  await writeFile(SEARCH_INDEX_PATH, JSON.stringify(searchIndex), 'utf8');
  searchIndexGz = gzipSync(JSON.stringify(searchIndex));
  if (fidToId) fidToId.set(fid, id);
  return entry;
}

/** @returns {Promise<{notes: object, structure: 'pyramid'|'flat', name: string, brand: string, fid?: number, url?: string} | null>} */
export async function getPerfume(id) {
  if (!Number.isInteger(id) || id < 0) return null;
  try {
    const shard = await loadShard(Math.floor(id / 1000));
    return shard[String(id)] ?? null;
  } catch {
    return null;
  }
}

/** Tiers that actually contain notes, in pyramid order. */
export function tiersOf(entry) {
  const order = entry.structure === 'flat' ? ['flat'] : ['top', 'middle', 'base'];
  return order.filter((t) => Array.isArray(entry.notes[t]) && entry.notes[t].length > 0);
}

/** All real notes of a perfume across every tier, original casing, deduplicated. */
export function allNotes(entry) {
  const seen = new Set();
  const notes = [];
  for (const tier of tiersOf(entry)) {
    for (const note of entry.notes[tier]) {
      const key = norm(note);
      if (!seen.has(key)) {
        seen.add(key);
        notes.push(note);
      }
    }
  }
  return notes;
}
