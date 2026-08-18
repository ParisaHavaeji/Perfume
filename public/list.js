// SMELL LIST client: store/brand/note filters over the whole dataset, ranked
// sniff cards in the game's reveal layout, and a persistent smelled checklist.
// The server (/api/smell-list) is authoritative for totals and ordering; this
// file owns filter state, the URL round-trip, and last-good offline caching.
'use strict';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.trim().toLowerCase(); // mirrors server/data.js norm
const el = (id) => document.getElementById(id);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KINDS = [['chain', 'Department'], ['boutique', 'Niche'], ['flagship', 'Flagship']];
const KIND_LABEL = new Map(KINDS);
const SORTS = [['pop', 'Popular'], ['rating', 'Rating'], ['year', 'New']];
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

const F = { store: null, brands: [], avoidBrands: [], wants: [], avoids: [], sort: 'pop', hideSmelled: false };
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

function queryParams(offset, limit) {
  const p = new URLSearchParams();
  if (F.store) p.append('store', F.store);
  for (const b of F.brands) p.append('brand', b);
  for (const b of F.avoidBrands) p.append('avoidBrand', b);
  for (const w of F.wants) p.append('want', w);
  for (const a of F.avoids) p.append('avoid', a);
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
  const p = new URLSearchParams();
  if (F.store) p.append('store', F.store);
  for (const b of F.brands) p.append('brand', b);
  for (const b of F.avoidBrands) p.append('avoidBrand', b);
  for (const w of F.wants) p.append('want', w);
  for (const a of F.avoids) p.append('avoid', a);
  if (F.sort !== 'pop') p.append('sort', F.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `/list?${qs}` : '/list');
}

// ---- rendering: controls ----------------------------------------------------

