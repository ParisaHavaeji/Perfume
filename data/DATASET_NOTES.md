# Dataset considerations

Working notes on data provenance and trust for the Smell Things dataset.
Read this before touching anything in `data/` — especially before any crawl,
re-crawl, or "why are these notes wrong?" investigation. (A judge-reviewed
remediation plan and a dated external dataset survey follow at the end of
this file.)

## Source trust levels

| Source | Raw file | How obtained | Trust |
|---|---|---|---|
| Fragrantica dump | `raw/fra_perfumes.csv` | static Kaggle dump | trusted |
| Parfumo TidyTuesday | `raw/parfumo_tidytuesday.csv` | static published dataset | **third-party scrape** (see below) |
| Luckyscent | `raw/luckyscent_notes.jsonl` | own crawl (retailer, no anti-scrape games) | trusted |
| Fragrantica refresh | `raw/fragrantica_new.jsonl` | own crawl, pre-block | trusted; **never re-crawl** (see below) |
| Parfumo gap crawl | `raw/parfumo_gap.jsonl` | scripted urllib crawl | **QUARANTINED** |
| Parfumo live adds | `raw/parfumo_new.jsonl` | scripted server fetch (feature removed) | **QUARANTINED** |
| Parfumo verified re-entries | `raw/parfumo_verified.jsonl` | quarantined rows re-admitted after human check | trusted |
| Scent Room / Malin+Goetz / Elorea | catalog jsonls | Shopify / brand-site crawls | trusted |
| rdemarqui Fragrantica scrape | `raw/rdemarqui_perfumes.xlsx` | static GitHub dataset (plan S10) | **third-party scrape** |

## The Parfumo poisoning (the big one)

parfumo.com serves **deliberately falsified data to scripted, unauthenticated
fetches**. Two observed grades:

1. **Fingerprintable decoys** — gibberish ("Blorkzanthumer"), adjective+note
   fabrications ("Recursive Rose"), and disgusting notes ("Sewage") mixed into
   note lists. Caught by the frozen pool in `poison.py`; `build_dataset.py`
   drops any parfumo row carrying one, `verify.py` asserts none survive.
2. **Plausible poison** — the entire note pyramid (and rating/vote count, and
   possibly year) replaced with *realistic* perfume notes. **No offline check
   can detect this.** Confirmed 2026-09-02 on "Somewhere but Nowhere" (Lore):
   crawl stored a fabricated Thai mango/custard/saffron/vanilla pyramid with
   rating 3.76 @ 169 votes; the real page has a flat list (American cedar,
   black tea, cardamom, leather, vanilla cream) at 6.3 @ 41 votes. An earlier
   instance was hand-patched via `PARFUMO_SUPERSEDED` in `clean_dataset.py`
   (Bon Parfumeur 602, 0/24 note overlap) before the pattern was understood.

Consequences you must not forget:

- A parfumo row *passing* the poison.py fingerprint proves nothing.
- Ratings and vote counts from scripted crawls are fabricated too.
- The whole gap crawl (~689 dataset rows at time of quarantine) is untrusted.

### The quarantine (active)

The quarantine now lives in `SOURCE_TRUST` in `build_dataset.py` (S6 of the
remediation plan, 2026-09-02, replacing the earlier
`QUARANTINE_SCRIPTED_PARFUMO` flag): every loader stamps its rows with the
trust level of the raw file they came from, and one gate in `main()` drops
every non-shippable row — before any merging, so a quarantined row can never
claim a brand+name key and shadow a shippable source. Both scripted-parfumo
sources (`parfumo_gap.jsonl`, `parfumo_new.jsonl`) are `quarantined` and drop
whole at build time. This removed those perfumes from the game entirely —
wrong notes in a note-guessing game are worse than absent perfumes.
`verify.py` asserts the shipped trust levels are exactly
{trusted, third-party-scrape, verified}.

