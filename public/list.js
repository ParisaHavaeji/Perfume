// SMELL LIST client: store/brand/note filters over the whole dataset, ranked
// sniff cards in the game's reveal layout, and a persistent smelled checklist.
// The server (/api/smell-list) is authoritative for totals and ordering; this
// file owns filter state, the URL round-trip, and last-good offline caching.
'use strict';

// iOS Safari auto-zooms any focused input under 16px, and ours are 10px by
// design. Capping the viewport scale suppresses only that auto-zoom on iOS —
// pinch still works there (ignored for gestures since iOS 10). Android honors
// the cap for pinch too, so it stays off everywhere else; see list.html.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) /* iPadOS reports as Mac */) {
  document.querySelector('meta[name="viewport"]')
    .setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.trim().toLowerCase(); // mirrors server/data.js norm
const el = (id) => document.getElementById(id);

const KINDS = [['chain', 'Department'], ['boutique', 'Niche'], ['flagship', 'Flagship']];
const KIND_LABEL = new Map(KINDS);
const SORTS = [['pop', 'most popular'], ['rating', 'best rated'], ['year', 'newest']];
// The three finder fields: each owns its own search box, typeahead dropdown,
// and chip row. Location is a single-select (F.store); I like / I avoid are
// tag lists mixing notes and brands.
const FIELDS = {
  location: { input: 'search-location', ta: 'ta-location' },
  want: { input: 'search-want', ta: 'ta-want' },
  avoid: { input: 'search-avoid', ta: 'ta-avoid' },
};
const MAX_BRANDS = 6; // mirrors server/smelllist.js caps
const MAX_NOTES = 12;
const PAGE = 24;
// Curated browse-mode suggestions (empty search box). Names must match the
// dataset exactly; anything the vocab doesn't know is skipped silently.
const DEFAULT_AVOID_NOTES = ['Patchouli', 'Gourmand notes', 'Oud (Agarwood)'];
const DEFAULT_WANT_BRANDS = ['Amouage', 'Serge Lutens', 'Xerjoff'];
const DEFAULT_AVOID_BRANDS = ['Tom Ford', 'Versace', 'Paco Rabanne'];

// ---- persistent state -------------------------------------------------------

const SMELLED_KEY = 'st:smelled:v1'; // {[id]: timestamp} — global, not per store
const CACHE = {
  stores: 'st:cache:v1:stores',
  notes: 'st:cache:v1:notes-vocab',
  brands: 'st:cache:v1:brands-vocab',
  list: 'st:cache:v1:smell-list',
};
function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function cachePut(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked — caching is best-effort */ }
}
let smelled = cacheGet(SMELLED_KEY) ?? {};

// ---- filter + result state --------------------------------------------------

// wantMode: how the I like list combines — 'and' (every one) or 'or' (any
// one). Never mixed, so it is one flag for the whole field, not per chip.
const F = { store: null, brands: [], avoidBrands: [], wants: [], avoids: [], wantMode: 'and', sort: 'pop', hideSmelled: false };
let stores = [];
let notesVocab = []; // [[display name, perfume count]] count desc, from the server
let brandsVocab = [];
let storeById = new Map();
let noteByNorm = new Map(); // norm(name) -> display name, for URL validation
let noteCountByNorm = new Map(); // norm(name) -> perfume count, for curated defaults
let brandCount = new Map(); // brand -> perfume count, ditto
let results = [];
let total = null; // null until the first response
let fromCache = false;
let loading = false;
let surpriseResult = null;

// ---- network ----------------------------------------------------------------

/** GET url as JSON, falling back to the last good localStorage copy offline. */
async function getJson(url, cacheKey) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    cachePut(cacheKey, data);
    return { data, cached: false };
  } catch (err) {
    const data = cacheGet(cacheKey);
    if (data) return { data, cached: true };
    throw err;
  }
}

