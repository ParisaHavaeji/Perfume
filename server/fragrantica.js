// Live gap-fill: the host pastes a Fragrantica perfume URL for something the
// search can't find. We fetch the page, parse the notes exactly like
// data/fragrantica_refresh.py does, append the record to
// data/raw/fragrantica_new.jsonl (the crawl output, so the offline pipeline
// merges it and never re-crawls it), and add it to the served dataset so it is
// searchable and queueable immediately.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPerfume, findByFid } from './data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_NOTES_PATH = path.join(ROOT, 'data', 'raw', 'fragrantica_new.jsonl');

const FETCH_TIMEOUT_MS = 20_000;
const HDRS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// Any fragrantica.* host is accepted, but we always fetch the English page —
// the note parsing keys off English phrasing ("Top notes are ...").
const URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*fragrantica\.[a-z.]{2,6}\/perfume\/([^/?#\s]+)\/([^/?#\s]+)-(\d+)\.html/i;

// Ports of the regexes in data/fragrantica_refresh.py — keep them in sync.
const DESC_RE = /itemprop="description">([\s\S]*?)<\/div>/;
const TIER_RE = /([Tt]op|[Mm]iddle|[Bb]ase) notes? (?:are|is) ([^;.]*)/g;
const FLAT_RE = /(?<![Tt]op )(?<![Mm]iddle )(?<![Bb]ase )[Nn]otes (?:are|is|include) ([^;.]*)/;
const YEAR_RE = /launched in (\d{4})/;
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

/** "Lemon, Iris and Musk" -> ["Lemon", "Iris", "Musk"] (textnorm.split_notes). */
const splitNotes = (s) =>
  s
    .split(/, | and /)
    .map((p) => p.trim().replace(/\.+$/, ''))
    .filter(Boolean);

/** "histoires-de-parfums" -> "Histoires De Parfums" (textnorm.titlecase_slug). */
const titlecaseSlug = (slug) =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() && /\p{L}/u.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');

/** {tiers, desc} from the page description, or null (fragrantica_refresh.parse_notes). */
function parseNotes(page) {
  const m = DESC_RE.exec(page);
  if (!m) return null;
  const desc = unescapeHtml(m[1].replace(TAG_RE, ''));
  const tiers = { top: [], middle: [], base: [] };
  for (const tm of desc.matchAll(TIER_RE)) tiers[tm[1].toLowerCase()] = splitNotes(tm[2]);
  if (!Object.values(tiers).some((t) => t.length)) {
    const fm = FLAT_RE.exec(desc);
    if (fm) tiers.top = splitNotes(fm[1]);
  }
  if (!Object.values(tiers).some((t) => t.length)) return null;
  return { tiers, desc };
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
    throw new AddPerfumeError(502, 'Could not reach Fragrantica. Try again in a moment.');
  }
  if (res.status === 403 || res.status === 503) {
    throw new AddPerfumeError(502, 'Fragrantica blocked the request. Try again in a few minutes.');
  }
  if (res.status === 404) throw new AddPerfumeError(404, 'No Fragrantica page at that link.');
  if (!res.ok) throw new AddPerfumeError(502, `Fragrantica answered with an error (${res.status}).`);
  return res.text();
}

// Adds run one at a time: dataset writes must not interleave, and a double
// submit of the same URL must see the first add's result.
let chain = Promise.resolve();

/**
 * Add a perfume from a Fragrantica URL (or return it if the fid is already in
 * the dataset). @returns {Promise<{entry: object, existed: boolean}>} — entry
 * is a search-index record {i, n, b, y, s}.
 */
export function addFromUrl(rawUrl) {
  const run = chain.then(async () => {
    const m = URL_RE.exec(String(rawUrl ?? ''));
    if (!m) {
      throw new AddPerfumeError(400, 'That does not look like a Fragrantica perfume page link.');
    }
    const [, brandSlug, nameSlug, fidStr] = m;
    const fid = Number(fidStr);

    const existing = await findByFid(fid);
    if (existing) return { entry: existing, existed: true };

    const page = await fetchPage(`https://www.fragrantica.com/perfume/${brandSlug}/${nameSlug}-${fid}.html`);
    const parsed = parseNotes(page);
    if (!parsed) {
      throw new AddPerfumeError(422, 'That Fragrantica page lists no notes, so there is nothing to guess.');
    }
    const { structure, notes } = tiersToEntry(parsed.tiers);
    const year = YEAR_RE.exec(parsed.desc)?.[1];

    // Same record shape the crawler writes; gender/rating/votes come from the
    // Algolia index which we don't have here — build_dataset tolerates nulls.
    const record = {
      fid,
      slug: `${brandSlug}/${nameSlug}`,
      name: titlecaseSlug(nameSlug),
      brand: titlecaseSlug(brandSlug),
      year: year ? Number(year) : null,
      gender: null,
      rating: null,
      votes: null,
      notes: parsed.tiers,
    };
    await appendFile(RAW_NOTES_PATH, JSON.stringify(record) + '\n', 'utf8');

    const entry = await addPerfume({ ...record, structure, notes });
    console.log(`added from URL: ${record.brand} - ${record.name} (fid ${fid}) as id ${entry.i}`);
    return { entry, existed: false };
  });
  chain = run.catch(() => {}); // one failed add must not poison the queue
  return run;
}