**Correction (2026-09-02, judge review):** the TidyTuesday rows are NOT
"unaffected". ~4,000 of the csv's 59k rows carry known grade-1 decoys from the
`poison.py` pool — the dump is someone else's scripted scrape of the same site
that poisons scripted fetches. `build_dataset` drops the decoy-carrying rows,
but the ~17.8k surviving parfumo rows in the shipped dataset share that
provenance and may carry grade-2 plausible poison at an unknown rate. Their
correct trust label is *third-party scrape*, not *trusted*; we keep shipping
them (they're 26% of the dataset and mostly pre-2024 rows that predate the
poison scheme's observation), but no invariant may call them verified.

The raw jsonl files are kept on purpose: they hold the URL/fid match work,
which is still valid. Only the *content* fetched from Parfumo is poisoned.

**The live-add feature is removed (2026-09-02).** The "paste a Parfumo link"
flow (`server/parfumo.js` + `server/liveadds.js`, POST `/api/perfumes`, the
host search box link branch) was deleted because of this same poisoning; a
replacement on a trustworthy source is planned. Details in plan.md; the
deleted code is in git history.

### How to lift the quarantine (re-verification protocol)

Raw HTML was never kept, so re-parsing is impossible — only re-fetching:

1. Fetch through a **real browser engine** (in-app browser pane, or
   Playwright driving Chrome), politely (~10s spacing). A single manual
   browser fetch on 2026-09-02 returned clean data — the poisoning appears to
   target scripted HTTP clients, not browser sessions.
2. **Vote-count monotonicity is a definitive tell**: Parfumo vote counts only
   grow. If a stored row has more votes than the live page, the stored row
   was fabricated.
3. **Double-fetch agreement**: poison is randomized per fetch; the real page
   is stable. Accept notes only if two spaced fetches return identical lists.
4. Capture the **"SOURCE-BACKED & VERIFIED"** badge Parfumo now shows on
   verified pages — worth storing as a trust flag.
5. This time, **keep the raw HTML**.

Once a row is verified, its notes can re-enter; flip the flag only when the
whole file is re-verified (or split verified rows into a new raw file).

The re-entry lane exists: `raw/parfumo_verified.jsonl`, loaded by
`load_parfumo_verified()` outside the quarantine gate. Move a row there (with
a `verified: {date, method}` stamp) once it has passed a check against the
live page. First re-admission 2026-09-02: "Ch. 1 - Blaze of Stillness"
(Maison Margiela) — Parisa checked the live page by hand; notes match.
`parfumo_new.jsonl` is now empty but kept (schema anchor + render.yaml
buildFilter still references it).

## Other standing rules

- **Never fetch fragrantica.com.** Parisa's explicit order; every attempt
  crashes/blocks. The 2024+ gap is why the Parfumo gap crawl existed.
- **Never commit or push.** Parisa commits herself, always.
- Pipeline order: `build_dataset.py` → `clean_dataset.py` (assigns ids,
  emits `out/`) → `build_stores.py` → `verify.py` (must end `0 failure(s)`).
  Ids are positional and renumber on every rebuild — nothing may persist ids
  across builds (images are keyed by url/fid for exactly this reason).
- `clean_dataset.py` mutates `perfumes.json` in place; never run it twice
  without rebuilding first.
- When notes look "confidently wrong" for any parfumo-sourced row, suspect
  poisoning first, source-site error second. Check `source`, then whether the
  row's url is in `raw/parfumo_gap.jsonl`, then compare live page + vote counts.
- Before merging ANY external dataset, re-scan it for new decoy pool tokens
  (cheap; see the survey below for why).

---

# Dataset remediation plan — 2026-09-02 (judge-reviewed)

Triggered by the doubled "Ch. 1 - Blaze of Stillness" on the live site. Root
cause of that one: the row was both live-added (`raw/parfumo_new.jsonl`,
replayed at boot by the now-deleted `liveadds.js`) and baked into the dataset;
`attach_fids` matched its url to fid 129373, the shard writer stores `fid`
**elif** `url` so the url was dropped, and the boot replay's `findByUrl` (url
map built from shard urls only) missed the baked copy and re-added it.

A first 4-layer plan (canonical identity folding + per-row trust + browser
re-verification + coverage) was reviewed by three adversarial LLM judges
(correctness / pipeline-design / pragmatism lenses, scores 3, 5, 5 of 10).
What follows is the corrected plan. Judge measurements marked (j) were taken
against the current 66,423-row build; re-confirm any you rely on.

## Refuted — do NOT do these

- **Folding dedup on "any matching identity component".** Fids are guessed by
  `attach_fids` per brand+name, so whole flanker families share one fid
  (Mugler Angel EdT/EdP share fid 704 with zero note overlap); ~2,094 fids are
  shared by >1 row and folding them hard-deletes ~3,900 distinct-pyramid rows
  (j). Brand+name folding likewise kills real flankers and reverses the
  deliberate soft-suppress design of `dedup.json`. A fid is an **image key**,
  not identity. Same perfume can also carry two different fids across sources
  (Paco Rabanne 1 Million: 3747 vs 23908) (j).
- **"No two rows share any identity component" as a verify invariant.**
  Unsatisfiable: `dedup.json` sanctions ~4,839 legitimate brand+name
  collisions and `verify.py:112` asserts they exist. The only collision-free
  identity today is `urlKey` (0 collisions across ~21k url rows) (j).
- **Per-row trust stored in raw files.** The pipeline rebuilds from raw every
  run, so trust is a pure function of *which raw file a row came from*. A
  stored field would drift. Use a dict (S6).
