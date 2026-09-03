// Client for one game: join, lobby, host console, guessing, reveal, winners.
// The server is authoritative; this file renders the tailored state it pushes
// (including our role and the scoring rules) and sends user intents back over
// the WebSocket.
'use strict';

const code = location.pathname.slice(1).toUpperCase();
const storage = {
  get hostKey() { return localStorage.getItem(`ng:${code}:hostKey`); },
  get playerId() { return localStorage.getItem(`ng:${code}:pid`); },
  set playerId(v) { localStorage.setItem(`ng:${code}:pid`, v); },
  get name() { return localStorage.getItem('ng:name') || ''; },
  set name(v) { localStorage.setItem('ng:name', v); },
};
const haveHostKey = Boolean(storage.hostKey);

const app = document.getElementById('app');
const barLeft = document.getElementById('bar-left');
const barRight = document.getElementById('bar-right');

let ws = null;
let state = null;
let gameInfo = null; // /api/games/:code — title for the join screen
let reconnectDelay = 1000;
let viewKey = null;
let view = null; // {update()?}

// Local picks for the current round; synced from server state on round entry
// only, so a slow echo never reverts a fast double-tap.
let picks = new Set();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.trim().toLowerCase(); // mirrors server/data.js norm
const signed = (n) => (n > 0 ? `+${n}` : String(n).replace('-', '−'));
const tierName = (t) => (t === 'flat' ? 'Notes' : t);
const soloHost = () => state.role === 'host-playing' && state.players.length === 1; // host playing alone — no winner ceremony
const switchHtml = () => '<span class="w-on">On</span> / <span class="w-off">Off</span>';

// One name field + inline validation, shared by the join and play-along forms.
const nameFieldHtml = (prefix, label) => `
  <div class="field" id="${prefix}-field">
    <label for="${prefix}">${label}</label>
    <input id="${prefix}" type="text" maxlength="24" autocomplete="off" value="${esc(storage.name)}" aria-describedby="${prefix}-err" />
    <p class="err" id="${prefix}-err">Please enter a name</p>
  </div>`;
function bindNameForm(formId, prefix, onName) {
  const form = document.getElementById(formId);
  const field = document.getElementById(`${prefix}-field`);
  const input = document.getElementById(prefix);
  input.addEventListener('input', () => field.classList.remove('invalid'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) {
      field.classList.add('invalid');
      input.focus();
      return;
    }
    storage.name = name;
    onName(name);
  });
  return { form, field, input };
}

