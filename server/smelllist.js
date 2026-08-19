// SMELL LIST (the in-store finder): note/brand/store filter index + API.
// At boot, builds note->perfume postings, brand->perfume ids, per-store id
// sets, and rating metadata from data/out/, then serves /api/stores, the two
// pre-gzipped vocabs, and the /api/smell-list query endpoint.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { norm, getSearchIndex, onPerfumeAdded, getPerfume } from './data.js';
import { imageUrl, cacheImage } from './images.js';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'out');
const SHARD_SIZE = 1000; // mirrors data.js / clean_dataset.py

const SORTS = new Set(['pop', 'rating', 'year']);
const MAX_BRANDS = 6;
const MAX_NOTES = 12;
const EMPTY = new Uint32Array(0);

let postings = new Map(); // norm(note) -> Uint32Array of ids, ascending
let brandToIds = new Map(); // exact dataset brand string -> Uint32Array asc
let noteDisplayByKey = new Map(); // norm(note) -> display name, for filtered vocab counts
let suppressed = new Set(); // dedup.json variant rows: hidden from /list, ids valid elsewhere
let stores = []; // {id, name, kind, area, as_of, brandSet, idArray, idSet}
let storesById = new Map();
let metaLen = 0; // any id >= metaLen (a live add) is unrated everywhere
let ratingArr = null; // Float64Array, NaN = no rating
let scaleArr = null; // Uint8Array, 0 = no rating
let pctArr = null; // Int16Array, -1 = null percentile (unrated or gated)
let notesVocabGz = null; // built once at boot; live adds accepted as stale
let brandsVocabGz = null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function unionSorted(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint32Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out.sort();
}

