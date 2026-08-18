# CATEGORY — Designer / Niche / Everything else (feature-d addendum)

Adds a third pick-category to SMELL LIST's "I like" / "I avoid" fields, next to
Notes and Brands: a brand-class filter (Designer houses / Niche houses /
Everything else). This is the judge-reviewed revision (2026-08-18): three
adversarial reviews (data-taxonomy, UX-semantics, engineering) confirmed the
architecture but forced four load-bearing changes, all folded in below.

## The one semantic rule

The like field computes: **notes AND (brands ∪ classes)**.

- Every liked *note* must be present (unchanged).
- Liked *brands* and liked *classes* merge into ONE union'd must-set — house
  chips are alternatives, never constraints on each other. "Dior + Niche" =
  "Dior, or any niche house." (The original draft made classes a separate
  AND-level must-set; the UX judge showed that produces an undiagnosable
  Dior + Niche → 0-results trap and said ship a toggle instead if unfixed.
  This union fix is the condition under which chips beat the toggle.)
- The avoid field stays a simple union of exclusions: avoided notes ∪ avoided
  classes all go into the exclusion set. No cliffs by construction.
- Want/avoid exclusivity: picking a class in one field splices it from the
  other, exactly like `addNote()` does for notes.
- The taxonomy is **total and visible**: three rows, not two. "Everything
  else" (mass-market, clone houses, celebrity, unlabeled tail — ~47% of
  perfumes) is a real, selectable row in both fields, so the counts add up
  and "avoid clone houses" is expressible. Hiding it would contradict the
  app's honesty ethos (same reason store cards say "not live stock").

## Data layer

### 1. Brand alias pass (build this FIRST)

Per-brand-string labels sit on fragmented brand strings: Frédéric Malle
exists as three strings, Roja as three, 'By Kilian' (in top 300) vs 'Kilian'
(outside), 'Tom Ford Private Blend' separate from 'Tom Ford'. A prefix scan
found **85 near-duplicate pairs where both sides have ≥10 perfumes** — that
list is the curation worksheet. brand_class entries are keyed on the alias
group, not raw strings; sub-line strings fold into their parent UNLESS an
explicit per-string override exists (needed for Tom Ford Private Blend, see
Scent Bar rule).

### 2. Label set (who gets curated)

`top-300 by perfume count ∪ top-300 by popularity mass ∪ every brand in
data/out/stores.json` — roughly 550–600 strings, fewer after aliasing.

Count-ranking alone was the original plan's worst flaw: niche houses have
small catalogs by design, so Le Labo (rank 423), MFK (410), Parfums de Marly
(360), and Serge Lutens (594) all fell outside the top 300 while Avon led it.
The popularity-mass list recovers them; the stores.json union is mandatory
because store-scoped class filters must never go dark (the original cut
covered only 43% of Scent Bar's shelf and 0% of three flagship stores —
guaranteed-zero results at half the stores). **Build-time invariant: every
non-empty brand in stores.json has a class. A store added later without full
class coverage fails the build.**

### 3. The Scent Bar rule (Parisa, 2026-08-18)