// Keeps a container in sync with state.round.image across pushes: the photo
// can appear mid-round (cache finishing) or vanish (names re-hidden). The
// comparison stops the <img> from reloading on every push.
function bottleSyncer(containerId) {
  let shown = null;
  return () => {
    const image = state.round.image ?? null;
    if (image === shown) return;
    shown = image;
    document.getElementById(containerId).innerHTML = image
      ? `<div class="reveal-center spectate-bottle"><div class="bottle"><img src="${esc(image)}" alt="" /></div></div>`
      : '';
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- connection -------------------------------------------------------------

function connect(hello) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    send(hello);
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'joined') {
      storage.playerId = msg.playerId;
    } else if (msg.t === 'state') {
      state = msg;
      render();
    } else if (msg.t === 'error') {
      if (msg.code === 'NOT_FOUND') return renderNotFound();
      // A stale playerId (e.g. the room expired and was recreated) drops us
      // back to the join form instead of a dead-end toast.
      if (msg.code === 'NAME_REQUIRED' && !state) return renderJoinForm();
      toast(msg.message);
    }
  });
  ws.addEventListener('close', () => {
    if (!state) return; // never joined; leave the join form alone
    // Recompute the hello: a first-time joiner's captured hello has no
    // playerId yet, and resending it would register a duplicate player.
    setTimeout(() => connect(helloForMe()), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

function helloForMe() {
  if (haveHostKey) return { t: 'hello', code, role: 'host', hostKey: storage.hostKey };
  return { t: 'hello', code, role: 'player', playerId: storage.playerId || undefined, name: storage.name || undefined };
}

// ---- rendering --------------------------------------------------------------

function setBar(left, right) {
  barLeft.innerHTML = left;
  barRight.innerHTML = right;
}

function render() {
  const key = [state.phase, state.roundIndex, state.role].join('|');
  // The hostbar lives in the page shell, not in any view: every phase view
  // gets it (or not) from here alone.
  const showHostbar = state.role !== 'player' && (state.phase === 'guessing' || state.phase === 'reveal');
  document.body.classList.toggle('has-hostbar', showHostbar);
  document.getElementById('hostbar').hidden = !showHostbar;

  if (key !== viewKey) {
    viewKey = key;
    if (state.phase === 'guessing') picks = new Set((state.round.picks ?? []).map(norm));
    view = buildView();
  }
  view.update?.();
  if (showHostbar) updateHostbar();
  updateBar();
}

const BRAND = "SMELL&nbsp;THINGS";

function updateBar() {
  if (state.phase === 'lobby') {
    setBar(BRAND, esc(code));
  } else if (state.phase === 'final') {
    const rounds = state.roundIndex + 1;
    const players = state.players.length;
    setBar(`DRY&nbsp;DOWN`, `${rounds}&nbsp;ROUND${rounds === 1 ? '' : 'S'}&nbsp;·&nbsp;${players}&nbsp;PLAYER${players === 1 ? '' : 'S'}`);
  } else {
    const me = state.you
      ? `${esc(state.you.name)}&nbsp;·&nbsp;${state.you.total}&nbsp;PTS`
      : (state.role === 'host-spectating' ? 'HOST' : '');
    const phase = state.phase === 'reveal' ? 'REVEAL' : `ROUND&nbsp;${state.roundIndex + 1}&nbsp;/&nbsp;${state.roundCount}`;
    setBar(phase, me);
  }
}

function buildView() {
  if (state.phase === 'lobby') return state.role === 'player' ? waitingView() : hostConsoleView();
  if (state.phase === 'guessing') return state.role === 'host-spectating' ? spectateView() : guessView();
  if (state.phase === 'reveal') return revealView();
  return finalView();
}

function renderNotFound() {
  setBar(BRAND, '');
  app.innerHTML = `
    <div class="narrow join">
      <p class="eyebrow">Not found</p>
      <h1 class="title">No such game</h1>
      <p class="sub">The link may have expired — games close after 12 hours of quiet.</p>
      <a class="ghost" href="/">Create a game</a>
    </div>`;
}

function renderJoinForm() {
  setBar(BRAND, esc(code));
  app.innerHTML = `
    <div class="narrow join">
      <p class="eyebrow">You are invited to</p>
      <h1 class="title">${esc(gameInfo?.title ?? '')}</h1>
      <form id="join" novalidate>
        ${nameFieldHtml('name', 'Display name')}
        <button class="btn block" type="submit">Join game</button>
      </form>
    </div>`;
  bindNameForm('join', 'name', () => {
    if (ws?.readyState === WebSocket.OPEN) send(helloForMe());
    else connect(helloForMe());
  });
}

// ---- lobby ------------------------------------------------------------------

function waitingView() {
  app.innerHTML = `
    <div class="narrow join">
      <p class="eyebrow">You are in</p>
      <h1 class="title">${esc(state.title)}</h1>
      <p class="sub">Waiting for the host to start the first round.</p>
      <div class="waiting">Waiting with you<ul id="players"></ul></div>
    </div>`;
  const update = () => {
    document.getElementById('players').innerHTML = state.players
      .map((p) => `<li class="${p.connected ? '' : 'off'}">${esc(p.name)}</li>`)
      .join('') || '<li class="off">NOBODY YET</li>';
  };
  update();
  return { update };
}

// ---- host console -----------------------------------------------------------

let searchIndex = null;
async function loadSearchIndex() {
  if (!searchIndex) {
    const res = await fetch('/data/search_index.json');
    searchIndex = await res.json();
    for (const p of searchIndex) {
      p.h = `${p.n} ${p.b}`.toLowerCase(); // precomputed haystack
      p.bl = p.b.toLowerCase(); // brand alone, for the brand-prefix score
    }
  }
  return searchIndex;
}

function searchPerfumes(query, limit = 20) {
  const normed = norm(query);
  // One character matches half the index; not worth scanning 69K entries for.
  if (normed.length < 2 || !searchIndex) return [];
  const tokens = normed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const wordStart = new RegExp(`\\b${tokens[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const scored = [];
  for (const p of searchIndex) {
    if (p.x) continue; // suppressed duplicate variant (dedup.json)
    if (!tokens.every((t) => p.h.includes(t))) continue;
    let score = p.h.startsWith(tokens[0]) || p.bl.startsWith(tokens[0]) ? 2 : 0;
    if (wordStart.test(p.h)) score += 1;
    scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].n.length - b[1].n.length);
  return scored.slice(0, limit).map(([, p]) => p);
}

function hostConsoleView() {
  app.innerHTML = `
    <div class="wide host-grid">
      <section>
        <div class="search-box">
          <input id="search" type="search" placeholder="Search perfumes" autocomplete="off" aria-label="Search perfumes" />
        </div>
        <div class="results" id="results" hidden></div>
        <div class="list-head queue-head"><span>Queue</span></div>
        <div id="queue"></div>
      </section>
      <section>
        <div class="list-head"><span>Settings</span></div>
        <div class="toggle-row">
          <div>
            <div>Hide perfume names</div>
            <p class="sub">Players see "Perfume #1". You always see the real name.</p>
          </div>
          <button class="switch" id="opt-hide" role="switch" aria-checked="false" aria-label="Hide perfume names">${switchHtml()}</button>
        </div>
        <div class="toggle-row">
          <div>
            <div>Best-guess mode</div>
            <p class="sub">Players pick only their 4–5 surest notes, and wrong picks cost nothing. Off: pick freely, wrong picks lose points.</p>
          </div>
          <button class="switch" id="opt-mode" role="switch" aria-checked="false" aria-label="Best-guess mode">${switchHtml()}</button>
        </div>
        <div class="toggle-row">
          <div>I'm playing too</div>
          <button class="switch" id="opt-play" role="switch" aria-checked="false" aria-label="I'm playing too">${switchHtml()}</button>
        </div>
        <form id="hostname-form" class="hostname-form" novalidate hidden>
          ${nameFieldHtml('hostname', 'Your display name')}
          <button class="ghost" type="submit">Play along</button>
        </form>
        <div class="host-actions">
          <button class="btn" id="start">Start round 1</button>
          <button class="ghost" id="copy">Copy join link</button>
        </div>
      </section>
    </div>`;

  const searchInput = document.getElementById('search');
  const resultsEl = document.getElementById('results');

  loadSearchIndex().catch(() => toast('Search is unavailable — could not load the perfume index.'));

  const clearSearch = () => {
    searchInput.value = '';
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    searchInput.focus();
  };

  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const query = searchInput.value;
      const hits = searchPerfumes(query);
      if (hits.length === 0 && norm(query).length >= 2 && searchIndex) {
        resultsEl.hidden = false;
        resultsEl.innerHTML = '<p class="sub no-results">No matches.</p>';
        return;
      }
      resultsEl.hidden = hits.length === 0;
      resultsEl.innerHTML = hits
        .map((p) => `<button type="button" class="result" data-id="${p.i}">
            <span>${esc(p.n)} <span class="brand">— ${esc(p.b)}${p.y ? ` · ${p.y}` : ''}</span></span><span class="add">Add</span>
          </button>`)
        .join('');
    }, 120);
  });

  resultsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.result');
    if (!btn) return;
    send({ t: 'queue-add', id: Number(btn.dataset.id) });
    clearSearch();
  });

  document.getElementById('queue').addEventListener('click', (e) => {
    const btn = e.target.closest('.x');
    if (btn) send({ t: 'queue-remove', id: Number(btn.dataset.id) });
  });

  document.getElementById('opt-hide').addEventListener('click', () => {
    send({ t: 'options', hideNames: !state.options.hideNames });
  });
  document.getElementById('opt-mode').addEventListener('click', () => {
    send({ t: 'options', mode: state.options.mode === 'limited' ? 'open' : 'limited' });
  });
  // The play toggle can be "pending": on, but waiting for a display name.
  // syncPlaySwitch keeps the visual state truthful the moment the form opens,
  // instead of only after the server confirms.
  const optPlay = document.getElementById('opt-play');
  const { form: nameForm, field: hostnameField, input: hostnameInput } = bindNameForm(
    'hostname-form',
    'hostname',
    (name) => {
      nameForm.hidden = true;
      send({ t: 'options', hostPlays: true, hostName: name });
    },
  );
  const syncPlaySwitch = () => {
    optPlay.setAttribute('aria-checked', String(state.options.hostPlays || !nameForm.hidden));
  };
  optPlay.addEventListener('click', () => {
    if (state.options.hostPlays) return send({ t: 'options', hostPlays: false });
    if (!nameForm.hidden) { // pending — clicking again cancels
      nameForm.hidden = true;
      hostnameField.classList.remove('invalid');
      syncPlaySwitch();
      return;
    }
    if (storage.name) return send({ t: 'options', hostPlays: true, hostName: storage.name });
    nameForm.hidden = false;
    syncPlaySwitch();
    hostnameInput.focus();
  });

  // New games default to the host playing along. Runs once per game: with a
  // remembered name it registers right away, otherwise the toggle starts in
  // its pending state with the name form open.
  const autoPlayKey = `ng:${code}:autoplay`;
  if (!state.options.hostPlays && state.roundIndex < 0 && !localStorage.getItem(autoPlayKey)) {
    localStorage.setItem(autoPlayKey, '1');
    if (storage.name) send({ t: 'options', hostPlays: true, hostName: storage.name });
    else nameForm.hidden = false;
  }

  document.getElementById('start').addEventListener('click', () => send({ t: 'start-round' }));
  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${location.origin}/${code}`);
    toast('Join link copied');
  });

  const update = () => {
    document.getElementById('queue').innerHTML = state.host.queue
      .map((q, i) => `<div class="queue-item${q.played ? ' played' : ''}">
          <span class="idx">${String(i + 1).padStart(2, '0')}</span>
          <span class="name">${esc(q.name)} <span class="brand">— ${esc(q.brand)}</span></span>
          ${q.image ? '' : '<span class="tag">No photo yet</span>'}
          ${q.played ? '' : `<button class="x" data-id="${q.id}" aria-label="Remove ${esc(q.name)}">×</button>`}
        </div>`)
      .join('') || '<p class="sub queue-empty">Search above to queue the first perfume.</p>';
    document.getElementById('opt-hide').setAttribute('aria-checked', String(state.options.hideNames));
    document.getElementById('opt-mode').setAttribute('aria-checked', String(state.options.mode === 'limited'));
    syncPlaySwitch();
    const start = document.getElementById('start');
    start.textContent = `Start round ${state.roundIndex + 2}`;
    start.disabled = state.roundIndex + 1 >= state.host.queue.length;
  };
  update();
  return { update };
}

// ---- guessing ---------------------------------------------------------------

function columnsHtml(columns, chipHtml) {
  const n = columns.length;
  return `<div class="pyramid" data-cols="${n}" style="--cols:${n}">
    ${columns.map((c) => `<div class="tier"><h4>${tierName(c.tier)}</h4><div class="chips">${c.notes.map(chipHtml).join('')}</div></div>`).join('')}
  </div>`;
}

function guessView() {
  const { round } = state;
  const { scoring, maxPicks } = round;
  const rules = maxPicks
    ? `Pick the ${maxPicks} notes you're most sure of. ${signed(scoring.hit)} correct · wrong picks are free.`
    : `Pick every note you believe is in it. ${signed(scoring.hit)} correct · ${signed(scoring.wrong)} wrong.`;
  app.innerHTML = `
    <div class="wide round">
      <p class="eyebrow centered">Now smelling</p>
      <h1 class="round-name" id="guess-name">${esc(round.label)}</h1>
      <p class="round-sub">${rules}</p>
      <div id="guess-bottle"></div>
      ${columnsHtml(round.columns, (n) => `<button class="chip" data-note="${esc(n)}" aria-pressed="false">${esc(n)}</button>`)}
      <div class="round-foot" id="foot">
        <span class="picked"><span id="pickcount">0</span>${maxPicks ? ` / ${maxPicks}` : ''} notes picked</span>
        <button class="btn" id="lock">Lock in guesses</button>
      </div>
      <p class="locked-note" id="locked-note" hidden>Locked — waiting for the reveal</p>
    </div>`;

  // The label re-syncs every push: it changes if the host toggles name
  // visibility mid-round.
  const syncBottle = bottleSyncer('guess-bottle');
  const update = () => {
    // At the pick limit, unpicked chips disable so the cap explains itself.
    const atLimit = maxPicks && picks.size >= maxPicks;
    for (const chip of app.querySelectorAll('.chip')) {
      const pressed = picks.has(norm(chip.dataset.note));
      chip.setAttribute('aria-pressed', String(pressed));
      chip.disabled = Boolean(state.round.locked) || (atLimit && !pressed);
    }
    document.getElementById('guess-name').textContent = state.round.label;
    syncBottle();
    document.getElementById('pickcount').textContent = String(picks.size);
    document.getElementById('foot').hidden = Boolean(state.round.locked);
    document.getElementById('locked-note').hidden = !state.round.locked;
  };

  app.querySelector('.pyramid').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || state.round.locked) return;
    const key = norm(chip.dataset.note);
    if (picks.has(key)) picks.delete(key);
    else if (maxPicks && picks.size >= maxPicks) return; // chip is disabled; belt and braces
    else picks.add(key);
    update();
    // Send display-cased notes so the server can echo them back readably.
    const cased = [];
    for (const c of state.round.columns) for (const n of c.notes) if (picks.has(norm(n))) cased.push(n);
    send({ t: 'picks', notes: cased });
  });
  document.getElementById('lock').addEventListener('click', () => send({ t: 'lock' }));

  update();
  return { update };
}