export async function initSmellList() {
  const t0 = performance.now();
  // Postings and per-id typed arrays live in ArrayBuffers, outside heapUsed —
  // count both, or the log understates the real footprint. Without --expose-gc
  // the delta also carries uncollected parse garbage from the shard stream;
  // run `node --expose-gc server/index.js` for the steady-state number.
  globalThis.gc?.();
  const mem0 = process.memoryUsage();
  const heap0 = mem0.heapUsed + mem0.arrayBuffers;
  const index = getSearchIndex();

  // dedup.json: duplicate-variant rows (same juice, another format/source) are
  // invisible on /list — skipped in every structure below and rejected in
  // passes(). unionNotes members (non-parfumo variants only; parfumo notes
  // stay quarantined pending the poisoning call) still lend their notes to
  // their canonical id, so want=Neroli keeps matching Neroli 36 after the
  // Perfume Oil row is hidden.
  const dedup = JSON.parse(await readFile(path.join(OUT_DIR, 'dedup.json'), 'utf8'));
  suppressed = new Set(Object.keys(dedup.suppress).map(Number));
  const unionFrom = new Map(dedup.unionNotes.map((sid) => [sid, dedup.suppress[sid]]));

  // Note postings: stream every shard once and discard the parse — not through
  // data.js's shard cache, so init stays decoupled from what it pins.
  const noteLists = new Map(); // norm(note) -> number[] (ids arrive ascending)
  const unionExtras = new Map(); // norm(note) -> Set of canonical ids gaining the note
  const maxShard = Math.floor(Math.max(0, index.length - 1) / SHARD_SIZE);
  for (let shardNo = 0; shardNo <= maxShard; shardNo++) {
    const shard = JSON.parse(await readFile(path.join(OUT_DIR, 'notes', `${shardNo}.json`), 'utf8'));
    for (const [idStr, entry] of Object.entries(shard)) {
      const id = Number(idStr);
      const unionTo = unionFrom.get(id);
      if (suppressed.has(id) && unionTo === undefined) continue;
      const seen = new Set();
      for (const tier of Object.values(entry.notes)) {
        if (!Array.isArray(tier)) continue;
        for (const note of tier) {
          const key = norm(note);
          if (seen.has(key)) continue;
          seen.add(key);
          if (unionTo !== undefined) {
            let ex = unionExtras.get(key);
            if (!ex) unionExtras.set(key, (ex = new Set()));
            ex.add(unionTo);
          } else {
            let list = noteLists.get(key);
            if (!list) noteLists.set(key, (list = []));
            list.push(id);
          }
        }
      }
    }
  }
  // Fold unioned notes into the canonical lists; keep them deduped + ascending.
  for (const [key, cids] of unionExtras) {
    let list = noteLists.get(key);
    if (!list) noteLists.set(key, (list = []));
    const have = new Set(list);
    let dirty = false;
    for (const cid of cids) {
      if (!have.has(cid)) {
        list.push(cid);
        dirty = true;
      }
    }
    if (dirty) list.sort((a, b) => a - b);
  }
  let pairs = 0;
  postings = new Map();
  for (const [key, list] of noteLists) {
    pairs += list.length;
    postings.set(key, Uint32Array.from(list));
  }
  noteLists.clear(); // release the number[] temporaries before the closing heap measurement

  brandToIds = new Map();
  {
    const lists = new Map();
    for (const e of index) {
      if (suppressed.has(e.i)) continue;
      let list = lists.get(e.b);
      if (!list) lists.set(e.b, (list = []));
      list.push(e.i);
    }
    for (const [brand, list] of lists) brandToIds.set(brand, Uint32Array.from(list));
  }

  const rawStores = JSON.parse(await readFile(path.join(OUT_DIR, 'stores.json'), 'utf8'));
  stores = rawStores.map((s) => {
    const idArray = unionSorted(s.brands.map((b) => brandToIds.get(b)).filter(Boolean));
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      area: s.area,
      as_of: s.as_of,
      brandSet: new Set(s.brands),
      idArray,
      idSet: new Set(idArray),
    };
  });
  storesById = new Map(stores.map((s) => [s.id, s]));

  const meta = JSON.parse(await readFile(path.join(OUT_DIR, 'find_meta.json'), 'utf8'));
  metaLen = meta.length;
  ratingArr = new Float64Array(metaLen).fill(NaN);
  scaleArr = new Uint8Array(metaLen);
  pctArr = new Int16Array(metaLen).fill(-1);
  for (let id = 0; id < metaLen; id++) {
    const m = meta[id];
    if (!m) continue;
    ratingArr[id] = m[0];
    scaleArr[id] = m[1];
    if (m[2] != null) pctArr[id] = m[2];
  }
  meta.length = 0; // ditto: the parsed meta rows are typed-array copies now

  const vocab = JSON.parse(await readFile(path.join(OUT_DIR, 'notes_vocab.json'), 'utf8'));
  noteDisplayByKey = new Map();
  for (const v of vocab) {
    const key = norm(v.note);
    if (!noteDisplayByKey.has(key)) noteDisplayByKey.set(key, v.note);
  }
  // Counts come from the postings (deduplicated perfume counts), not the
  // vocab's tier-double-counting totals — what the typeahead shows must match
  // what filtering returns.
  const noteRows = vocab
    .map((v) => [v.note, postings.get(norm(v.note))?.length ?? 0])
    .filter((row) => row[1] > 0); // notes living only on suppressed rows would be dead typeahead entries
  noteRows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  notesVocabGz = gzipSync(JSON.stringify(noteRows));
  const brandRows = [...brandToIds.entries()].map(([brand, ids]) => [brand, ids.length]);
  brandRows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  brandsVocabGz = gzipSync(JSON.stringify(brandRows));
  vocab.length = noteRows.length = brandRows.length = 0; // ditto: gzipped now

  onPerfumeAdded(indexNewPerfume);
  globalThis.gc?.();
  const mem1 = process.memoryUsage();
  const heapMb = (mem1.heapUsed + mem1.arrayBuffers - heap0) / (1024 * 1024);
  console.log(
    `smell-list: ${postings.size} notes, ${pairs} postings, ${stores.length} stores, ` +
      `built in ${Math.round(performance.now() - t0)}ms, heap ${heapMb >= 0 ? '+' : ''}${heapMb.toFixed(1)}MB`,
  );
}

function appendId(arr, id) {
  if (!arr) return Uint32Array.of(id);
  const next = new Uint32Array(arr.length + 1);
  next.set(arr);
  next[arr.length] = id;
  return next;
}

