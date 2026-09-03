// Sync warmed url-source bottle images into the committed seed store.
//
// Why this exists: Render's disk is ephemeral and cache/ is gitignored, so
// images warmed locally (warm_images.js) never reached the live service —
// url-source perfumes (Malin+Goetz, Scent Room, Luckyscent, …) showed no
// picture on the live smell list. data/image_seed/ is the committed copy the
// server falls back to: images.js copies a seed file into cache/images/ the
// first time the image is needed, and smelllist.js hands out /img/<id> for any
// entry the seed covers.
//
// Seed files are named urlSeedKey(entry.url) + ext, NOT <id> + ext — pipeline
// reruns renumber every id after a row-count change, and an id-keyed seed
// would serve the wrong perfume's photo after a rerun. URL keys survive.
//
// Usage (after warm_images.js; then let Parisa commit data/image_seed/):
//   node server/seed_images.js [--dry-run]
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlSeedKey } from './images.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES_DIR = path.join(ROOT, 'data', 'out', 'notes');
const CACHE_DIR = path.join(ROOT, 'cache', 'images');
const SEED_DIR = path.join(ROOT, 'data', 'image_seed');
const EXTS = ['.jpg', '.png', '.webp', '.gif'];

const dryRun = process.argv.includes('--dry-run');

async function fileExists(p) {
  return stat(p).then(() => true, () => false);
}

await mkdir(SEED_DIR, { recursive: true });

let copied = 0, kept = 0, uncached = 0;
const liveKeys = new Set();
for (const file of await readdir(NOTES_DIR)) {
  if (!file.endsWith('.json')) continue;
  const shard = JSON.parse(await readFile(path.join(NOTES_DIR, file), 'utf8'));
  for (const [id, entry] of Object.entries(shard)) {
    if (!entry.url) continue;
    // Every url-bearing entry counts as live for the orphan report — shards
    // dual-emit fid AND url since plan S5, and a seed whose entry later gained
    // a fid is still in use (download() checks the seed first).
    const key = urlSeedKey(entry.url);
    liveKeys.add(key);
    if (entry.fid != null) continue; // fid entries self-warm on Render; only url-source images seed
    let cachedExt = null;
    for (const ext of EXTS) {
      if (await fileExists(path.join(CACHE_DIR, `${id}${ext}`))) { cachedExt = ext; break; }
    }
    if (!cachedExt) {
      uncached++;
      continue;
    }
    if (await fileExists(path.join(SEED_DIR, `${key}${cachedExt}`))) {
      kept++;
      continue;
    }
    if (!dryRun) await copyFile(path.join(CACHE_DIR, `${id}${cachedExt}`), path.join(SEED_DIR, `${key}${cachedExt}`));
    copied++;
    console.log(`${dryRun ? 'would seed' : 'seeded'} ${key}${cachedExt} <- ${id} (${entry.brand} — ${entry.name})`);
  }
}

// Orphans: seed files no current url maps to (source left the dataset, or its
// url changed). Report only — deleting is Parisa's call.
let orphans = 0;
for (const file of await readdir(SEED_DIR)) {
  const ext = path.extname(file);
  if (!EXTS.includes(ext)) continue;
  if (!liveKeys.has(path.basename(file, ext))) {
    orphans++;
    console.log(`orphan seed file (no matching url in dataset): ${file}`);
  }
}

console.log(`${copied} ${dryRun ? 'would be ' : ''}seeded, ${kept} already seeded, ${uncached} url-source entries have no cached image, ${orphans} orphans`);
