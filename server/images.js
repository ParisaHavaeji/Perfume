// Bottle image cache. Images are fetched once, when a perfume is queued, so
// reveals never depend on third-party hotlinking (see plan.md).
//
// - Fragrantica entries carry `fid`: the image lives at a known fimgs.net URL.
// - Parfumo/Luckyscent entries carry `url`: we fetch the page and follow its
//   og:image, falling back to JSON-LD product metadata (Luckyscent's Shopify
//   pages have no og:image).
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlKey } from './data.js';

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'images');
// Committed copies of warmed url-source images (Render's disk is ephemeral and
// cache/ is gitignored, so warmed images would otherwise never reach the live
// service). Keyed by urlSeedKey, NOT id — pipeline reruns renumber ids, and an
// id-keyed seed would serve the wrong perfume's photo. See seed_images.js.
const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'image_seed');
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]));

/** id -> {state: 'pending'|'ready'|'failed', ext?} */
const status = new Map();
/** id -> promise that settles when an in-flight download finishes. */
const inflight = new Map();
/** urlSeedKey -> ext, for every image in the committed seed. */
const seedExt = new Map();

/** Seed filename stem for a source URL; url-keyed so id renumbering can't stale it. */
export function urlSeedKey(url) {
  return createHash('sha1').update(urlKey(url)).digest('hex').slice(0, 16);
}

export async function initImageCache() {
  await mkdir(CACHE_DIR, { recursive: true });
  for (const file of await readdir(CACHE_DIR)) {
    const ext = path.extname(file);
    if (TYPE_BY_EXT[ext]) status.set(Number(path.basename(file, ext)), { state: 'ready', ext });
  }
  try {
    for (const file of await readdir(SEED_DIR)) {
      const ext = path.extname(file);
      if (TYPE_BY_EXT[ext]) seedExt.set(path.basename(file, ext), ext);
    }
  } catch {
    // no seed directory checked in — every url-source image stays cache-on-queue
  }
}

/** True when the committed seed holds this entry's image (a local copy, no scrape). */
export function hasSeedImage(entry) {
  return entry?.url != null && seedExt.has(urlSeedKey(entry.url));
}

export function imageUrl(id) {
  return status.get(id)?.state === 'ready' ? `/img/${id}` : null;
}

async function fetchWithTimeout(url, accept) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res;
}

/** An image value in JSON-LD: a URL string, an array of them, or an ImageObject. */
function ldImageValue(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const url = ldImageValue(x);
      if (url) return url;
    }
    return null;
  }
  if (v && typeof v === 'object') return ldImageValue(v.url ?? v.contentUrl ?? null);
  return null;
}

/** First `image` property in a JSON-LD document (or its @graph / array of nodes). */
function ldImage(node) {
  if (Array.isArray(node)) {
    for (const x of node) {
      const url = ldImage(x);
      if (url) return url;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    return ldImageValue(node.image ?? null) ?? ldImage(node['@graph'] ?? null);
  }
  return null;
}

function findPageImage(html) {
  const og =
    html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og) return og[1];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const url = ldImage(JSON.parse(m[1]));
      if (url) return url;
    } catch {
      // malformed JSON-LD block; keep looking
    }
  }
  return null;
}

/** Fetch each candidate image URL in turn; cache and return the ext of the first good one. */
async function fetchCandidates(id, candidates) {
  let lastError;
  for (const imageSrc of candidates) {
    try {
      const res = await fetchWithTimeout(imageSrc, 'image/*');
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const ext = EXT_BY_TYPE[type];
      if (!ext) throw new Error(`unexpected content-type ${type} for ${imageSrc}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > MAX_IMAGE_BYTES) throw new Error(`bad image size ${body.length}`);
      await writeFile(path.join(CACHE_DIR, `${id}${ext}`), body);
      return ext;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Image precedence (plan S5; shards can carry BOTH fid and url since the
// dual-emit change): committed seed by url (local copy, no network) -> fid CDN
// fetch (one plain fimgs.net request) -> source-page og:image/JSON-LD scrape
// (the expensive path, and the only one for url-only entries).
async function download(id, entry) {
  if (entry.url) {
    const key = urlSeedKey(entry.url);
    const ext = seedExt.get(key);
    if (ext) {
      try {
        await copyFile(path.join(SEED_DIR, `${key}${ext}`), path.join(CACHE_DIR, `${id}${ext}`));
        return ext;
      } catch {
        // seed file unreadable — fall through to the network path
      }
    }
  }
  if (entry.fid == null && !entry.url) throw new Error('entry has neither fid nor url');

  let fidError;
  if (entry.fid != null) {
    try {
      return await fetchCandidates(id, [`https://fimgs.net/mdimg/perfume/375x500.${entry.fid}.jpg`]);
    } catch (err) {
      fidError = err; // dual-key entries still have the page scrape below
    }
  }
  if (!entry.url) throw fidError;

  const page = await fetchWithTimeout(entry.url, 'text/html');
  const found = findPageImage(await page.text());
  if (!found) throw fidError ?? new Error(`no page image at ${entry.url}`);
  const src = new URL(found, entry.url).href;
  const candidates = [];
  // Parfumo's og:image is a watermarked 1200x630 social card; the same photo
  // is served clean under /perfumes/. Prefer it, fall back to the card.
  if (src.includes('/perfume_social/')) {
    candidates.push(src.replace('/perfume_social/', '/perfumes/').split('?')[0]);
  }
  candidates.push(src);
  return fetchCandidates(id, candidates);
}

/**
 * Fetch and cache the bottle image for a queued perfume; no-op if already
 * cached or in flight. Calls onSettled(id) when the outcome is known so game
 * state can be re-broadcast.
 */
export function cacheImage(id, entry, onSettled) {
  const current = status.get(id)?.state;
  if (current === 'pending' || current === 'ready') return;
  status.set(id, { state: 'pending' });
  const run = download(id, entry)
    .then((ext) => status.set(id, { state: 'ready', ext }))
    .catch((err) => {
      status.set(id, { state: 'failed' });
      console.warn(`image ${id}: ${err.message}`);
    })
    .finally(() => {
      inflight.delete(id);
      onSettled?.(id);
    });
  inflight.set(id, run);
}

/** Serve a cached image, or 404. */
export async function serveImage(id, res) {
  // A browse page hands out /img/:id the moment it kicks off the download, so
  // the browser's request usually races the fetch. Hold the response until the
  // download settles instead of 404ing into the client's slow retry path.
  if (status.get(id)?.state === 'pending') await inflight.get(id);
  const entry = status.get(id);
  if (entry?.state !== 'ready') {
    res.writeHead(404).end();
    return;
  }
  const stream = createReadStream(path.join(CACHE_DIR, `${id}${entry.ext}`));
  stream.on('open', () => {
    res.writeHead(200, {
      'content-type': TYPE_BY_EXT[entry.ext],
      'cache-control': 'public, max-age=86400',
    });
    stream.pipe(res);
  });
  stream.on('error', () => {
    // The cache file can vanish while the server runs (cache flushes are part
    // of pipeline reruns); an unhandled stream error would kill the process.
    status.delete(id);
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
}