// Live adds: the new id is appended to postings/brand/store structures but
// never into the rating typed arrays — any id >= metaLen stays unrated for
// both sorting and display. The pre-gzipped vocabs are not rebuilt (accepted
// staleness: queryable immediately, absent from typeaheads until restart).
// New ids are never in dedup.json, so a live-added variant of an existing
// perfume may show as a duplicate card until the next pipeline run (accepted:
// adds are rare, and the jsonl feeds the pipeline, which heals it).
function indexNewPerfume(id, entry) {
  const seen = new Set();
  for (const tier of Object.values(entry.notes)) {
    if (!Array.isArray(tier)) continue;
    for (const note of tier) {
      const key = norm(note);
      if (seen.has(key)) continue;
      seen.add(key);
      postings.set(key, appendId(postings.get(key), id));
      if (!noteDisplayByKey.has(key)) noteDisplayByKey.set(key, note);
    }
  }
  brandToIds.set(entry.brand, appendId(brandToIds.get(entry.brand), id));
  for (const store of stores) {
    if (!store.brandSet.has(entry.brand)) continue;
    store.idArray = appendId(store.idArray, id);
    store.idSet.add(id);
  }
}

export function handleStores(res) {
  sendJson(
    res,
    200,
    stores.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      area: s.area,
      as_of: s.as_of,
      perfumes: s.idArray.length,
    })),
  );
}

function sendVocab(res, gz) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
    'cache-control': 'public, max-age=3600',
  });
  res.end(gz);
}

// Filtered vocab responses vary per filter combination, so they are gzipped
// per request (a few ms over ~500k postings pairs) and cached briefly by URL,
// unlike the boot-time global vocabs.
function sendFilteredVocab(res, rows) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
    'cache-control': 'public, max-age=300',
  });
  res.end(gzipSync(JSON.stringify(rows)));
}

const FILTER_PARAMS = ['store', 'brand', 'avoidBrand', 'want', 'avoid'];
const hasFilters = (q) => FILTER_PARAMS.some((p) => q.has(p));

// With filter params, counts are perfumes matching the filters AND carrying
// the note — "what you'd see if you added this" — zero-count entries dropped
// so the typeahead only offers rows that lead somewhere. Without params, the
// boot-time global vocab.
export function handleNotesVocab(url, res) {
  const q = url.searchParams;
  if (!hasFilters(q)) return sendVocab(res, notesVocabGz);
  const m = matchFilters(q);
  if (m.error) return sendJson(res, m.error[0], { error: m.error[1] });
  const matchedSet = new Set(m.matched);
  const rows = [];
  for (const [key, arr] of postings) {
    let count = 0;
    for (const id of arr) if (matchedSet.has(id)) count++;
    if (!count) continue;
    const display = noteDisplayByKey.get(key);
    if (display) rows.push([display, count]);
  }
  rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  sendFilteredVocab(res, rows);
}

export function handleBrandsVocab(url, res) {
  const q = url.searchParams;
  if (!hasFilters(q)) return sendVocab(res, brandsVocabGz);
  const m = matchFilters(q);
  if (m.error) return sendJson(res, m.error[0], { error: m.error[1] });
  const matchedSet = new Set(m.matched);
  const rows = [];
  for (const [brand, arr] of brandToIds) {
    let count = 0;
    for (const id of arr) if (matchedSet.has(id)) count++;
    if (count) rows.push([brand, count]);
  }
  rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  sendFilteredVocab(res, rows);
}