function spectateView() {
  const { round } = state;
  const realSet = new Set(round.real.map(norm));
  app.innerHTML = `
    <div class="wide round">
      <p class="eyebrow centered">Round ${state.roundIndex + 1} — players are guessing</p>
      <h1 class="round-name">${esc(round.label)}</h1>
      <div id="spec-bottle"></div>
      <p class="spectate-note">Only you see this</p>
      ${columnsHtml(round.columns, (n) => `<span class="chip ${realSet.has(norm(n)) ? 'real' : 'dim'}">${esc(n)}</span>`)}
    </div>`;
  const update = bottleSyncer('spec-bottle');
  update();
  return { update };
}

// ---- reveal / final ---------------------------------------------------------

function bottleHtml(image, name) {
  return image ? `<div class="bottle"><img src="${esc(image)}" alt="Bottle of ${esc(name)}" /></div>` : '';
}

/**
 * Shared ranking/standings table. Rows carry {name, you, total} plus either
 * roundScore (single Round column) or rounds[] (one column per round).
 */
function rankingHtml(rows, caption, roundCount = 0) {
  const heads = roundCount
    ? Array.from({ length: roundCount }, (_, i) => `<th class="num">R${i + 1}</th>`).join('')
    : '<th class="num">Round</th>';
  const cells = (r) =>
    roundCount
      ? r.rounds.map((s) => `<td class="num">${signed(s)}</td>`).join('')
      : `<td class="num">${signed(r.roundScore)}</td>`;
  return `<div class="ranking"><table>
    <caption>${caption}</caption>
    <thead><tr><th>#</th><th>Player</th>${heads}<th class="num">Total</th></tr></thead>
    <tbody>${rows
      .map((r, i) => `<tr class="${r.you ? 'you' : ''}"><td>${i + 1}</td><td>${esc(r.name)}${r.you ? ' <span class="delta">— you</span>' : ''}</td>${cells(r)}<td class="num">${r.total}</td></tr>`)
      .join('')}</tbody>
  </table></div>`;
}