- **Building the re-verification lane before the FragDB decision** (S9): 2
  spaced browser fetches × ~690 rows ≈ 4+ hours of babysitting for 1% of the
  dataset, mooted entirely if FragDB is bought.

## Phase 0 — stop the bleeding (Parisa, no code, ~5 min)

- [ ] **S0a. Revoke the `GITHUB_TOKEN` PAT** (GitHub → settings → tokens).
  Until the quarantine commit deploys, the live service still runs the
  live-add endpoint and can commit poisoned Parfumo rows into the repo; the
  stale `smell-things` service (if it still exists) does the same from a URL
  nobody watches. Revocation neutralizes both instantly.
- [ ] **S0b. Delete the stale `smell-things` Render service** (already queued).
- [ ] **S0c. Commit + deploy the quarantine working tree.** This removes the
  live duplicate: the replay code is deleted, and Blaze of Stillness now
  ships exactly once — Parisa verified its notes against the live page
  (2026-09-02), so the row re-enters via `raw/parfumo_verified.jsonl`
  instead of being dropped (rebuilt + verified, 66,424 rows, done). Stage
  `data/DATASET_NOTES.md` and `data/raw/parfumo_verified.jsonl` in the same
  commit — the README references the former. Drop the dead `GITHUB_TOKEN`
  env var from `render.yaml`.

## Phase 1 — local hygiene (~30 min)

- [x] **S1. Flush `cache/images/`** — done 2026-09-02 after the
  Blaze-re-entry rebuild (1,597 stale id-keyed files incl. `.bak` strays
  removed; `data/image_seed/` untouched). Re-warm deliberately not run:
  on-demand fetch + the url-keyed seed cover it, and warm is pending the
  NO_WARM decision.
- [x] **S2. Filter suppressed variants out of the host search box** — done
  2026-09-02. `initData()` in `server/data.js` stamps `x: 1` on the 4,839
  `dedup.json`-suppressed entries before gzipping the served index (disk file
  untouched; ids are array positions so the stamp is O(suppress));
  `searchPerfumes` in `public/game.js` skips `p.x` rows. Verified in-browser:
  "1 Million (Eau de Toilette)" and "Santal Royal (Eau de Parfum)" no longer
  appear in the dropdown while canonical rows and real flankers do.

## Phase 2 — one batched pipeline rerun — DONE 2026-09-02 (Claude, all local, uncommitted)

Batch S3–S7 into a single rebuild: every rerun renumbers ids and triggers the
full flush/re-warm/seed checklist, so pay that cost once.