// Parses the shared filter params (store/brand/avoidBrand/want/avoid) and
// runs the match. Shared by /api/smell-list and the filtered vocab endpoints,
// so the typeahead counts and the result totals can never disagree.
// Returns { error: [status, message] } or { matched, storeId } with matched
// ascending by construction (base arrays are ascending).
function matchFilters(q) {
  const storeId = q.get('store');
  let store = null;
  if (storeId != null) {
    store = storesById.get(storeId);
    if (!store) return { error: [404, `Unknown store: ${storeId}`] };
  }

  const brandNames = [...new Set(q.getAll('brand'))];
  if (brandNames.length > MAX_BRANDS) {
    return { error: [400, `At most ${MAX_BRANDS} brands.`] };
  }
  const brandArrays = [];
  for (const b of brandNames) {
    const ids = brandToIds.get(b);
    if (!ids) return { error: [404, `Unknown brand: ${b}`] };
    brandArrays.push(ids);
  }

  const avoidBrandNames = [...new Set(q.getAll('avoidBrand'))];
  if (avoidBrandNames.length > MAX_BRANDS) {
    return { error: [400, `At most ${MAX_BRANDS} avoided brands.`] };
  }

  const wants = [...new Set(q.getAll('want').map(norm))];
  const avoids = [...new Set(q.getAll('avoid').map(norm))];
  if (wants.length > MAX_NOTES || avoids.length > MAX_NOTES) {
    return { error: [400, `At most ${MAX_NOTES} want/avoid notes.`] };
  }

  // An unknown want note is not an error: its posting list is empty, so the
  // query legitimately matches nothing. Unknown avoids (notes or brands) are
  // no-ops.
  const wantArrays = wants.map((w) => postings.get(w) ?? EMPTY);
  const brandUnion = brandArrays.length ? unionSorted(brandArrays) : null;

  // Base = smallest candidate id list; remaining predicates via Set membership.
  let base = null;
  for (const candidate of [...wantArrays, store?.idArray, brandUnion]) {
    if (candidate && (!base || candidate.length < base.length)) base = candidate;
  }
  const mustSets = [];
  for (const arr of wantArrays) if (arr !== base) mustSets.push(new Set(arr));
  if (store && store.idArray !== base) mustSets.push(store.idSet);
  if (brandUnion && brandUnion !== base) mustSets.push(new Set(brandUnion));
  const avoidSet = new Set();
  for (const a of avoids) for (const id of postings.get(a) ?? EMPTY) avoidSet.add(id);
  for (const b of avoidBrandNames) for (const id of brandToIds.get(b) ?? EMPTY) avoidSet.add(id);

  const index = getSearchIndex();
  const matched = [];
  const passes = (id) => {
    // the no-filter branch below scans raw id space, which boot-time
    // filtering can't reach — suppressed ids must be rejected here
    if (suppressed.has(id)) return false;
    for (const s of mustSets) if (!s.has(id)) return false;
    return !avoidSet.has(id);
  };
  if (base) {
    for (const id of base) if (passes(id)) matched.push(id);
  } else {
    for (let id = 0; id < index.length; id++) if (passes(id)) matched.push(id);
  }
  return { matched, storeId };
}

export async function handleSmellList(url, res) {
  const q = url.searchParams;

  const sort = q.get('sort') ?? 'pop';
  if (!SORTS.has(sort)) return sendJson(res, 400, { error: `Unknown sort: ${sort}` });
  let offset = Number.parseInt(q.get('offset') ?? '0', 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;
  let limit = q.get('limit') == null ? 24 : Number.parseInt(q.get('limit'), 10);
  if (Number.isNaN(limit)) limit = 24;
  limit = Math.min(100, Math.max(1, limit));

  const m = matchFilters(q);
  if (m.error) return sendJson(res, m.error[0], { error: m.error[1] });
  const { matched, storeId } = m;
  const index = getSearchIndex();

  // pop is free: id order == popularity rank (verify.py asserts it). Tiebreak
  // everywhere is id ascending so paging is a stable total order.
  if (sort === 'rating') {
    const pctOf = (id) => (id < metaLen ? pctArr[id] : -1);
    matched.sort((a, b) => pctOf(b) - pctOf(a) || a - b);
  } else if (sort === 'year') {
    const yearOf = (id) => (typeof index[id]?.y === 'number' ? index[id].y : -1);
    matched.sort((a, b) => yearOf(b) - yearOf(a) || a - b);
  }

  const pageIds = matched.slice(offset, offset + limit);
  // Lazy hydration of just this page; data.js's shard promise cache collapses
  // the reads to one per distinct shard.
  const entries = await Promise.all(pageIds.map((id) => getPerfume(id)));
  const results = [];
  for (let k = 0; k < pageIds.length; k++) {
    const id = pageIds[k];
    const entry = entries[k];
    if (!entry) continue;
    let img = imageUrl(id);
    if (!img && entry.fid != null) {
      // fid-sourced: one cheap CDN JPEG, warm it and hand out the URL it will
      // resolve to. url-source entries are NEVER warmed from here (each is a
      // full page scrape; browse pages must not trigger scraping storms).
      img = `/img/${id}`;
      cacheImage(id, entry);
    }
    const rated = id < metaLen && pctArr[id] >= 0; // the ratingCount >= 5 honesty gate
    results.push({
      id,
      name: entry.name,
      brand: entry.brand,
      year: typeof index[id]?.y === 'number' ? index[id].y : null,
      structure: entry.structure,
      notes: entry.notes,
      img,
      rating: rated ? { v: ratingArr[id], of: scaleArr[id] } : null,
    });
  }

  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
  });
  res.end(gzipSync(JSON.stringify({ total: matched.length, offset, limit, sort, store: storeId ?? null, results })));
}