function filterParams() {
  const p = new URLSearchParams();
  if (F.store) p.append('store', F.store);
  for (const b of F.brands) p.append('brand', b);
  for (const b of F.avoidBrands) p.append('avoidBrand', b);
  for (const w of F.wants) p.append('want', w);
  for (const a of F.avoids) p.append('avoid', a);
  // With one liked thing and/or mean the same query, so the mode only rides
  // along once it changes the result — keeps shared URLs clean.
  if (F.wantMode === 'or' && F.wants.length + F.brands.length > 1) p.append('wantMode', 'or');
  return p;
}

function queryParams(offset, limit) {
  const p = filterParams();
  if (F.sort !== 'pop') p.append('sort', F.sort);
  p.append('offset', String(offset));
  p.append('limit', String(limit));
  return p;
}

let controller = null;
let queryTimer = null;

// Filter changes debounce heavier than the game's typeahead (these are network
// calls); the AbortController kills any in-flight response a newer one obsoletes.
function scheduleQuery() {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => runQuery(false), 250);
}

async function runQuery(append) {
  controller?.abort();
  const mine = (controller = new AbortController());
  const offset = append ? results.length : 0;
  loading = true;
  try {
    const res = await fetch(`/api/smell-list?${queryParams(offset, PAGE)}`, { signal: mine.signal });
    const body = await res.json();
    if (mine !== controller) return; // superseded while the body was parsing
    loading = false;
    if (!res.ok) return toast(body.error || 'Could not load results.');
    fromCache = false;
    total = body.total;
    results = append ? results.concat(body.results) : body.results;
    if (!append) {
      surpriseResult = null;
      cachePut(CACHE.list, body);
    }
    renderResults();
  } catch (err) {
    if (err.name === 'AbortError') return;
    loading = false;
    const cached = !append && cacheGet(CACHE.list);
    if (cached) {
      // Offline: render the last good page under the CACHED RESULTS banner.
      fromCache = true;
      total = cached.total;
      results = cached.results;
      surpriseResult = null;
      renderResults();
    } else {
      toast('Offline — could not load results.');
    }
  }
}

// ---- URL round-trip ---------------------------------------------------------

function syncUrl() {
  const p = filterParams();
  if (F.sort !== 'pop') p.append('sort', F.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `/list?${qs}` : '/list');
}

// ---- rendering: controls ----------------------------------------------------

function chip(kind, v, label) {
  return `<button type="button" class="chip" data-rm="${kind}" data-v="${esc(v)}">${label ?? esc(v)}</button>`;
}

function locationChipHtml() {
  const s = F.store && storeById.get(F.store);
  if (!s) return '';
  return chip('store', s.id, `${esc(s.name)} <span class="area">${esc(s.area)}</span>`);
}

// One chosen filter per line, joined by the word that says how they combine —
// MUSK / OR APPLE / OR PATCHOULI. The joiner leads the line it applies to, so
// the first has none. On I like it is a button (flips the whole list between
// AND and OR); on I avoid it is plain text, since avoiding two things always
// means avoiding both.
function chipLines(rows, joiner, clickable) {
  return rows
    .map(([kind, v], i) => {
      const j = i === 0 ? '' : clickable
        ? `<button type="button" class="conj" data-want-mode title="Switch to ${joiner === 'AND' ? 'OR' : 'AND'}">${joiner}</button>`
        : `<span class="conj">${joiner}</span>`;
      return `<div class="chip-line">${j}${chip(kind, v)}</div>`;
    })
    .join('');
}

function wantChipsHtml() {
  const rows = [
    ...F.wants.map((w) => ['want', w]),
    ...F.brands.map((b) => ['brand', b]),
  ];
  return chipLines(rows, F.wantMode === 'or' ? 'OR' : 'AND', true);
}

function avoidChipsHtml() {
  const rows = [
    ...F.avoids.map((a) => ['avoid', a]),
    ...F.avoidBrands.map((b) => ['avoidBrand', b]),
  ];
  return chipLines(rows, 'AND', false);
}

function chipsHtml() {
  return locationChipHtml() + wantChipsHtml() + avoidChipsHtml();
}