function revealView() {
  const { reveal } = state;
  const { scoring } = reveal;
  const wrongPts = scoring.wrong ? ` <span class="pts">${signed(scoring.wrong)}</span>` : '';
  const verdicts = reveal.result
    ? `<div class="verdicts">
        <div class="verdict-group"><h5>Your picks</h5><div class="vchips">
          ${reveal.result.hits.map((n) => `<span class="v hit">${esc(n)} <span class="pts">${signed(scoring.hit)}</span></span>`).join('')}
          ${reveal.result.wrong.map((n) => `<span class="v wrong">${esc(n)}${wrongPts}</span>`).join('')}
          ${reveal.result.hits.length + reveal.result.wrong.length === 0 ? '<span class="v miss">No picks</span>' : ''}
        </div></div>
        ${reveal.result.missed.length ? `<div class="verdict-group"><h5>You missed</h5><div class="vchips">${reveal.result.missed.map((n) => `<span class="v miss">${esc(n)}</span>`).join('')}</div></div>` : ''}
      </div>`
    : `<div class="verdicts">
        ${Object.entries(reveal.real ?? {}).map(([tier, notes]) => `<div class="verdict-group"><h5>${tierName(tier)}</h5><div class="vchips">${notes.map((n) => `<span class="v hit">${esc(n)}</span>`).join('')}</div></div>`).join('')}
      </div>`;

  app.innerHTML = `
    <div class="wide">
      <div class="reveal-center">
        ${bottleHtml(reveal.image, reveal.name)}
        <h1 class="reveal-name">${esc(reveal.name)} — ${esc(reveal.brand)}</h1>
        ${reveal.result ? `<p class="eyebrow score-note">Round score ${signed(reveal.result.score)}</p>` : ''}
      </div>
      ${verdicts}
      ${rankingHtml(reveal.ranking, 'Round ranking')}
    </div>`;
  return {};
}

