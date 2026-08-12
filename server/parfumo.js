// Live gap-fill: the host pastes a Parfumo perfume URL for something the
// search can't find. (Fragrantica blocks server-side fetches, so we point
// hosts at parfumo.com instead — its pages load fine without a browser.)
// We fetch the page, parse the note pyramid, append the record to
// data/raw/parfumo_new.jsonl (so the offline pipeline merges it), and add it
// to the served dataset so it is searchable and queueable immediately.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPerfume, findByUrl } from './data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_NOTES_PATH = path.join(ROOT, 'data', 'raw', 'parfumo_new.jsonl');

const FETCH_TIMEOUT_MS = 20_000;
const HDRS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// Any parfumo.* host is accepted (parfumo.de serves the same slugs under
// /Parfums/), but we always fetch the English page so note names match the
// dataset vocabulary.
const URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*parfumo\.[a-z.]{2,6}\/(?:Perfumes|Parfums)\/([^/?#\s]+)\/([^/?#\s]+)/i;

// Page anatomy (see any parfumo.com perfume page):
//   <h1 class="p_name_h1" itemprop="name">NAME <span itemprop="brand">…
//     <span itemprop="name">BRAND</span></a> <a href="…/Release_Years/YYYY">…</h1>
// Notes are spans tagged data-nt="t|m|b" inside pyramid_block divs, or
// data-nt="n" in a flat notes_list; the note name is the <img> alt (also the
// span's text). Those spans appear nowhere else on the page.
const H1_RE = /<h1[^>]*class="p_name_h1"[^>]*>([\s\S]*?)<\/h1>/;
const BRAND_RE = /itemprop="brand"[\s\S]*?itemprop="name">([^<]*)/;
const YEAR_RE = /Release_Years\/(\d{4})/;
// The concentration sits outside the h1; dataset names include it
// ("Sauvage Eau de Toilette"), which keeps same-name flankers apart.
const CON_RE = /class="p_con[^"]*"[^>]*>([^<]*)/;
const NOTE_RE = /data-nt="([tmbn])"[^>]*>\s*<span[^>]*>\s*(?:<img[^>]*alt="([^"]*)"[^>]*>)?([^<]*)/g;
const TAG_RE = /<[^>]+>/g;

export class AddPerfumeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeHtml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => NAMED_ENTITIES[n]);
}

const cleanText = (html) => unescapeHtml(html.replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim();

/** {top, middle, base} note lists from the page's data-nt spans. */
function parseNotes(page) {
  const tierByCode = { t: 'top', m: 'middle', b: 'base', n: 'top' }; // flat lists land in top
  const tiers = { top: [], middle: [], base: [] };
  for (const m of page.matchAll(NOTE_RE)) {
    const note = unescapeHtml(m[2] ?? m[3]).trim();
    const tier = tiers[tierByCode[m[1]]];
    if (note && !tier.includes(note)) tier.push(note);
  }
  return Object.values(tiers).some((t) => t.length) ? tiers : null;
}

/** Structure/notes fields from a {top, middle, base} dict (build_dataset.tiers_to_entry). */
function tiersToEntry(tiers) {
  const filled = ['top', 'middle', 'base'].filter((t) => tiers[t].length);
  if (filled.length === 1) return { structure: 'flat', notes: { flat: tiers[filled[0]] } };
  return { structure: filled.length === 3 ? 'pyramid' : 'partial', notes: tiers };
}

async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, { headers: HDRS, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new AddPerfumeError(502, 'Could not reach Parfumo. Try again in a moment.');
  }
  if (res.status === 403 || res.status === 503) {
    throw new AddPerfumeError(502, 'Parfumo blocked the request. Try again in a few minutes.');
  }
  // unknown perfumes redirect to /404 with a 200 status
  if (res.status === 404 || new URL(res.url).pathname === '/404') {
    throw new AddPerfumeError(404, 'No Parfumo page at that link.');
  }
  if (!res.ok) throw new AddPerfumeError(502, `Parfumo answered with an error (${res.status}).`);
  return res.text();
}

// Adds run one at a time: dataset writes must not interleave, and a double
// submit of the same URL must see the first add's result.
let chain = Promise.resolve();

/**
 * Add a perfume from a Parfumo URL (or return it if the page is already in
 * the dataset). @returns {Promise<{entry: object, existed: boolean}>} — entry
 * is a search-index record {i, n, b, y, s}.
 */
export function addFromUrl(rawUrl) {
  const run = chain.then(async () => {
    const m = URL_RE.exec(String(rawUrl ?? ''));
    if (!m) {
      throw new AddPerfumeError(400, 'That does not look like a Parfumo perfume page link.');
    }
    const [, brandSlug, nameSlug] = m;
    const url = `https://www.parfumo.com/Perfumes/${brandSlug}/${nameSlug}`;

    const existing = await findByUrl(url);
    if (existing) return { entry: existing, existed: true };

    const page = await fetchPage(url);
    const h1 = H1_RE.exec(page)?.[1];
    const brandHtml = h1 && BRAND_RE.exec(h1);
    if (!h1 || !brandHtml) {
      throw new AddPerfumeError(422, 'Could not read a perfume name off that Parfumo page.');
    }
    let name = cleanText(h1.slice(0, h1.indexOf('<span')));
    const conc = CON_RE.exec(page)?.[1];
    if (conc && !name.toLowerCase().includes(cleanText(conc).toLowerCase())) {
      name = `${name} ${cleanText(conc)}`;
    }
    const brand = cleanText(brandHtml[1]);
    const year = YEAR_RE.exec(h1)?.[1];
    const tiers = parseNotes(page);
    if (!name || !brand) {
      throw new AddPerfumeError(422, 'Could not read a perfume name off that Parfumo page.');
    }
    if (!tiers) {
      throw new AddPerfumeError(422, 'That Parfumo page lists no notes, so there is nothing to guess.');
    }
    const { structure, notes } = tiersToEntry(tiers);

    // Record shape mirrors what build_dataset.load_parfumo_new consumes.
    const record = {
      url,
      name,
      brand,
      year: year ? Number(year) : null,
      gender: null,
      notes: tiers,
    };
    await appendFile(RAW_NOTES_PATH, JSON.stringify(record) + '\n', 'utf8');

    const entry = await addPerfume({ ...record, structure, notes });
    console.log(`added from URL: ${brand} - ${name} as id ${entry.i}`);
    return { entry, existed: false };
  });
  chain = run.catch(() => {}); // one failed add must not poison the queue
  return run;
}
