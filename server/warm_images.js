// One-shot bottle-image warmer for url-sourced entries. The smell list never
// scrapes pages while browsing (smelllist.js), so url-source entries only get
// an image once queued in-game; for a small source (Malin+Goetz, Scent Room)
// this pre-fills cache/images/ instead. Reuses images.js, so the fetch logic
// and cache layout are exactly what the server uses.
//
// Usage:
//   node server/warm_images.js malinandgoetz.com   # filter on url host or brand
//   node server/warm_images.js "Malin+Goetz" --dry-run
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initImageCache, imageUrl, cacheImage } from './images.js';

const NOTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'out', 'notes');
const DELAY_MS = 700; // between page fetches, same politeness as the crawlers

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filter = args.find((a) => !a.startsWith('--'))?.toLowerCase();
if (!filter) {
  console.error('usage: node server/warm_images.js <brand-or-host substring> [--dry-run]');
  process.exit(2);
}

await initImageCache();

const targets = [];
for (const file of await readdir(NOTES_DIR)) {
  if (!file.endsWith('.json')) continue;
  const shard = JSON.parse(await readFile(path.join(NOTES_DIR, file), 'utf8'));
  for (const [id, entry] of Object.entries(shard)) {
    if (!entry.url || entry.fid != null) continue; // fid entries self-warm in the smell list
    let host;
    try {
      host = new URL(entry.url).host.toLowerCase();
    } catch {
      continue; // malformed url can't be fetched anyway
    }
    if (!host.includes(filter) && !(entry.brand ?? '').toLowerCase().includes(filter)) continue;
    targets.push({ id: Number(id), entry });
  }
}
targets.sort((a, b) => a.id - b.id);

let had = 0, fetched = 0, failed = 0;
for (const { id, entry } of targets) {
  if (imageUrl(id)) {
    had++;
    continue;
  }
  if (dryRun) {
    console.log(`would fetch ${id}: ${entry.brand} — ${entry.name} (${entry.url})`);
    continue;
  }
  await new Promise((settled) => cacheImage(id, entry, settled));
  const ok = imageUrl(id) != null;
  if (ok) fetched++; else failed++;
  console.log(`${ok ? 'ok' : 'FAILED'} ${id}: ${entry.brand} — ${entry.name}`);
  await new Promise((r) => setTimeout(r, DELAY_MS));
}
console.log(`${targets.length} matched: ${had} already cached, ${fetched} fetched, ${failed} failed${dryRun ? ' (dry run)' : ''}`);