function finalView() {
  const { final } = state;
  const winner = final.standings[0];
  const isHostView = state.role !== 'player';
  const solo = soloHost();
  const headline = solo
    ? { name: `You scored ${winner?.total ?? 0}`, sub: `over ${final.roundCount} round${final.roundCount === 1 ? '' : 's'}` }
    : { eyebrow: 'Winner', name: esc(winner?.name ?? '—'), sub: `${winner?.total ?? 0} points` };
  app.innerHTML = `
    <div class="wide">
      <div class="winner-block">
        ${headline.eyebrow ? `<p class="eyebrow">${headline.eyebrow}</p>` : ''}
        <h1 class="winner-name">${headline.name}</h1>
        <p class="winner-score">${headline.sub}</p>
      </div>
      ${rankingHtml(final.standings, solo ? 'Your rounds' : 'Final standings', final.roundCount)}
      ${isHostView ? '<div class="final-actions"><button class="btn" id="new-game">Start a new game</button></div>' : ''}
    </div>`;
  if (isHostView) {
    const btn = document.getElementById('new-game');
    btn.addEventListener('click', () => createGameAndGo(btn));
  }
  return {};
}

// ---- host control strip -----------------------------------------------------
// The hostbar element lives in game.html; render() shows/hides and refreshes
// it, so phase views never carry their own wiring.

