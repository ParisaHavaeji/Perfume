// Bottle image cache. Images are fetched once, when a perfume is queued, so
// reveals never depend on third-party hotlinking (see plan.md).
//
// - Fragrantica entries carry `fid`: the image lives at a known fimgs.net URL.
// - Parfumo/Luckyscent entries carry `url`: we fetch the page and follow its
//   og:image, falling back to JSON-LD product metadata (Luckyscent's Shopify
//   pages have no og:image).
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'images');
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]));

/** id -> {state: 'pending'|'ready'|'failed', ext?} */
const status = new Map();

export async function initImageCache() {
  await mkdir(CACHE_DIR, { recursive: true });
  for (const file of await readdir(CACHE_DIR)) {
    const ext = path.extname(file);
    if (TYPE_BY_EXT[ext]) status.set(Number(path.basename(file, ext)), { state: 'ready', ext });
  }
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

async function download(id, entry) {
  let imageSrc;
  if (entry.fid != null) {
    imageSrc = `https://fimgs.net/mdimg/perfume/375x500.${entry.fid}.jpg`;
  } else if (entry.url) {
    const page = await fetchWithTimeout(entry.url, 'text/html');
    imageSrc = findPageImage(await page.text());
    if (!imageSrc) throw new Error(`no page image at ${entry.url}`);
    imageSrc = new URL(imageSrc, entry.url).href;
  } else {
    throw new Error('entry has neither fid nor url');
  }

  const res = await fetchWithTimeout(imageSrc, 'image/*');
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[type];
  if (!ext) throw new Error(`unexpected content-type ${type} for ${imageSrc}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > MAX_IMAGE_BYTES) throw new Error(`bad image size ${body.length}`);
  await writeFile(path.join(CACHE_DIR, `${id}${ext}`), body);
  return ext;
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
  download(id, entry)
    .then((ext) => status.set(id, { state: 'ready', ext }))
    .catch((err) => {
      status.set(id, { state: 'failed' });
      console.warn(`image ${id}: ${err.message}`);
    })
    .finally(() => onSettled?.(id));
}

/** Serve a cached image, or 404. */
export function serveImage(id, res) {
  const entry = status.get(id);
  if (entry?.state !== 'ready') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPE_BY_EXT[entry.ext],
    'cache-control': 'public, max-age=86400',
  });
  createReadStream(path.join(CACHE_DIR, `${id}${entry.ext}`)).pipe(res);
}
