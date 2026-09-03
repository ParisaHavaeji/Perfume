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
  // dedup.json suppressions: flag duplicate-variant rows (x:1) so the host
  // search box can hide them. The ids stay valid — only search filters on x.
  const dedup = JSON.parse(await readFile(path.join(OUT_DIR, 'dedup.json'), 'utf8'));
  for (const idStr of Object.keys(dedup.suppress)) {
    const entry = searchIndex[Number(idStr)]; // ids are array positions
    if (entry) entry.x = 1;
  }
  searchIndexGz = gzipSync(JSON.stringify(searchIndex));
}

export function searchIndexGzip() {
  return searchIndexGz;
}

// Accessor, not a direct export — initData reassigns the binding.
export const getSearchIndex = () => searchIndex;

const perfumeAddedHooks = [];

/** Subscribe to live adds; fn(id, entry, indexEntry) runs at the end of addPerfume. */
export function onPerfumeAdded(fn) {
  perfumeAddedHooks.push(fn);
}

// Slug casing drifts between Parfumo page editions and the TidyTuesday dump,
// which also has old hyphenated slugs — compare case-blind with _ and - merged.
// Exported: images.js keys the committed image seed off the same identity.
export const urlKey = (url) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '').replace(/_/g, '-').toLowerCase();

let urlToId = null; // built from every shard on the first URL-add, then kept fresh

async function urlMap() {
  if (!urlToId) {
    urlToId = new Map();
    const maxShard = Math.floor(Math.max(0, searchIndex.length - 1) / SHARD_SIZE);
    for (let shardNo = 0; shardNo <= maxShard; shardNo++) {
      let shard;
      try {
        shard = await loadShard(shardNo);
      } catch {
        continue;
      }
      for (const [id, entry] of Object.entries(shard)) {
        if (entry.url) urlToId.set(urlKey(entry.url), Number(id));
      }
    }
  }
  return urlToId;
}

/** Search-index entry {i, n, b, y, s} for a source page URL already in the dataset, or null. */
export async function findByUrl(url) {
  const id = (await urlMap()).get(urlKey(url));
  return id == null ? null : (searchIndex[id] ?? null); // ids are array positions
}

const STRUCTURE_CHAR = { pyramid: 'p', flat: 'f', partial: 'x' };

/**
 * Append a perfume to the live dataset: memory, search_index.json, and its
 * notes shard. Currently unused — kept (with findByUrl and the onPerfumeAdded
 * hook) for the future live-add flow that will replace the removed Parfumo
 * one. Callers must serialize calls — no concurrent adds.
 * @returns {Promise<object>} the new search-index entry {i, n, b, y, s}
 */
export async function addPerfume({ name, brand, year, structure, notes, url }) {
  const id = searchIndex.length;
  const shardNo = Math.floor(id / SHARD_SIZE);
  const shard = await loadShard(shardNo).catch(() => ({}));
  shard[String(id)] = { notes, structure, name, brand, url }; // url: bottle image via og:image
  shards.set(shardNo, Promise.resolve(shard));
  await writeFile(path.join(OUT_DIR, 'notes', `${shardNo}.json`), JSON.stringify(shard), 'utf8');

  const entry = { i: id, n: name, b: brand, y: year, s: STRUCTURE_CHAR[structure] };
  searchIndex.push(entry);
  await writeFile(SEARCH_INDEX_PATH, JSON.stringify(searchIndex), 'utf8');
  searchIndexGz = gzipSync(JSON.stringify(searchIndex));
  if (urlToId) urlToId.set(urlKey(url), id);
  for (const fn of perfumeAddedHooks) fn(id, shard[String(id)], entry);
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