document.getElementById('hostbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.dataset.act) send({ t: btn.dataset.act });
});

function updateHostbar() {
  const stat = document.getElementById('hostbar-stat');
  const actions = document.getElementById('hostbar-actions');
  if (state.phase === 'guessing') {
    const pending = state.round.pending ?? [];
    const waiting = pending.length
      ? ` — waiting on ${pending.map((p) => `<span class="who${p.connected ? '' : ' off'}">${p.you ? 'you' : esc(p.name)}</span>`).join(', ')}`
      : '';
    stat.innerHTML = `${state.round.lockedCount} / ${state.round.playerCount} locked${waiting}`;
    const blocked = pending.some((p) => p.connected);
    actions.innerHTML = `<button class="btn" data-act="reveal" ${blocked ? 'disabled' : ''}>Reveal</button>`;
  } else if (state.phase === 'reveal') {
    stat.textContent = `Round ${state.roundIndex + 1} of ${state.roundCount}`;
    actions.innerHTML = state.reveal.lastRound
      ? `<button class="btn" data-act="finish">${soloHost() ? 'Finish game' : 'Announce winners'}</button>`
      : '<button class="btn" data-act="start-round">Next round</button>';
  }
}

// ---- boot -------------------------------------------------------------------

(async function boot() {
  try {
    const res = await fetch(`/api/games/${code}`);
    if (!res.ok) return renderNotFound();
    gameInfo = await res.json();
  } catch {
    return renderNotFound();
  }
  document.title = gameInfo.title;
  if (haveHostKey || storage.playerId) connect(helloForMe());
  else renderJoinForm();
})();