function fmtAsOf(v) {
  const [y, m] = String(v).split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

function renderHonesty() {
  const s = F.store ? storeById.get(F.store) : null;
  const h = el('honesty');
  h.hidden = !s; // nothing under ANYWHERE — nothing is scoped
  if (!s) return;
  h.textContent = s.kind === 'flagship'
    ? `Flagship — full ${s.name} line, not live stock`
    : `Carried brands, ${fmtAsOf(s.as_of)} — not live stock`;
}

function chip(kind, v, label) {
  return `<button type="button" class="chip" data-rm="${kind}" data-v="${esc(v)}">${label ?? esc(v)}</button>`;
}

function locationChipHtml() {
  const s = F.store && storeById.get(F.store);
  if (!s) return '';
  return chip('store', s.id, `${esc(s.name)} <span class="area">${esc(s.area)}</span>`);
}

function wantChipsHtml() {
  return [
    ...F.wants.map((w) => chip('want', w)),
    ...F.brands.map((b) => chip('brand', b)),
  ].join('');
}

function avoidChipsHtml() {
  return [
    ...F.avoids.map((a) => chip('avoid', a)),
    ...F.avoidBrands.map((b) => chip('avoidBrand', b)),
  ].join('');
}

function chipsHtml() {
  return locationChipHtml() + wantChipsHtml() + avoidChipsHtml();
}

function renderSort() {
  el('sort').innerHTML = SORTS
    .map(([v, label]) => `<button type="button" data-sort="${v}" class="${F.sort === v ? 'on' : ''}">${label}</button>`)
    .join('<span class="sep">/</span>');
  el('hide-smelled').setAttribute('aria-pressed', String(F.hideSmelled));
}

function renderCount() {
  if (total == null) return void (el('count').textContent = '');
  const n = results.filter((r) => smelled[r.id]).length;
  el('count').innerHTML =
    `${total} perfume${total === 1 ? '' : 's'}${n ? ` <span class="smelled-n">· ${n} smelled</span>` : ''}`;
}

function renderControls() {
  renderHonesty();
  el('chips-location').innerHTML = locationChipHtml();
  el('chips-want').innerHTML = wantChipsHtml();
  el('chips-avoid').innerHTML = avoidChipsHtml();
  renderSort();
}

// ---- rendering: cards -------------------------------------------------------

function cardHtml(r, big) {
  const isSm = Boolean(smelled[r.id]);
  const wantSet = new Set(F.wants.map(norm));
  const run = [];
  for (const [tier, arr] of Object.entries(r.notes ?? {})) {
    if (!Array.isArray(arr) || !arr.length) continue;
    if (tier !== 'flat') run.push(`<span class="tmark">${esc(tier)} ·</span>`);
    for (const n of arr) run.push(`<span class="nchip${wantSet.has(norm(n)) ? '' : ' dim'}">${esc(n)}</span>`);
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
}

function clearSearch(field) {
  const input = el(FIELDS[field].input);
  clearTimeout(taTimers[field]);
  input.value = '';
  input.focus(); // keeps the field ready for the next pick
  renderTypeahead(field); // back to browse mode for the follow-up pick
}

function selectStore(id) {
  F.store = id;
  clearSearch('location');
  filtersChanged();
}

function addNote(kind, name) {
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

function addBrand(kind, name) {
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

// Each field's box searches client-side — no network per keystroke. Vocabs
// arrive count-desc from the server, so an empty query just shows the top N
// (browse mode); a query filters that same order down by substring match.
function taRow(attr, name, count) {
  return `<button type="button" class="ta-row" ${attr}>
      <span class="ta-name">${esc(name)}</span><span class="ta-count">${count}</span>
    </button>`;
}

function storeRow(s) {
  const sub = `${esc(s.area)} · ${esc(KIND_LABEL.get(s.kind) ?? s.kind)}`;
  return `<button type="button" class="ta-row" data-select-store="${esc(s.id)}">
      <span class="ta-name">${esc(s.name)} <span class="ta-sub">${sub}</span></span>
      <span class="ta-count">${s.perfumes ?? ''}</span>
    </button>`;
}

function renderTypeahead(field) {
  const box = el(FIELDS[field].ta);
  const input = el(FIELDS[field].input);
  const t = norm(input.value);
  if (t.length === 1) { // too short to filter meaningfully; not empty (browse) either
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  let html = '';
  if (field === 'location') {
    const match = (s) => !t || norm(`${s.name} ${s.area} ${KIND_LABEL.get(s.kind) ?? s.kind}`).includes(t);
    const list = stores.filter(match).slice(0, 12);
    html = list.length ? list.map(storeRow).join('') : '<p class="sub no-results">No matching stores.</p>';
  } else {
    // I like / I avoid share one shape: notes then brands. Browse mode (empty
    // box) shows curated defaults — top notes for I like, the classic
    // love-or-hate notes for I avoid, niche picks vs designer staples for
    // brands; a typed query gets the deeper search caps over the full vocabs.
    // At a flagship the whole store is one brand, so brand filters can only be
    // redundant or empty — the Brands section disappears entirely.
    const flagship = F.store != null && storeById.get(F.store)?.kind === 'flagship';
    const noteCap = t ? 8 : 3;
    const brandCap = t ? 5 : 3;
    const notes = [];
    if (!t && field === 'avoid') {
      for (const name of DEFAULT_AVOID_NOTES) {
        const count = noteCountByNorm.get(norm(name));
        if (count != null) notes.push([name, count]);
      }
    } else {
      for (const [name, count] of notesVocab) {
        if (t && !norm(name).includes(t)) continue;
        notes.push([name, count]);
        if (notes.length >= noteCap) break;
      }
    }
    const brands = [];
    if (!flagship && !t) {
      for (const name of field === 'want' ? DEFAULT_WANT_BRANDS : DEFAULT_AVOID_BRANDS) {
        const count = brandCount.get(name);
        if (count != null) brands.push([name, count]);
      }
    } else if (!flagship) {
      for (const [name, count] of brandsVocab) {
        if (!norm(name).includes(t)) continue;
        brands.push([name, count]);
        if (brands.length >= brandCap) break;
      }
    }
    const noteAttr = field === 'want' ? 'data-want' : 'data-avoid';
    const brandAttr = field === 'want' ? 'data-brand' : 'data-avoid-brand';
    if (notes.length) html += '<div class="ta-head">Notes</div>' + notes.map(([n, c]) => taRow(`${noteAttr}="${esc(n)}"`, n, c)).join('');
    if (brands.length) html += '<div class="ta-head">Brands</div>' + brands.map(([b, c]) => taRow(`${brandAttr}="${esc(b)}"`, b, c)).join('');
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
  // Pressing a result must not blur the input — the pick handler runs with the
  // dropdown still open, and focus stays put for the next pick. Mousedown on
  // the box itself is the scrollbar; that one must keep its default.
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
// whichever dropdown is open.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.finder-field')) return;
  for (const f of Object.values(FIELDS)) el(f.ta).hidden = true;
});

el('page').addEventListener('click', (e) => {
  let hit;
  if ((hit = e.target.closest('[data-select-store]'))) return selectStore(hit.dataset.selectStore);
  if ((hit = e.target.closest('[data-want]'))) return addNote('want', hit.dataset.want);
  if ((hit = e.target.closest('[data-avoid-brand]'))) return addBrand('avoid', hit.dataset.avoidBrand);
  if ((hit = e.target.closest('[data-avoid]'))) return addNote('avoid', hit.dataset.avoid);
  if ((hit = e.target.closest('[data-brand]'))) return addBrand('want', hit.dataset.brand);
  if ((hit = e.target.closest('[data-rm]'))) return removeFilter(hit.dataset.rm, hit.dataset.v);
  if ((hit = e.target.closest('[data-smell]'))) return toggleSmelled(Number(hit.dataset.smell));
  if ((hit = e.target.closest('[data-sort]'))) {
    if (F.sort !== hit.dataset.sort) { F.sort = hit.dataset.sort; filtersChanged(); }
    return;
  }
  if (e.target.closest('#hide-smelled')) {
    F.hideSmelled = !F.hideSmelled;
    renderSort();
    return renderResults(); // client-side collapse; server total untouched
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
  if (raw.sort != null) {
    if (SORTS.some(([v]) => v === raw.sort)) F.sort = raw.sort;
    else dropped.push(raw.sort);
  }
  if (dropped.length) toast(`Removed unknown filter: ${dropped.join(', ')}`);

  syncUrl();
  renderControls();
  runQuery(false);
})();