// A fourth pseudo-field matching Location / I like / I avoid: the "Sort"
// label, then the underlined match count — either opens a dropdown holding
// the three sort options (current one inverted) plus the hide-smelled
// toggle, off by default since smelled perfumes show by default. The
// countline's smelled clause only appears once it can do something (or is
// already on).
function renderCount() {
  if (total == null) return void (el('count').textContent = '');
  const n = results.filter((r) => smelled[r.id]).length;
  const smelledPart = n || F.hideSmelled
    ? `, <button type="button" class="lnk" data-hide-smelled aria-pressed="${String(F.hideSmelled)}">${F.hideSmelled ? 'hiding' : 'showing'}</button> ${n} smelled`
    : '';
  el('count').innerHTML =
    `<button type="button" class="finder-label sort-open" data-sort-open aria-expanded="false" title="Change sort">Sort</button>` +
    `<span class="sort-val">` +
    `<button type="button" class="lnk" data-sort-open aria-expanded="false" title="Change sort">${total}</button>${smelledPart}</span>` +
    `<div class="results ta-results sort-menu" hidden>` +
    SORTS.map(([v, label]) =>
      `<button type="button" class="ta-row" data-sort="${v}" aria-pressed="${String(v === F.sort)}"><span class="ta-name">${label}</span></button>`).join('') +
    `<button type="button" class="ta-row" data-hide-smelled aria-pressed="${String(F.hideSmelled)}"><span class="ta-name">hide smelled</span></button>` +
    `</div>`;
}

// Re-rendering always closes the menu (it's built hidden), so open state
// never needs syncing beyond these two.
function setSortMenu(open) {
  const menu = el('count').querySelector('.sort-menu');
  if (!menu) return;
  menu.hidden = !open;
  for (const b of el('count').querySelectorAll('[data-sort-open]')) b.setAttribute('aria-expanded', String(open));
}
function toggleSortMenu() {
  const menu = el('count').querySelector('.sort-menu');
  if (menu) setSortMenu(menu.hidden);
}

function renderControls() {
  el('chips-location').innerHTML = locationChipHtml();
  el('chips-want').innerHTML = wantChipsHtml();
  el('chips-avoid').innerHTML = avoidChipsHtml();
  // The bracket line down the left of I like / I avoid only exists while the
  // field holds something to bracket.
  for (const field of ['want', 'avoid']) {
    const wrap = el(FIELDS[field].input).closest('.finder-field');
    wrap.classList.toggle('grouped', el(`chips-${field}`).childElementCount > 0);
  }
  renderCount();
}

// ---- rendering: cards -------------------------------------------------------

function cardHtml(r, big) {
  const isSm = Boolean(smelled[r.id]);
  const wantSet = new Set(F.wants.map(norm));
  const run = [];
  for (const [tier, arr] of Object.entries(r.notes ?? {})) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const chips = arr.map((n) => `<span class="nchip${wantSet.has(norm(n)) ? '' : ' dim'}">${esc(n)}</span>`).join('');
    run.push(`<div class="nrun-row">${tier !== 'flat' ? `<span class="tmark">${esc(tier)}</span>` : ''}<div class="nrow-notes">${chips}</div></div>`);
  }
  const rating = r.rating ? `${r.rating.v.toFixed(1)}/${r.rating.of}` : '';
  const meta = [r.year, rating].filter(Boolean).join(' · ');
  const initial = String(r.brand || '?').trim()[0] ?? '?';
  return `<article class="card${isSm ? ' smelled' : ''}" data-id="${r.id}">
      <div class="card-bottle${big ? ' big' : ''}">
        <span class="ph" aria-hidden="true">${esc(initial)}</span>
        ${r.img ? `<img loading="lazy" decoding="async" src="${esc(r.img)}" alt="" />` : ''}
      </div>
      <h2 class="card-name reveal-name">${esc(r.name)} — ${esc(r.brand)}</h2>
      ${meta ? `<p class="card-meta">${meta}</p>` : ''}
      <div class="nrun">${run.join('')}</div>
      <button type="button" class="tog" data-smell="${r.id}" aria-pressed="${String(isSm)}">${isSm ? 'Smelled' : 'Smell'}</button>
    </article>`;
}

function renderSurpriseSlot() {
  el('surprise-slot').innerHTML = surpriseResult
    ? `<div class="surprise-wrap">${cardHtml(surpriseResult, true)}
       <button type="button" class="x" id="surprise-close" aria-label="Dismiss surprise">×</button></div>`
    : '';
}

