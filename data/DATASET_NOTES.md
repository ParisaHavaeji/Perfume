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

`QUARANTINE_SCRIPTED_PARFUMO = True` in `build_dataset.py` drops both
scripted-parfumo sources (`parfumo_gap.jsonl`, `parfumo_new.jsonl`) whole at
build time. This removed those perfumes from the game entirely — wrong notes
in a note-guessing game are worse than absent perfumes.

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
- [ ] **S2. Filter suppressed variants out of the host search box.**
  `public/game.js searchPerfumes` scans the raw search index; none of the
  4,839 `dedup.json` suppressions apply there, so every known duplicate
  variant shows in the dropdown — the most visible duplicate surface in the
  product. Ship the suppress id-set alongside the index (or an `x:1` flag on
  suppressed entries) and add one filter line. Highest payoff-per-line item
  in this whole plan.

## Phase 2 — one batched pipeline rerun

Batch S3–S7 into a single rebuild: every rerun renumbers ids and triggers the
full flush/re-warm/seed checklist, so pay that cost once.

- [ ] **S3. Expand `BRAND_KEY_ALIASES`** (currently 2 entries). ~79
  containment brand-key pairs share ≥3 identical perfume names ≈ ~1,200
  duplicate rows (j): alharamain/alharamainperfumes (129 shared names),
  iprofumidifirenze/spezierie… (66), rojadove/rojaparfums (60),
  miltonlloyd/… (58), afnan/afnanperfumes (56), jomalone/jomalonelondon (41),
  zoologist/zoologistperfumes (34), bykilian/kilian (27), … Generate the
  containment list mechanically, review by hand, add the approved pairs.
- [ ] **S4. Line-prefix variant folding in `build_dedup`** — a new tier
  alongside the format-suffix pass: same brand, one name-key a suffix of the
  other ("Armani Privé - Iris Céladon" vs "Iris Celadon", "Olfactories -
  Tainted Love" vs "Tainted Love"), gated on ≥80% note overlap. ~690 pairs
  (j) — the "Ch. 1 -" class, which no url/fid/exact-name key can see.
  **Soft-suppress only** (dedup.json), never hard-delete.
- [ ] **S5. Dual-emit `fid` AND `url` in shards** (`clean_dataset.py:517`
  elif → both; ~6,356 rows affected, +2.7% shard size, verified safe for
  images/client (j)). Atomically with it: build `seed_images.js` liveKeys
  from every url-bearing entry regardless of fid (else the orphan report
  flags in-use seeds); document image precedence (seed-by-url → fid → page
  scrape) in `images.js download()`; and swap `data.js:87`'s O(n)
  `searchIndex.find` for `searchIndex[id]`.
- [ ] **S6. Provenance dict in `build_dataset.py`:** `SOURCE_TRUST = {raw
  file → trusted | third-party-scrape | quarantined | verified}` mirroring
  the table at the top of this file (with TidyTuesday = third-party-scrape).
  Each loader stamps `p["trust"]`; one filter at the end of `main()` drops
  non-shippable levels with printed counts. This replaces
  `QUARANTINE_SCRIPTED_PARFUMO` and the scattered loader early-returns, and
  is where `PARFUMO_SUPERSEDED` logic can consolidate. Later, the
  `unionNotes`/decoy-scan predicates keyed on `source == "parfumo"` should
  key on trust instead.
- [ ] **S7. New `verify.py` assertions:** urlKey uniqueness across all rows
  (the one enforceable identity invariant); the set of trust levels present
  in the build is exactly the shippable set; re-baseline the row-count and
  dedup-band thresholds after S3/S4 shift them; before/after canonical-brand
  diff in the rerun checklist (S3 + any merge can flip `unify_brands`
  most-common spellings).
- [ ] **S8. Run the full plan.md rerun checklist** (pipeline ×2
  byte-identical, verify green, flush cache, warm + seed, commit seed) and
  fix the README dataset counts (still quotes 71,772 / pre-quarantine
  numbers).

## Phase 3 — blocked on Parisa's decisions

- [ ] **S9. The $200 FragDB question — decide before any re-verification
  work.** Yes → buy, run the standing decoy re-scan, build one merge lane;
  the browser re-verification lane is deleted unbuilt. No → build the
  re-verification lane per the protocol above, but pilot on ~30 rows first
  to validate the "browser fetches are clean" hypothesis (it currently rests
  on one manual fetch), and store retained HTML gzipped outside the deployed
  tree (or add the path to `render.yaml` buildFilter).
- [ ] **S10. rdemarqui xlsx merge last** (either branch). Before merging:
  measure its fid/url recovery rate and relax `verify.py:30`
  (every-perfume-has-an-image) to a floor (e.g. ≥95%), since its rows carry
  neither; expect its "17.7k new" to shrink once S3's aliases fold spelling
  variants; re-scan for new decoy tokens per the standing rule; and note it
  shifts `notes_vocab.json` tier counts and any committed ML metrics, so
  land it before the plan.md M1 baselines, not after.

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

## The one worth taking: rdemarqui's Fragrantica xlsx (~17.7k new, free)

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