**Every brand carried by Scent Bar LA defaults to `niche`.** That's 301
non-empty strings (the dataset's one empty-string brand `""` is excluded —
it's junk, 18 perfumes) and instantly covers the store where class filtering
matters most. Verified against the list: no mainline designer house hides in
there. Two judgment calls the rule surfaces, both resolved AS niche per the
rule, override available:

- Comme des Garçons (5+ collab strings) → niche.
- **Tom Ford Private Blend → niche**, while mainline 'Tom Ford' → designer.
  This requires the per-string override from §1 (do NOT alias-fold Private
  Blend into the parent), and it happily un-accepts the original plan's
  "Tom Ford gets one label" coarseness.

The five single-brand flagship stores (Le Labo, D.S. & Durga, Santa Maria
Novella, Dries Van Noten, ELOREA) → niche as well. Dries Van Noten is niche. 

Precedence: explicit curated label > Scent Bar/flagship rule > drafted label
> `other` (implicit for everything uncurated).

### 4. Curated file + resolver (never a blind copy)

- `data/brand_class.json` — checked in, human-edited, natural spellings OK.
- The build resolves curated keys against actual dataset brands via
  `textnorm.brand_key()`, **mirroring `data/build_stores.py`**: print each
  unmatched name, fail the build below a match-rate gate, emit resolved
  `data/out/brand_class.json` keyed on exact canonical strings (with alias
  fan-out so multi-string houses get every variant labeled).
- Why: exact-string keys were demonstrated broken on day one — curated
  "Hermès"/"Estée Lauder"/"Dolce & Gabbana" all miss the dataset's
  `Hermes`/`Estee Lauder`/`Dolce Gabbana`. The stores pipeline already
  solved this; reuse the pattern.

### 5. Drafting workflow

LLM-drafted labels with a `confidence` field and an explicit `unsure` value.
Parisa reviews ONLY the unsure rows plus the named trap list (places where
LLM world-knowledge is most likely confidently wrong): **Fueguia 1833**
(rank 20, 243 perfumes — highest-stakes single label), Alexandria Fragrances
(clone house, not niche), DSH Perfumes, Bortnikoff, Areej Le Doré, the Roja
pair, Hinode/Eudora (Brazilian direct-sales). Not an even skim of 600 rows.

## Server (server/smelllist.js)

- Boot: per class build `{idArray: Uint32Array (sorted asc), idSet: Set}` by
  unioning `brandToIds` over the resolved map — the store pattern
  (`idArray` + precomputed `idSet`), NOT per-request Sets. Classes are two
  static ~10–20k-id sets; per-request construction is pure waste even though
  big avoid-notes already pay it.
- Query params: repeatable `wantClass` / `avoidClass`, values in
  `{designer, niche, other}` (`other` = complement of the two arrays,
  materialized at boot). Dedupe via Set like brands. Unknown value → **400**
  (closed enum, like sort), not the brand-404 (which is data-dependent).
- Want side: class idArrays union into the existing `brandUnion` (one
  must-set per §semantics). The merged array still participates in
  base-selection (smallest candidate wins; niche ~5–10k ids can genuinely
  win base against common notes).
- Avoid side: class ids union into `avoidSet` — or, cheaper, keep the
  precomputed class idSet in a small `avoidSets` list checked in `passes()`.
- **Live adds: `indexNewPerfume` must append the new id to the matching
  class idArray/idSet** (lookup brand → class built at boot). Without this a
  live-added Dior perfume *escapes* `avoidClass=designer` — a correctness
  break, not staleness. Append preserves ascending order (live ids are
  always ≥ current length), same invariant `appendId` already relies on.
- `/api/classes`: tiny endpoint returning the three rows with counts read
  **live from `idArray.length`** (not a boot-time gzip) so typeahead counts
  always match filter results — the codebase's explicit counts-consistency
  doctrine. No gzip needed for 3 rows. Do NOT piggyback on brands-vocab
  (rows would leak into the client's brandSet) or /api/stores (breaks stale
  offline cache parses).

## Client (public/list.js, list.html)

- Typeahead: third section in BOTH fields, heading **"Category"** (not
  "Type" — meaningless next to "Notes"/"Brands"), rows "Designer houses" /
  "Niche houses" / "Everything else" with counts, visible in browse mode
  (empty-query focus) — that's the discoverability mechanism.
- Word collision: the location typeahead already displays store-kind
  `boutique` as "Niche" (`KINDS`, list.js). Rename that display label to
  "Boutique" so "niche" means exactly one thing in the UI.
- Chips: own style family, `addClass()` enforcing want/avoid exclusivity
  (mirror `addNote()`), removal via the existing `data-rm` path.
- URL round-trip: `wantClass`/`avoidClass` params; `boot()` validates values
  against a client-side whitelist with the existing toast-and-drop flow
  (like `sort`) — otherwise a bad shared link 400s `runQuery` into a blank
  page. Known limitation: an old cached list.js silently strips class params
  from shared links; acceptable, note it.
- Counts fetch: 4th boot fetch joins the existing `Promise.all` (free
  latency-wise) with its own `CACHE` key; its failure is **non-fatal**
  (render rows without counts) so pre-existing offline users don't hit the
  "reconnect and reload" dead end.
- Ship the resolved brand→class map to the client as a small cached vocab so
  the UI can warn on want-brand ⊂ avoided-class contradictions (e.g. "I like
  Dior" + "avoid Designer" is provably-zero server-side; the client should
  say so at pick time).

## Accepted limitations (explicit, not silent)

- **Arab houses** (Armaf, Lattafa, Rasasi, Swiss Arabian, Ajmal — six of the
  dataset's biggest brands; Amouage is unambiguous niche and stays niche)
  are genuinely neither designer nor niche → "Everything else" for v1. The
  three-row design leaves room for a future fourth class without new UI.
- Per-brand coarseness stays (softened by aliasing + the Private Blend
  override).
- Label coverage is head-heavy by design; the tail defaults to "Everything
  else". With mass + stores union that's fine for what actually renders
  (popularity-ranked results), and the visible third row keeps it honest.
- Realistic size: 60–100 lines across build/server/client plus the resolver
  and curation — not the "~25 lines" of the first draft.

## Build order

1. Brand alias pass (85-pair worksheet → alias groups in the build).
2. `data/brand_class.json`: Scent Bar rule + flagship brands (all niche),
   then LLM draft over the §2 label set with confidence flags.
3. Resolver step in the build (brand_key match, unmatched report, fail gate,
   store-coverage invariant) → `data/out/brand_class.json`.
4. Parisa reviews unsure rows + trap list.
5. Server: boot arrays/Sets, params, live-add append, `/api/classes`.
6. Client: Category section, chips, `addClass`, URL validation, counts.
7. Verify gate: store × class spot-checks (Scent Bar + niche ≈ full shelf;
   flagships + niche = full line; designer + each flagship = 0 is CORRECT),
   Dior + Niche returns Dior ∪ niche, want/avoid exclusivity, shared-link
   round-trip with bad values toasts-and-drops.

## judgment calls by Parisa

- Dries Van Noten: niche
- Comme des Garçons + Tom Ford Private Blend: niche
- Future fourth class for the Arab/attar houses: name reserved, not built (let's add this detail to the readme)