function renderResults() {
  const cards = el('cards');
  cards.classList.toggle('hide-smelled', F.hideSmelled);
  cards.innerHTML = results.map((r) => cardHtml(r, false)).join('');
  renderSurpriseSlot();
  el('banner').hidden = !fromCache;
  const empty = total === 0 && !loading;
  el('empty').hidden = !empty;
  el('empty').innerHTML = empty
    ? `${chipsHtml() ? `<div class="filter-chips">${chipsHtml()}</div>` : ''}
       <p>Nothing here matches — loosen a filter</p>`
    : '';
  el('more').hidden = fromCache || total == null || results.length >= total;
  el('surprise').disabled = fromCache || !total;
  renderCount();
}

// ---- filter mutations -------------------------------------------------------

function filtersChanged() {
  syncUrl();
  renderControls();
  scheduleQuery();
  refreshScopedVocabs();
}

function clearSearch(field) {
  const input = el(FIELDS[field].input);
  const box = el(FIELDS[field].ta);
  clearTimeout(taTimers[field]);
  input.value = '';
  input.blur(); // pick is done — also dismisses the keyboard on touch
  box.hidden = true;
  box.innerHTML = '';
}

function selectStore(id) {
  F.store = id;
  clearSearch('location');
  filtersChanged();
}

// mode is only meaningful for want ('and' | 'or'); picking a row body passes
// the mode already in force, the AND / OR words pass the one they name.
function addNote(kind, name, mode) {
  if (kind === 'want' && mode) F.wantMode = mode;
  const key = norm(name);
  const mine = kind === 'want' ? F.wants : F.avoids;
  const other = kind === 'want' ? F.avoids : F.wants;
  const oi = other.findIndex((x) => norm(x) === key); // want vs avoid is exclusive
  if (oi >= 0) other.splice(oi, 1);
  if (!mine.some((x) => norm(x) === key)) {
    if (mine.length >= MAX_NOTES) return toast(`At most ${MAX_NOTES} ${kind === 'want' ? 'wanted' : 'avoided'} notes.`);
    mine.push(name);
  }
  clearSearch(kind);
  filtersChanged();
}

function addBrand(kind, name, mode) {
  if (kind === 'want' && mode) F.wantMode = mode;
  const mine = kind === 'want' ? F.brands : F.avoidBrands;
  const other = kind === 'want' ? F.avoidBrands : F.brands;
  const oi = other.indexOf(name); // like vs avoid is exclusive, same as notes
  if (oi >= 0) other.splice(oi, 1);
  if (!mine.includes(name)) {
    if (mine.length >= MAX_BRANDS) return toast(`At most ${MAX_BRANDS} ${kind === 'want' ? 'liked' : 'avoided'} brands.`);
    mine.push(name);
  }
  clearSearch(kind);
  filtersChanged();
}

function removeFilter(kind, value) {
  if (kind === 'store') {
    F.store = null;
    return filtersChanged();
  }
  const list = { want: F.wants, avoid: F.avoids, brand: F.brands, avoidBrand: F.avoidBrands }[kind];
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  if (!F.wants.length && !F.brands.length) F.wantMode = 'and'; // emptied — back to the default
  filtersChanged();
}

function toggleSmelled(id) {
  if (smelled[id]) delete smelled[id];
  else smelled[id] = Date.now();
  cachePut(SMELLED_KEY, smelled);
  const isSm = Boolean(smelled[id]);
  for (const card of document.querySelectorAll(`.card[data-id="${id}"]`)) {
    card.classList.toggle('smelled', isSm);
    const btn = card.querySelector('[data-smell]');
    btn.setAttribute('aria-pressed', String(isSm));
    btn.textContent = isSm ? 'Smelled' : 'Smell';
  }
  renderCount();
}

// ---- surprise me ------------------------------------------------------------