Outcome: 66,424 → **65,407** rows (alias-driven re-dedupe removed ~1,017 dup
rows), dedup.json 4,839 → **5,946** suppressed (955 of them via the new tier-3
prefix folds), verify **0 failures**, pipeline ×2 byte-identical. Canonical
displays moved for the merged houses (e.g. "Zoologist" → "Zoologist
Perfumes"); 7 ugly joint-name winners pinned via `BRAND_DISPLAY_OVERRIDES`.
Deliberately NOT merged after hand review: orientica/orienticapremium and
myperfumes/myperfumesselect (premium *lines* whose same-named products carry
different juice). `seed_images.js` now reports 14 orphan seed files — the
alias merge deduped away the rows carrying those urls; deleting them is
Parisa's call.

- [x] **S3. Expand `BRAND_KEY_ALIASES`** (currently 2 entries). ~79
  containment brand-key pairs share ≥3 identical perfume names ≈ ~1,200
  duplicate rows (j): alharamain/alharamainperfumes (129 shared names),
  iprofumidifirenze/spezierie… (66), rojadove/rojaparfums (60),
  miltonlloyd/… (58), afnan/afnanperfumes (56), jomalone/jomalonelondon (41),
  zoologist/zoologistperfumes (34), bykilian/kilian (27), … Generate the
  containment list mechanically, review by hand, add the approved pairs.
  *(done: 76 pairs added; build_stores.py lookups now route through the alias
  map on BOTH sides — the canonical display can sit on either side of a merge)*
- [x] **S4. Line-prefix variant folding in `build_dedup`** — a new tier
  alongside the format-suffix pass: same brand, one name-key a suffix of the
  other ("Armani Privé - Iris Céladon" vs "Iris Celadon", "Olfactories -
  Tainted Love" vs "Tainted Love"), gated on ≥80% note overlap. ~690 pairs
  (j) — the "Ch. 1 -" class, which no url/fid/exact-name key can see.
  **Soft-suppress only** (dedup.json), never hard-delete.
  *(done: token-suffix match so "Montrose" can't fold into "Rose"; 955 folds)*
- [x] **S5. Dual-emit `fid` AND `url` in shards** (`clean_dataset.py:517`
  elif → both; ~6,356 rows affected, +2.7% shard size, verified safe for
  images/client (j)). Atomically with it: build `seed_images.js` liveKeys
  from every url-bearing entry regardless of fid (else the orphan report
  flags in-use seeds); document image precedence (seed-by-url → fid → page
  scrape) in `images.js download()`; and swap `data.js:87`'s O(n)
  `searchIndex.find` for `searchIndex[id]`.
  *(done, incl. images.js precedence comment + page-scrape fallback for
  dual-key entries whose fid fetch fails, and the data.js O(1) index swap)*
- [x] **S6. Provenance dict in `build_dataset.py`:** `SOURCE_TRUST = {raw
  file → trusted | third-party-scrape | quarantined | verified}` mirroring
  the table at the top of this file (with TidyTuesday = third-party-scrape).
  Each loader stamps `p["trust"]`; one filter at the end of `main()` drops
  non-shippable levels with printed counts. This replaces
  `QUARANTINE_SCRIPTED_PARFUMO` and the scattered loader early-returns, and
  is where `PARFUMO_SUPERSEDED` logic can consolidate. Later, the
  `unionNotes`/decoy-scan predicates keyed on `source == "parfumo"` should
  key on trust instead.
  *(done; the filter runs BEFORE the merge, not "at the end of main()" as
  first written — filtering after would let a quarantined row claim a
  brand+name key and shadow a shippable source)*
- [x] **S7. New `verify.py` assertions:** urlKey uniqueness across all rows
  (the one enforceable identity invariant); the set of trust levels present
  in the build is exactly the shippable set; re-baseline the row-count and
  dedup-band thresholds after S3/S4 shift them; before/after canonical-brand
  diff in the rerun checklist (S3 + any merge can flip `unify_brands`
  most-common spellings).
  *(done: urlKey unique over 18,739 url rows; trust set == shippable set;
  size floor re-baselined to >64,000; dedup band 4,000–12,000 still holds at
  5,946; brand diff reviewed — 76 keys folded, 0 spurious gains)*
- [x] **S8. Run the full plan.md rerun checklist** (pipeline ×2
  byte-identical, verify green, flush cache, warm + seed, commit seed) and
  fix the README dataset counts (still quotes 71,772 / pre-quarantine
  numbers).
  *(done: ×2 byte-identical, verify green, cache was already empty from S1 and
  stays flushed; warm deliberately NOT run — no new url-source flagships, and
  it's pending the NO_WARM decision; seed untouched (url-keyed) and the seed
  commit is Parisa's; README counts now 65,407 / 1,801 flat / per-source
  updated, and `build_stores.py` added to its rebuild snippet. Server restart
  + deploy are Parisa's.)*

## Phase 3 — run 2026-09-02 (S9 declined, S10 merged)

- [x] **S9. The $200 FragDB question** — decided NO 2026-09-02 (Parisa:
  not paying for the dataset). The "No" branch's browser re-verification
  lane (protocol above, ~30-row pilot first, keep gzipped HTML outside the
  deployed tree) is now the open follow-up — it stays unbuilt until Parisa
  asks for it; the ~689 quarantined gap-crawl rows stay out until then.
- [x] **S10. rdemarqui xlsx merge — done 2026-09-02.** Downloaded
  `perfume_database_cleaned.xlsx` into `raw/rdemarqui_perfumes.xlsx`
  (36,969 rows; 36,966 usable). Pre-merge scans: decoy pool hits **0**;
  unseen note tokens ~41, all real notes or obvious typos (4 typo synonyms
  added: popocorn/oive leaf/narciussus/massioa); the xlsx holds literal
  `\uXXXX` escapes in 48 note rows (decoded in the loader) and strips
  punctuation/diacritics from brand names (14 display forms pinned in
  `BRAND_DISPLAY_OVERRIDES` — "Malin+Goetz", "Kiehl's", … — after its 17.5k
  rows flipped the most-common-spelling vote; casing-only flips like "Mad
  et Len" kept as improvements). Loader `load_rdemarqui()` merges last;
  notes title-cased at load so lowercase spellings can't flip canonical
  display casing. "17.7k new" landed at 17,513 rows (65,407 → **82,920**);
  attach_fids recovered fids for ~41% of them, leaving 10,319 image-less
  rows (12.4%) — verify.py's image invariant is now a ≥85% coverage floor
  plus "imageless ⇒ source rdemarqui" (the "e.g. ≥95%" guess was optimistic;
  server 404s cleanly on no-image entries). Dedup grew 5,946 → 6,611 (in
  band); verify 0 failures, pipeline ×2 byte-identical; cache/images
  flushed (24 stale files). As predicted this shifts `notes_vocab.json`
  tier counts — landed before any plan.md M1 baselines.

## Future live-add flow (whenever it returns)

Two guards, both required:
1. **Bake watermark** — record what the bake consumed (line count or
   timestamp of the replayed raw file); boot replay skips at-or-below it.
   Correct even when the bake *changed* the row's identity (rename, alias
   fold) — exactly the case where identity matching fails and the Blaze bug
   bit.
2. **Three-way `findByUrl`** — look up by urlKey, fid, and normalized
   brand+name, not urlKey alone (46k Fragrantica rows have no url at all).

---

# External dataset survey — 2026-09-02

Looked for already-crawled perfume datasets that could add to our 67,097. Nothing
was merged; these are the findings and calls.

## The one worth taking: rdemarqui's Fragrantica xlsx (~17.7k new, free) — MERGED 2026-09-02 (plan S10 above)

https://github.com/rdemarqui/perfume_recommender → `database/perfume_database_cleaned.xlsx`

A ~2023 Fragrantica scrape: 36,969 perfumes, three columns (brand, perfume, flat
comma-separated notes). Matched by normalized brand+name against perfumes.json:
19,226 overlap, **17,743 not in our dataset**, averaging 6.8 notes each.

- Flat notes only — no pyramid, year, rating, URL, or fid. They'd come in like
  the Luckyscent rows: flat structure, image-less.
- No license stated in the repo.
- True gain is probably under 17.7k — some "new" rows are spelling variants our
  brand aliasing would fold.
- If we take it: a `load_rdemarqui()` in build_dataset (priority last, like
  scentroom), and per the standing rule, re-scan for NEW decoy pool tokens
  before merging any external data. No known poison risk (Fragrantica doesn't
  run the decoy scheme), but the scan is cheap.

## Dead end: the TidyTuesday Parfumo dataset

https://github.com/rfordatascience/tidytuesday/blob/main/data/2024/2024-12-10/readme.md

Looked promising (59,325 rows, pyramids + accords + ratings) and an overlap
check showed 11,663 "new" perfumes with notes — but 31% of those carry known
poison.py decoys, and a hash check settled it: the download is **byte-identical
to `raw/parfumo_tidytuesday.csv`** (sha1 0eb82b2784…). It IS our existing
Parfumo source. The "new" rows are exactly what build_dataset deliberately
drops (poisoned or note-less). Nothing to gain here.

## The paid option: FragDB ($200–400)

https://github.com/FragDB/fragrance-database · https://huggingface.co/datasets/FragDBnet/fragrance-database · fragdb.net

137,789 Fragrantica perfumes + ~227k Parfumo with 83,643 cross-matched pairs;
full pyramids, accords, ratings, brand/perfumer profiles, 23 languages. Free
tier is 10-row samples only (CC-BY-NC); full database is $200 (core CSVs) or
$400 (adds 4.6M-review parquets, commercial license).

This is the only route to materially more *quality* data — roughly doubling us
with proper pyramids, no scraping. It would also moot the open
authenticated-parfumo-crawl-vs-stop question: buying beats crawling a site
that poisons unauthenticated fetches.

## Also seen, not worth the trouble

- Kaggle, olgagmiufana1's Fragrantica set — same author as the TidyTuesday
  scrape; needs a Kaggle login; her Parfumo set now 404s.
- Assorted small Kaggle/HF sets (perfume-recommendation, candle fragrances) —
  tiny or off-topic.

## Chain harvest recipe (SMELL LIST chain stores — feature-d amendment 4, started 2026-09-03)

Chain/department stores enter `data/stores.json` through `brands_file: "chains/<id>.json"`, an object-form file
`build_stores.py` validates (schema below). The list is what the retailer's own perfume department shows for a
NAMED DOOR with the site's in-store availability filter ticked — brand-level near-inventory, read by a person in a
real browser. Never a scraper script, never the retailer's JSON endpoint (typing a URL the site itself wrote, e.g.
`?store=349&storeAvailability=349`, is reading a rendered page; constructing or replaying `/api/...` is not).
Budget per chain per door: ≤5 navigations + ≤~10 hand-made filter toggles, ≥5 s apart, no loops. Never bypass a
bot challenge or CAPTCHA, never log in, never type personal data (a zip in a public store locator is the only text
typed). fragrantica.com is never touched, not even to cross-check a list. `ignore` is for house lines / sets only;
every other retailer string stays in the file and either matches the dataset or is reported UNMATCHED — never
hand-prune "non-perfume-looking" brands (Clinique, Kiehl's, L'Occitane all make perfume; the dataset decides).

```json
{"store": "<stores.json id>",
 "method": "in_store_facet | grid_read | online_catalog | paste",
 "locations": [
   {"name": "<door name, verbatim from the site; clusters keep '& nearby'>", "store_id": "<site's numeric id>",
    "cluster": false,
    "urls": ["<every department URL read, with the site-written store params>"],
    "facet": "<facet group → option used>", "shown": <brand count the facet displayed>,
    "baseline_items": [<items before store filter>, <after>],
    "reads": ["YYYY-MM-DD", ...],
    "brands": ["<retailer strings exactly as rendered, ™/® included>"]}
 ],
 "aliases": {"<retailer string>": "<dataset brand>"},
 "ignore": ["<house line or set name>"]}
```
Rules enforced by build_stores: `store` == entry id; `method` in the enum; every location has name/urls/reads;
`as_of` is DERIVED as max(reads)[:7] (a chain entry must not carry its own); the entry's `area` must equal the
location names joined by ` + ` (an optional trailing parenthetical such as "(website brand list)" is allowed for
non-facet methods); aliases are 1→1 and an alias whose target does not resolve fails the build (ALIAS-MISS);
match rate = matched distinct retailer strings / distinct strings after `ignore`, ≥60%. Post-visit corrections go
in the stores.json entry's `brands_extra` / `brands_exclude` with a sibling `notes` map ("seen YYYY-MM-DD <door>"),
never into the harvested file. Re-read a door when a visit finds ≥3 missing brands or after 6 months; compare the
page's own item counts against `baseline_items` to tell "site changed" from "inventory changed".

### Nordstrom (`nordstrom-la`) — method in_store_facet — VERIFIED 2026-09-03
- Department pages: `/browse/beauty/fragrance/perfume` (site title "Women's Perfumes", but the brand facet carries
  men's/unisex houses too — John Varvatos, MCM, Le Labo) and `/browse/men/grooming/cologne` ("Cologne for Men",
  lives under Men, not Beauty). `/browse/beauty/fragrance/cologne` does NOT exist (404). Other fragrance
  sub-departments (gift-sets, rollerball, body-hair-mist, bath-body) are not read.
- Facet: rail group "Ready today" → checkbox `name="pick-up-today"` = THIS DOOR (URL gains
  `store=<id>&storeAvailability=<id>`, page text "Pick up at The Grove"). `pick-up-tomorrow` is NOT door-level: it
  switches to `postalCode=90015&postalCodeAvailability=90015` (zip-area availability, 1,899 items vs 659) — do not
  use it for a door read. `same-day-delivery` irrelevant.
- Store ids: The Grove = 349 (geo-default from zip 90015), Century City = 384 (The Americana at Brand = 340).
  Chooser: the button whose text is the current store name (inside the "Ready today" rail region) opens "Set your
  location" (dialog: zip box `#zipCode`, radios `#store-selection-<id>`, button "Set Your Location"); pick a radio,
  press Set Your Location, the page reloads results for that door and keeps `pick-up-today` ticked.
- Quirk: after a direct URL load or a store switch the checkbox can show ticked while the grid is still the
  unfiltered 2,865 — untick and re-tick `pick-up-today`, wait ~7 s, and confirm the item count dropped before
  reading the Brand facet. 2026-09-03 baselines: perfume 2,865 → 659 (Grove) / 672 (Century City); cologne
  1,256 → 354 (Grove) / 295 (Century City). Brand facet sizes: Grove 77 + 48, Century City 82 + 49.
- Brand facet: rail group "Brand" (button aria-label "Select Brand"), fully enumerated as checkboxes
  `name="brand/<Retailer String>"` — 77 at The Grove women's perfume on 2026-09-03 (2,865 items → 659 with today).
- Environment: the Browser pane renders non-composited (blank screenshots); facet controls were driven by DOM
  `.click()` on the same checkbox a person taps; refs go stale on this SPA. Direct URLs with store params load the
  page but do NOT tick the checkbox — tick it, then read.

### Sephora (`sephora`) — method in_store_facet, CLUSTER — VERIFIED 2026-09-03 (real Chrome, not the pane)
- Pages: `/shop/perfume` ("Perfume & Perfumes for Women", 1,010) and `/shop/cologne` ("Cologne for Men", 428).
- The Browser pane cannot render Sephora's facet/grid (virtualized); the Claude-in-Chrome surface (a real,
  composited Chrome window) can. A "Sign In" nag with browser-autofilled credentials pops a few seconds after
  every page load and again after some clicks — close it with its X, never touch the fields.
- Store: the header "Shop Store & Delivery" chooser and the "In Store: … ⌄" chevron both open "Choose a Store",
  which turned into the Sign In modal on all three tries (anonymous visitors cannot change store). The
  geo-default cluster was therefore kept: **USC VILLAGE & nearby, `filters[Pickup]=2072`** (a cluster; Sephora-
  at-Kohl's doors count). A signed-in reader could re-do this for The Grove-area / Century City-area clusters.
- Facet: the rail's Brand group shows 10 + "Show more"; "Show more" opens the full "Filter & Sort" dialog whose
  Brand list is complete (85 perfume / 40 cologne unfiltered) — press "View A-Z" to sort. Tick the dialog's
  `filters[Pickup]=2072` checkbox (URL gains `?ref=filters[Pickup]=2072`), wait ~6 s, confirm the count drops
  (perfume 1,010 → 668, cologne 428 → 275), then read the Brand list again: 64 / 27 strings.
- Aliases (7): Armani Beauty → Giorgio Armani, EILISH FRAGRANCES → Billie Eilish, KILIAN Paris → By Kilian,
  Marc Jacobs Beauty → Marc Jacobs, NEST New York → Nest, Rare Beauty by Selena Gomez → Rare Beauty, World of
  Chris Collins → Chris Collins. `ignore`: "Sephora Favorites" (a set line). 48 brands matched (75%). Unmatched
  are absent from the dataset (Fenty, Huda, Gisou, Touchland, Summer Fridays, Nette, LoveShackFancy, …).

### Bloomingdale's (`bloomingdales-la`) — method in_store_facet — VERIFIED 2026-09-03 (real Chrome)
- The 2026-09-03 "Access Denied" was pane-specific; the real Chrome window loads the site with no challenge.
- The perfume category (`/shop/makeup-perfume-beauty/luxury-perfume?id=1005889`, 1,794 → 1,816 items once a
  store is set) has NO pickup facet (Brand, Gender, Sales & Offers, Item Type, Price, Fragrance Notes only).
  The door read comes from the site's own Store Pickup listing instead: header "Your store" → "Change store"
  → "Set Century City As My Store" (Century City = site id **363**; geo-default was Beverly Connection), then
  the flyout's "Shop free store pickup" link → `/shop/pickup-delivery/Upc_bops_purchasable/<id>` ("Shopping at
  Century City (20,998)"), Item Type facet → **Fragrance (776)**, then the Brand facet (fully enumerated with
  counts, 70 strings, 755 items). Final URL
  `/shop/pickup-delivery/Product_department,Upc_bops_purchasable/Fragrance,363?id=1132361&_additionalStoreLocations=363`.
- Facet dropdowns (`button#facet_<NAME>`, panel `.facet-dropdown-cont`, list `.checkBoxesContainer`) are
  internally scrolled; a scripted `.click()` on list text hit a mega-menu link once and navigated away — scroll
  the list, then click the checkbox itself. Aliases (5): Armani → Giorgio Armani, Bond No. 9 New York → Bond
  No 9, FERRAGAMO → Salvatore Ferragamo, ROJA → Roja Parfums, Sisley Paris → Sisley. 64 matched (93%).

### Macy's (`macys`) — method in_store_facet — VERIFIED 2026-09-03 (real Chrome; same platform as Bloomingdale's)
- Perfume category `/shop/beauty/fragrance/perfume?id=30087` has no pickup facet either. Same path: "Your
  store" → "Change Store" (needs a real click; a DOM `.click()` did nothing) → "Set As My Store" on **Macy's
  Beverly Center (id 5214)**, flyout "Shop Free Store Pickup" → `/shop/pickup-delivery/Upc_bops_purchasable/5214`
  ("Shopping at Macy's Beverly Center (9,555)"). Item Type has no "Fragrance" — tick **Perfume** then
  **Cologne** (URL `…/Perfume%7CCologne,5214…`), then read Brand: 26 strings, 66 items.
- Quirk to watch: the Item Type facet advertised Perfume (253) / Cologne (160) before ticking but the ticked
  listing reports 51 / 15. The pre-tick counts seem to include items that are not pickup-purchasable at this
  door; the ticked listing is what the site stands behind. Beverly Center is a small Macy's — weak signal,
  re-read after a visit. Alias: Armani → Giorgio Armani. 26 matched (100%); list is mass-market heavy
  (Kylie Cosmetics, philosophy, KIKO Milano, Juicy Couture…).

### Ulta Beauty (`ulta`) — method in_store_facet, two doors — VERIFIED 2026-09-03 (real Chrome)
- Pages: `/shop/fragrance/womens-fragrance/perfume` (1,122) and `/shop/men/cologne` (636; the
  `/shop/fragrance/mens-fragrance/cologne` link redirects here and drops any `storeId`). The listing sits below
  a "We think you'll like" carousel — scroll before concluding the grid failed to load (it did load; the pane
  showed only the carousel and its accessibility tree crashes on a malformed price `label[for]`).
- Door filter: toolbar **"In Store"** toggle (`button.StoreFilter`, `aria-pressed`) → URL gains `?storeId=<id>`
  and the count buckets ("1100+ results" → "400+ results"). Store chooser = the "at <store> ⌄" text beside it →
  "Select Store" drawer → zip **90048** → radio → Continue (one press reloads the listing; the drawer sometimes
  re-renders empty — press the search arrow again). Geo-default was Azalea Regional Shopping Center (686).
  Doors read: **West Hollywood Gateway = 156**, **Westwood Village = 1315**.
- Brand facet: "Show filters (n)" drawer → Brand accordion → "See N more" (the DOM keeps the full list even
  while the drawer is closed; the accordion's leaf texts minus "N Products Available" are the strings).
  WeHo 79 perfume / 33 cologne strings; Westwood 77 / 31. Aliases (8): ARMANI → Giorgio Armani, Balmain Paris
  → Balmain, Beyoncé Parfums → Beyonce, DKNY → Donna Karan, Kate Spade New York → Kate Spade, Nemat → Nemat
  International, NEST New York → Nest, Paris Hilton Fragrances → Paris Hilton. 63 matched (74%); unmatched are
  celebrity/mass lines absent from the dataset (Ice Spice, Megan Thee Stallion, Khloé Kardashian, Snif-era
  indies, hair-care houses).

### Saks Fifth Avenue (`saks-bh`) — method online_catalog — READ 2026-09-03 (Browser pane, plain DOM)
- `saksfifthavenue.com` category pages have **no in-store availability facet at all** (rail = Category,
  Designer, Price, Type, Sale, Scent, New, Promotion; BOPIS is per-product), so a door-level read is impossible
  and the entry is the website brand list — `area: "Beverly Hills (website brand list)"` per the amendment.
- Pages: `/c/beauty/view-all-beauty/fragrance` ("Women's Designer Fragrance", 2,856; also carries candles,
  diffusers and body care, so home-fragrance houses appear) and `/c/men/grooming-cologne/cologne` (1,177).
  Designer facet (`fieldset.refinement-id-brand`) is fully enumerated with counts: 123 / 100 strings.
- Aliases (12): ARMANI BEAUTY → Giorgio Armani, Bohoboco Perfume → Bohoboco, Bond No.9 New York → Bond No 9,
  Casamorati → Casamorati 1888, Floris London → Floris, Houbigant Paris → Houbigant, LOEWE Perfumes → Loewe,
  NEST New York → Nest, Orientica Parfums → Orientica, ROJA → Roja Parfums, Shalini Parfum → Shalini,
  Sisley-Paris → Sisley. 97 matched (80%). If Saks ever adds a store facet (Saks Global now owns Neiman, whose
  site has one), switch this entry to `in_store_facet`.

### Neiman Marcus (`neiman-marcus-bh`) — method in_store_facet — VERIFIED 2026-09-03
- Fragrance department = ONE page: `/c/beauty-fragrance-perfume-cat10470746` ("Women's Designer Perfume
  Collection", 2,814 items); the site's "Cologne Fragrance" / "Eau de Toilette" links all point to the same
  category, so there is no separate men's page. Category ids guessed from memory redirect to unrelated
  categories (shoes, women's clothing) — always enter via the Beauty nav (`/c/beauty-cat000285` →
  `/c/beauty-all-beauty-cat55180733` → Fragrance `/c/beauty-fragrance-cat10470744` → Perfume).
- Facets live in a drawer behind the "FILTER" button (text "FILTER BY:" while open) and apply only on "DONE".
  Group "Get It Fast" → "Store Pickup at Beverly Hills: Today (order by 12pm)" = checkbox `value="csp"` (the
  store is the header's preselected door; "sdd"/"ndd" are shipping options). After DONE the URL carries
  `?get-it-fast=%7C10%7C%7C` (10 = Beverly Hills). Group "Designer" is fully enumerated with per-designer counts
  (`Name(n)` lines); 62 designers / 1,120 items under the pickup filter on 2026-09-03 (Acqua di Parma 48,
  TOM FORD 90, CREED 69, GUERLAIN 64, Jo Malone London 66, MFK 66, Parfums de Marly 56…).
- Aliases used (9): ARMANI beauty → Giorgio Armani, Bond No.9 New York → Bond No 9, Casamorati → Casamorati
  1888, Houbigant Paris → Houbigant, NEST New York → Nest, Orientica Parfums → Orientica, ROJA → Roja Parfums,
  Sisley Paris → Sisley, Yves Saint Laurent Beaute → Yves Saint Laurent. Absent from the dataset: Aman,
  Brunello Cucinelli, Clé de Peau Beauté, U Beauty, Victoria Beckham. Note: the dataset still splits
  `Roja Parfums` / `Roja Dove` — a fold candidate for the next designer-house pass.
- No bot challenge; the pane's non-composited rendering did not matter here (facets are plain DOM).
