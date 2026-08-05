// Access to the browser-ready dataset in data/out/.
// Shards in data/out/notes/ are keyed by floor(id / 1000).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'out');
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