async function surprise() {
  if (!total) return;
  const btn = el('surprise');
  btn.disabled = true;
  try {
    let draw = null;
    const rolls = F.hideSmelled ? 4 : 1; // one draw + up to 3 re-rolls past smelled
    for (let i = 0; i < rolls; i++) {
      const res = await fetch(`/api/smell-list?${queryParams(Math.floor(Math.random() * total), 1)}`);
      if (!res.ok) throw new Error();
      const body = await res.json();
      draw = body.results[0] ?? draw;
      if (draw && !smelled[draw.id]) break;
    }
    if (draw) {
      surpriseResult = draw;
      renderSurpriseSlot();
      el('surprise-slot').scrollIntoView({ block: 'nearest' });
    }
  } catch {
    toast('Could not draw a surprise — are you offline?');
  } finally {
    btn.disabled = fromCache || !total;
  }
}

// ---- typeahead --------------------------------------------------------------

// Scoped vocabs: with any filter active, the server recounts every note/brand
// within the filtered set (store=Le Labo → Bergamot's count is Le Labo's
// bergamots, zero-count rows dropped). Null = no filters or offline, fall back
// to the global vocabs. One fetch pair per filter change, not per keystroke.
let scopedNotesVocab = null; // [[display name, count]] count desc, like notesVocab
let scopedBrandsVocab = null;
let scopedNoteCountByNorm = null;
let scopedBrandCount = null;

let vocabController = null;
async function refreshScopedVocabs() {
  vocabController?.abort();
  const p = filterParams();
  if (![...p.keys()].length) {
    scopedNotesVocab = scopedBrandsVocab = scopedNoteCountByNorm = scopedBrandCount = null;
    return rerenderOpenTypeaheads();
  }
  const mine = (vocabController = new AbortController());
  try {
    const [n, b] = await Promise.all([
      fetch(`/api/notes-vocab?${p}`, { signal: mine.signal }).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/brands-vocab?${p}`, { signal: mine.signal }).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (mine !== vocabController) return;
    scopedNotesVocab = n;
    scopedBrandsVocab = b;
    scopedNoteCountByNorm = n && new Map(n.map(([name, count]) => [norm(name), count]));
    scopedBrandCount = b && new Map(b);
    rerenderOpenTypeaheads();
  } catch { /* aborted or offline — global counts stand in */ }
}

function rerenderOpenTypeaheads() {
  for (const field of Object.keys(FIELDS)) {
    if (!el(FIELDS[field].ta).hidden) renderTypeahead(field);
  }
}

// Each field's box searches client-side — no network per keystroke. Vocabs
// arrive count-desc from the server, so an empty query just shows the top N
// (browse mode); a query filters that same order down by substring match.
function taRow(attr, name, count) {
  return `<button type="button" class="ta-row" ${attr}>
      <span class="ta-name">${esc(name)}</span><span class="ta-count">${count}</span>
    </button>`;
}

// I like rows, once the field already holds something: the same row, plus the
// two joiners on the right. Clicking the row itself keeps whichever mode is in
// force (AND until told otherwise); the words pick one explicitly and re-join
// the whole list, since AND and OR are never mixed.
function taRowConj(attr, name, count) {
  const word = (mode) =>
    `<button type="button" class="conj" ${attr}-${mode}="${esc(name)}" aria-pressed="${String(F.wantMode === mode)}"
       title="Match ${mode === 'and' ? 'every' : 'any'} liked note or brand">${mode}</button>`;
  return `<div class="ta-row ta-row-conj">
      <button type="button" class="ta-pick" ${attr}="${esc(name)}">
        <span class="ta-name">${esc(name)}</span><span class="ta-count">${count}</span>
      </button>${word('and')}${word('or')}
    </div>`;
}

// Rows sit under the LA Stores / Flagship Stores headers, so the name alone
// is enough — no address or kind subtext.
function storeRow(s) {
  return `<button type="button" class="ta-row" data-select-store="${esc(s.id)}">
      <span class="ta-name">${esc(s.name)}</span>
      <span class="ta-count">${s.perfumes ?? ''}</span>
    </button>`;
}

function renderTypeahead(field) {
  const box = el(FIELDS[field].ta);
  const input = el(FIELDS[field].input);
  const t = norm(input.value);

  let html = '';
  if (field === 'location') {
    // Grouped like the note/brand dropdowns: multi-brand LA shops first, then
    // single-brand flagships. Area and kind still match a typed query even
    // though the rows no longer display them.
    const match = (s) => !t || norm(`${s.name} ${s.area} ${KIND_LABEL.get(s.kind) ?? s.kind}`).includes(t);
    const list = stores.filter(match).slice(0, 12);
    const laStores = list.filter((s) => s.kind !== 'flagship');
    const flagships = list.filter((s) => s.kind === 'flagship');
    if (laStores.length) html += '<div class="ta-head">LA Stores</div>' + laStores.map(storeRow).join('');
    if (flagships.length) html += '<div class="ta-head">Flagship Stores</div>' + flagships.map(storeRow).join('');
    if (!html) html = '<p class="sub no-results">No matching stores.</p>';
  } else {
    // I like / I avoid share one shape: notes then brands. Browse mode (empty
    // box) shows curated defaults — top notes for I like, the classic
    // love-or-hate notes for I avoid, niche picks vs designer staples for
    // brands; a typed query gets the deeper search caps over the full vocabs.
    // At a flagship the whole store is one brand, so brand filters can only be
    // redundant or empty — the Brands section disappears entirely.
    const flagship = F.store != null && storeById.get(F.store)?.kind === 'flagship';
    const nVocab = scopedNotesVocab ?? notesVocab;
    const bVocab = scopedBrandsVocab ?? brandsVocab;
    const nCount = scopedNoteCountByNorm ?? noteCountByNorm;
    const bCount = scopedBrandCount ?? brandCount;
    // Suggestions never repeat something already chosen (either side — want
    // vs avoid is exclusive anyway), and browse mode always pads back up to
    // the cap from the vocab's top, so picking a suggestion surfaces the next
    // one instead of shrinking the list toward empty. Curated picks recount
    // under the scoped vocab; ones absent from the scope (count 0) drop out
    // rather than promising an empty result.
    const noteCap = 8;
    const brandCap = t ? 5 : 3;
    const chosenNotes = new Set([...F.wants, ...F.avoids].map(norm));
    const chosenBrands = new Set([...F.brands, ...F.avoidBrands]);
    const notes = [];
    const seenNotes = new Set();
    const pushNote = (name, count) => {
      const key = norm(name);
      if (!count || seenNotes.has(key) || chosenNotes.has(key)) return;
      seenNotes.add(key);
      notes.push([name, count]);
    };
    if (!t && field === 'avoid') {
      for (const name of DEFAULT_AVOID_NOTES) pushNote(name, nCount.get(norm(name)));
    }
    for (const [name, count] of nVocab) {
      if (notes.length >= noteCap) break;
      if (t && !norm(name).includes(t)) continue;
      pushNote(name, count);
    }
    const brands = [];
    const seenBrands = new Set();
    const pushBrand = (name, count) => {
      if (!count || seenBrands.has(name) || chosenBrands.has(name)) return;
      seenBrands.add(name);
      brands.push([name, count]);
    };
    if (!flagship) {
      if (!t) {
        for (const name of field === 'want' ? DEFAULT_WANT_BRANDS : DEFAULT_AVOID_BRANDS) pushBrand(name, bCount.get(name));
      }
      for (const [name, count] of bVocab) {
        if (brands.length >= brandCap) break;
        if (t && !norm(name).includes(t)) continue;
        pushBrand(name, count);
      }
    }
    const noteAttr = field === 'want' ? 'data-want' : 'data-avoid';
    const brandAttr = field === 'want' ? 'data-brand' : 'data-avoid-brand';
    // The and/or choice only exists from the second pick on — with an empty I
    // like list there is nothing to join it to.
    const conj = field === 'want' && F.wants.length + F.brands.length > 0;
    const row = (attr, name, count) => (conj ? taRowConj(attr, name, count) : taRow(`${attr}="${esc(name)}"`, name, count));
    if (notes.length) html += '<div class="ta-head">Notes</div>' + notes.map(([n, c]) => row(noteAttr, n, c)).join('');
    if (brands.length) html += '<div class="ta-head">Brands</div>' + brands.map(([b, c]) => row(brandAttr, b, c)).join('');
    if (!html) html = '<p class="sub no-results">No matching notes or brands.</p>';
  }
  box.hidden = false;
  box.innerHTML = html;
}

// ---- events -----------------------------------------------------------------

const taTimers = {};
for (const field of Object.keys(FIELDS)) {
  const input = el(FIELDS[field].input);
  const ta = el(FIELDS[field].ta);
  const wrap = input.closest('.finder-field');
  input.addEventListener('input', () => {
    clearTimeout(taTimers[field]);
    taTimers[field] = setTimeout(() => renderTypeahead(field), 120); // client-side only; game's debounce
  });
  input.addEventListener('focus', () => renderTypeahead(field)); // empty focus = browse the top picks
  // Pressing a result must not blur the input mid-click — the focusout would
  // hide the dropdown before the click lands on the row. The pick handler
  // closes it itself afterwards (clearSearch). Mousedown on the box itself is
  // the scrollbar; that one must keep its default.
  ta.addEventListener('mousedown', (e) => {
    if (e.target !== ta) e.preventDefault();
  });
  wrap.addEventListener('focusout', (e) => {
    if (wrap.contains(e.relatedTarget)) return; // still inside (e.g. tabbed into the dropdown)
    ta.hidden = true;
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ta.hidden = true;
  });
}
// Touch never blurs the input reliably — a tap anywhere outside a field closes
// whichever dropdown is open. Same deal for the sort menu, which has no input
// to blur at all.
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.countline')) setSortMenu(false);
  if (e.target.closest('.finder-field')) return;
  for (const f of Object.values(FIELDS)) el(f.ta).hidden = true;
});
el('count').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSortMenu(false);
});

el('page').addEventListener('click', (e) => {
  let hit;
  if ((hit = e.target.closest('[data-select-store]'))) return selectStore(hit.dataset.selectStore);
  // The -and / -or variants come first: they are distinct attributes, but a
  // stray reorder here would have the row body swallow the joiner clicks.
  if ((hit = e.target.closest('[data-want-and]'))) return addNote('want', hit.dataset.wantAnd, 'and');
  if ((hit = e.target.closest('[data-want-or]'))) return addNote('want', hit.dataset.wantOr, 'or');
  if ((hit = e.target.closest('[data-brand-and]'))) return addBrand('want', hit.dataset.brandAnd, 'and');
  if ((hit = e.target.closest('[data-brand-or]'))) return addBrand('want', hit.dataset.brandOr, 'or');
  if ((hit = e.target.closest('[data-want]'))) return addNote('want', hit.dataset.want, F.wantMode);
  if ((hit = e.target.closest('[data-avoid-brand]'))) return addBrand('avoid', hit.dataset.avoidBrand);
  if ((hit = e.target.closest('[data-avoid]'))) return addNote('avoid', hit.dataset.avoid);
  if ((hit = e.target.closest('[data-brand]'))) return addBrand('want', hit.dataset.brand, F.wantMode);
  if (e.target.closest('[data-want-mode]')) {
    F.wantMode = F.wantMode === 'or' ? 'and' : 'or'; // the joiner in the chip list is the undo
    return filtersChanged();
  }
  if ((hit = e.target.closest('[data-rm]'))) return removeFilter(hit.dataset.rm, hit.dataset.v);
  if ((hit = e.target.closest('[data-smell]'))) return toggleSmelled(Number(hit.dataset.smell));
  if ((hit = e.target.closest('[data-sort]'))) {
    F.sort = hit.dataset.sort;
    return filtersChanged(); // re-render rebuilds the countline, closing the menu
  }
  if (e.target.closest('[data-sort-open]')) return toggleSortMenu();
  if (e.target.closest('[data-hide-smelled]')) {
    F.hideSmelled = !F.hideSmelled;
    return renderResults(); // client-side collapse; server total untouched — renderCount reflips the word
  }
  if (e.target.closest('#more')) return void runQuery(true);
  if (e.target.closest('#surprise')) return void surprise();
  if (e.target.closest('#surprise-close')) {
    surpriseResult = null;
    return renderSurpriseSlot();
  }
});

// Image load/error don't bubble — capture them at the page root. Every image
// sits in a reserved 3:4 box over a placeholder, so late arrivals never shift
// layout; a failed load gets exactly one ~4s retry (catches just-warmed
// thumbnails), then the placeholder stays.
el('page').addEventListener('load', (e) => {
  if (e.target.tagName === 'IMG') e.target.classList.add('ok');
}, true);
el('page').addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  img.classList.remove('ok');
  if (img.dataset.retried) return;
  img.dataset.retried = '1';
  const src = img.getAttribute('src');
  setTimeout(() => {
    if (!img.isConnected) return;
    img.removeAttribute('src'); // re-request the same URL
    img.src = src;
  }, 4000);
}, true);

// ---- boot -------------------------------------------------------------------

(async function boot() {
  const params = new URLSearchParams(location.search);
  const raw = {
    store: params.get('store'),
    brands: params.getAll('brand'),
    avoidBrands: params.getAll('avoidBrand'),
    wants: params.getAll('want'),
    avoids: params.getAll('avoid'),
    wantMode: params.get('wantMode'),
    sort: params.get('sort'),
  };

  try {
    const [s, n, b] = await Promise.all([
      getJson('/api/stores', CACHE.stores),
      getJson('/api/notes-vocab', CACHE.notes),
      getJson('/api/brands-vocab', CACHE.brands),
    ]);
    stores = s.data;
    notesVocab = n.data;
    brandsVocab = b.data;
  } catch {
    // First visit, offline: nothing cached to build from — say so, never blank.
    el('empty').hidden = false;
    el('empty').innerHTML = '<p>Offline and nothing cached yet — reconnect and reload.</p>';
    return;
  }
  storeById = new Map(stores.map((s) => [s.id, s]));
  noteByNorm = new Map();
  noteCountByNorm = new Map();
  for (const [name, count] of notesVocab) {
    noteByNorm.set(norm(name), name);
    noteCountByNorm.set(norm(name), count);
  }
  brandCount = new Map(brandsVocab);
  const brandSet = new Set(brandCount.keys());

  // Validate shared-link params client-side: drop unknowns with a toast instead
  // of letting the server 404 the whole page. Duplicates and over-cap extras
  // drop silently — they aren't unknown, just redundant.
  const dropped = [];
  if (raw.store != null) {
    if (storeById.has(raw.store)) F.store = raw.store;
    else dropped.push(raw.store);
  }
  for (const b of raw.brands) {
    if (!brandSet.has(b)) { dropped.push(b); continue; }
    if (F.brands.length < MAX_BRANDS && !F.brands.includes(b)) F.brands.push(b);
  }
  for (const b of raw.avoidBrands) {
    if (!brandSet.has(b)) { dropped.push(b); continue; }
    if (F.avoidBrands.length < MAX_BRANDS && !F.avoidBrands.includes(b) && !F.brands.includes(b)) F.avoidBrands.push(b);
  }
  for (const w of raw.wants) {
    const display = noteByNorm.get(norm(w));
    if (!display) { dropped.push(w); continue; }
    if (F.wants.length < MAX_NOTES && !F.wants.includes(display)) F.wants.push(display);
  }
  for (const a of raw.avoids) {
    const display = noteByNorm.get(norm(a));
    if (!display) { dropped.push(a); continue; }
    if (F.avoids.length < MAX_NOTES && !F.avoids.includes(display) && !F.wants.includes(display)) F.avoids.push(display);
  }
  if (raw.wantMode != null) {
    if (raw.wantMode === 'and' || raw.wantMode === 'or') F.wantMode = raw.wantMode;
    else dropped.push(raw.wantMode);
  }
  if (raw.sort != null) {
    if (SORTS.some(([v]) => v === raw.sort)) F.sort = raw.sort;
    else dropped.push(raw.sort);
  }
  if (dropped.length) toast(`Removed unknown filter: ${dropped.join(', ')}`);

  syncUrl();
  renderControls();
  runQuery(false);
  refreshScopedVocabs();
})();
