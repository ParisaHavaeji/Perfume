"""Normalize data/perfumes.json and emit the browser-ready files in data/out.

Steps:
  1. Canonicalize note names (case/punctuation variants + a small synonym map).
  2. Clean Parfumo/Luckyscent display names (split off brand, year, concentration).
  3. Unify brand spellings across sources.
  4. Dedupe, sort by popularity, assign ids.
  5. Emit search_index.json, notes/<n>.json shards, and notes_vocab.json.
"""
import json
import os
import re
from bisect import bisect_right
from collections import Counter, defaultdict

from textnorm import ascii_fold, brand_key, norm_key

DATA = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DATA, "out")
SHARD_SIZE = 1000

# ---------------------------------------------------------------- note names

# cross-source synonyms: note_key -> canonical note_key.
# Deliberately cautious; broad merges misfire (Incense is not Frankincense).
SYNONYM_KEYS = {
    "oud": "agarwood oud",
    "agarwood": "agarwood oud",
    "ambrette musk mallow": "ambrette",
    "musk mallow": "ambrette",
    "lily of the valley muguet": "lily of the valley",
    "muguet": "lily of the valley",
    "lime linden blossom": "linden blossom",
    "lime linden": "linden blossom",
    "linden": "linden blossom",
    "szechuan pepper": "sichuan pepper",
    "carambola star fruit": "star fruit",
    "carambola": "star fruit",
    "cacao": "cocoa",
    "vanille": "vanilla",
    "blackcurrant": "black currant",
    "black currant leaf": "black currant leaves",
    "cistus labdanum": "labdanum",
    "cistus": "labdanum",
    "rockrose": "labdanum",
    "orris root": "orris",
    "iris root": "orris",
    "hedione jasmine": "hedione",
    "frankincense olibanum": "frankincense",
    "olibanum": "frankincense",
    "vetyver": "vetiver",
    "neroli orange blossom": "neroli",
    "petitgrain bigarade": "petitgrain",
    "tonka": "tonka bean",
    "coumarin tonka": "tonka bean",
}

# where the most-common spelling isn't the one we want
DISPLAY_OVERRIDES = {
    "agarwood oud": "Oud (Agarwood)",
    "lily of the valley": "Lily of the Valley",
    "frankincense": "Frankincense",
}


def note_key(s):
    s = ascii_fold(s).lower().replace("-", " ").replace("_", " ")
    s = re.sub(r"[^\w\s]", " ", s)
    k = re.sub(r"\s+", " ", s).strip()
    return SYNONYM_KEYS.get(k, k)


def canonicalize_notes(perfumes):
    # canonical display form per key = most common spelling (capitalized wins ties)
    surface = defaultdict(Counter)
    for p in perfumes:
        for tier_notes in p["notes"].values():
            for n in tier_notes:
                surface[note_key(n)][n] += 1

    canonical = {}
    for k, spellings in surface.items():
        if k in DISPLAY_OVERRIDES:
            canonical[k] = DISPLAY_OVERRIDES[k]
            continue
        best = max(spellings.items(), key=lambda kv: (kv[1], kv[0][:1].isupper()))[0]
        canonical[k] = best[0].upper() + best[1:] if best[:1].islower() else best

    n_before = len({n for p in perfumes for t in p["notes"].values() for n in t})
    for p in perfumes:
        for tier, tier_notes in p["notes"].items():
            seen, cleaned = set(), []
            for n in tier_notes:
                c = canonical[note_key(n)]
                if c not in seen:
                    seen.add(c)
                    cleaned.append(c)
            p["notes"][tier] = cleaned
    n_after = len({n for p in perfumes for t in p["notes"].values() for n in t})
    print(f"note vocab: {n_before} -> {n_after}")


# ------------------------------------------------------------- display names

CONCENTRATIONS = [
    "Esprit de Parfum", "Eau de Parfum Intense", "Extrait de Parfum",
    "Eau de Parfum", "Eau de Toilette", "Eau de Cologne", "Eau Fraiche",
    "Eau Fraîche", "Extrait", "Elixir", "Parfum", "Cologne", "Perfume Oil",
    "Attar", "Eau de Senteur", "Hair Mist", "Body Mist", "Aftershave",
    "After Shave", "Solid Perfume",
]
YEAR = re.compile(r"^(18[5-9]\d|19\d\d|20[0-2]\d)$")
# a strip that leaves the name ending like this cut into a real product name -> revert
DANGLE = re.compile(r"(?i)(\b(de|du|des|della|di|eau|pour|for|and|with|no\.?)|d'|l'|&|-)\s*$")


def strip_suffix(name, suffix):
    """Remove suffix from the end of name if that leaves a sane name, else None."""
    if not suffix or len(name) <= len(suffix) or not name.lower().endswith(suffix.lower()):
        return None
    cand = name[: -len(suffix)].strip(" -–")
    return cand if cand and not DANGLE.search(cand) else None


def clean_name(name, brand, known_conc, strip_year):
    """Split "<Name> <Brand> <Year> <Concentration>" into its parts."""
    concentration = year = None
    changed = True
    while changed:
        changed = False
        if concentration is None:
            # trust the source's concentration field first, guess from a list otherwise
            for c in [known_conc] if known_conc else CONCENTRATIONS:
                cand = strip_suffix(name, c)
                if cand:
                    name, concentration, changed = cand, c, True
                    break
        tokens = name.split()
        if strip_year and len(tokens) > 1 and YEAR.match(tokens[-1]):
            cand = " ".join(tokens[:-1]).strip(" -–")
            if cand and not DANGLE.search(cand):
                name, year, changed = cand, int(tokens[-1]), True
        cand = strip_suffix(name, brand.strip())
        if cand:
            name, changed = cand, True
    return name.strip(" -–") or name, concentration, year


def clean_names(perfumes):
    renamed = 0
    for p in perfumes:
        if p["source"] == "fragrantica":
            continue  # names derived from URL slugs, already bare
        name, conc, year = clean_name(
            p["name"], p["brand"], p["concentration"],
            # Luckyscent names legitimately end in years ("03 Apr 1968"); Parfumo's are junk
            strip_year=p["source"] == "parfumo",
        )
        renamed += name != p["name"]
        p["name"] = name
        p["concentration"] = conc or p["concentration"]
        p["year"] = p["year"] or year
    print(f"names cleaned: {renamed}")


# ------------------------------------------------------------------- brands

# Hand aliases where the most common spelling across sources isn't the right
# display form (cf. DISPLAY_OVERRIDES for notes). Keyed by brand_key.
BRAND_DISPLAY_OVERRIDES = {
    "dsdurga": "D.S. & Durga",
}


def unify_brands(perfumes):
    groups = defaultdict(Counter)
    for p in perfumes:
        groups[brand_key(p["brand"])][p["brand"]] += 1

    # fold tiny digit-suffixed variants ("trudon1" from duplicate sitemap slugs)
    alias = {}
    for k, c in groups.items():
        m = re.fullmatch(r"(.+?)\d", k)
        if m and m.group(1) in groups and sum(c.values()) <= 3 <= sum(groups[m.group(1)].values()):
            alias[k] = m.group(1)
    for k, target in alias.items():
        groups[target] += groups[k]

    canon = {k: c.most_common(1)[0][0] for k, c in groups.items() if k not in alias}
    for k, target in alias.items():
        canon[k] = canon[target]
    for k, name in BRAND_DISPLAY_OVERRIDES.items():
        if k in canon:
            canon[k] = name
        else:
            print(f"brand override key not in dataset: {k}")

    fixed = 0
    for p in perfumes:
        best = canon[brand_key(p["brand"])]
        fixed += best != p["brand"]
        p["brand"] = best
    multi = sum(1 for k, c in groups.items() if k not in alias and len(c) > 1)
    print(f"brand spellings unified: {fixed} entries across {multi} multi-spelling brands")


# ------------------------------------------------------------------ dedup map

# Concentration values that mark the same juice in another strength or delivery
# format; rows differing only by these merge into one SMELL LIST card. A closed
# list on purpose: any other value (Elixir, Intense, Extrême, Absolu, Attar, …)
# is a flanker with its own composition and stays its own card.
MERGEABLE_CONC_KEYS = {norm_key(c) for c in [
    "Eau de Toilette", "Eau de Parfum", "Parfum", "Perfume", "Pure Perfume",
    "Pure Parfum", "Extrait", "Extrait de Parfum", "Parfum de Toilette",
    "Esprit de Parfum", "Eau de Cologne", "Cologne", "Toilet Water",
    "Perfume Oil", "Huile de Parfum", "Huile Parfum", "Solid Perfume",
    "Parfum Solide", "Profumo Solido", "Solid Fragrance", "Concreta",
    "Liquid Balm", "Hair Mist", "Brume Cheveux", "Parfum Cheveux",
    "Hair Perfume", "Hair Fragrance", "Body Mist", "Body Spray",
    "Body Splash", "Fragrance Mist", "All-Over Spray", "Brume Parfumee",
    "After Shave", "After-Shave Lotion", "Lotion Apres-Rasage",
    "Apres-Rasage", "Rasierwasser", "Lozione Dopobarba",
]}

# Name suffixes that mark a delivery-format twin of an existing base perfume
# ("Neroli 36 Perfume Oil" next to "Neroli 36"). Plain concentrations never
# belong here: a page named "X Eau de Parfum" is a distinct flanker.
TIER2_FORMAT_KEYS = sorted({norm_key(s) for s in [
    "Perfume Oil", "Huile de Parfum", "Solid Perfume", "Liquid Balm",
    "Hair Mist", "Body Mist", "Body Spray", "Hair & Body Mist",
    "Hair and Body Mist", "Fragrance Mist", "Hair Perfume",
    "Hair Fragrance", "Body Splash",
]}, key=len, reverse=True)

SLUG_YEAR = re.compile(r"(?:^|[_-])((?:18|19|20)\d\d)(?=[_-]|$)")


def slug_year(p):
    """Release year embedded in a Parfumo URL slug. The year FIELD on parfumo
    rows is unreliable (poisoned unauthenticated fetches randomize it); the
    slug is page identity and can't be."""
    if p["source"] != "parfumo" or not p.get("url"):
        return None
    years = SLUG_YEAR.findall(p["url"].rstrip("/").rsplit("/", 1)[-1])
    return int(years[-1]) if years else None  # a name-embedded number ("1881") comes first


def split_by_era(rows):
    """Split same-name rows whose Parfumo slugs pin different release years
    (Gucci pour Homme 1976 vs 2003). Slug-less rows attach to the nearest
    year via their own year field (tie -> older), else to the subgroup
    holding the lowest placed id."""
    slug = {p["id"]: slug_year(p) for p in rows}
    eras = sorted({y for y in slug.values() if y})
    if len(eras) < 2:
        return [rows]
    subs = {y: [] for y in eras}
    unplaced = []
    for p in rows:
        y = slug[p["id"]]
        if y is None and p["year"] is not None:
            y = min(eras, key=lambda e: (abs(e - p["year"]), e))
        if y is None:
            unplaced.append(p)
        else:
            subs[y].append(p)
    if unplaced:
        first = min((min(q["id"] for q in ps), y) for y, ps in subs.items() if ps)[1]
        subs[first].extend(unplaced)
    return [subs[y] for y in eras]


def build_dedup(perfumes):
    """Map duplicate-variant id -> canonical id for the SMELL LIST layer.
    Suppressed rows keep their ids everywhere (shards, images, game); only
    /list hides them. Tier 1: same brand + name key. Tier 2: delivery-format
    name suffix folding into an existing same-brand base. Groups subdivide by
    non-mergeable concentration and by slug-pinned era before picking."""
    groups = defaultdict(list)
    for p in perfumes:
        groups[(p["brand"], norm_key(p["name"]))].append(p)

    fmt_suffixed = set()
    for brand, nk in sorted(groups):
        for fmt in TIER2_FORMAT_KEYS:
            if nk.endswith(fmt) and len(nk) > len(fmt) and (brand, nk[: -len(fmt)]) in groups:
                for p in groups.pop((brand, nk)):
                    fmt_suffixed.add(p["id"])
                    groups[(brand, nk[: -len(fmt)])].append(p)
                break

    suppress = {}
    for members in groups.values():
        subs = defaultdict(list)
        for p in members:
            ck = norm_key(p["concentration"] or "")
            subs[ck if ck and ck not in MERGEABLE_CONC_KEYS else ""].append(p)
        for rows in subs.values():
            for era_rows in split_by_era(rows):
                if len(era_rows) < 2:
                    continue
                canon = min(era_rows, key=lambda p: (
                    p["id"] in fmt_suffixed,  # the surviving card must carry the base name
                    p["rating"] is None or (p["ratingCount"] or 0) < 5,
                    p["source"] != "fragrantica",
                    p["id"],
                ))
                for p in era_rows:
                    if p is not canon:
                        suppress[p["id"]] = canon["id"]
    return suppress


# ---------------------------------------------------------------- output

def dedupe_and_rank(perfumes):
    by_key = {}
    order = []
    for p in perfumes:
        key = (brand_key(p["brand"]), norm_key(p["name"]), norm_key(p["concentration"] or ""))
        old = by_key.get(key)
        if old is None:
            by_key[key] = p
            order.append(key)
        elif (p["source"] == "fragrantica", p["ratingCount"] or 0) > (
            old["source"] == "fragrantica", old["ratingCount"] or 0
        ):
            by_key[key] = p
    deduped = [by_key[k] for k in order]
    print(f"re-dedupe: {len(perfumes)} -> {len(deduped)}")

    deduped.sort(key=lambda p: -(p["ratingCount"] or 0))  # popular first, for the dropdown
    for i, p in enumerate(deduped):
        p["id"] = i
    return deduped


def display_name(p):
    return f"{p['name']} ({p['concentration']})" if p["concentration"] else p["name"]


def emit(perfumes):
    os.makedirs(os.path.join(OUT, "notes"), exist_ok=True)

    index = [
        {
            "i": p["id"],
            "n": display_name(p),
            "b": p["brand"],
            "y": p["year"],
            "s": {"pyramid": "p", "flat": "f", "partial": "x"}[p["structure"]],
        }
        for p in perfumes
    ]
    with open(os.path.join(OUT, "search_index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)

    shards = defaultdict(dict)
    for p in perfumes:
        entry = {
            "notes": p["notes"],
            "structure": p["structure"],
            "name": display_name(p),
            "brand": p["brand"],
        }
        if p.get("fid"):
            entry["fid"] = p["fid"]  # image: https://fimgs.net/mdimg/perfume/375x500.<fid>.jpg
        elif p.get("url"):
            entry["url"] = p["url"]  # image via og:image on this page, fetched server-side
        shards[p["id"] // SHARD_SIZE][str(p["id"])] = entry
    for shard_id, content in shards.items():
        with open(os.path.join(OUT, "notes", f"{shard_id}.json"), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False)

    tier_counts = defaultdict(lambda: {"top": 0, "middle": 0, "base": 0, "flat": 0, "total": 0})
    for p in perfumes:
        for tier, tier_notes in p["notes"].items():
            for n in tier_notes:
                tier_counts[n][tier] += 1
                tier_counts[n]["total"] += 1
    vocab = sorted(({"note": n, **c} for n, c in tier_counts.items()), key=lambda x: -x["total"])
    with open(os.path.join(OUT, "notes_vocab.json"), "w", encoding="utf-8") as f:
        json.dump(vocab, f, ensure_ascii=False)

    # find_meta.json (server-only): per-id rating meta for the SMELL LIST page.
    # null = no rating (all luckyscent); else [raw, scale_max, percentile] where the
    # percentile is per-source rank 0-1000 over gated entries (ratingCount >= 5),
    # p = round(1000 * |{gated same-source entries with rating <= r}| / N),
    # and null below the gate — a 5.0 with 3 votes must not outrank a 4.6 with 9,000.
    scales = {"fragrantica": 5, "parfumo": 10}
    gated = {src: sorted(p["rating"] for p in perfumes if p["source"] == src
                         and p["rating"] is not None and (p["ratingCount"] or 0) >= 5)
             for src in scales}
    meta = []
    for p in perfumes:
        s = scales.get(p["source"])
        r = p["rating"]
        if s is None or r is None:
            meta.append(None)
        elif (p["ratingCount"] or 0) >= 5:
            rs = gated[p["source"]]
            meta.append([r, s, round(1000 * bisect_right(rs, r) / len(rs))])
        else:
            meta.append([r, s, None])
    with open(os.path.join(OUT, "find_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)

    # dedup.json (server-only): suppressed variant id -> canonical id, plus the
    # suppressed ids whose notes still count for their canonical (unionNotes).
    # Parfumo members are excluded from the union until the poisoning call is
    # made — their note lists may carry fabricated decoys.
    dedup = build_dedup(perfumes)
    union = [i for i in sorted(dedup) if perfumes[i]["source"] != "parfumo"]
    with open(os.path.join(OUT, "dedup.json"), "w", encoding="utf-8") as f:
        json.dump({"suppress": {str(i): dedup[i] for i in sorted(dedup)},
                   "unionNotes": union}, f, separators=(",", ":"))
    print(f"dedup.json: {len(dedup)} variant rows suppressed, {len(union)} note-unioned")

    for label, path in [("search_index.json", os.path.join(OUT, "search_index.json")),
                        ("notes_vocab.json", os.path.join(OUT, "notes_vocab.json")),
                        ("find_meta.json", os.path.join(OUT, "find_meta.json"))]:
        print(f"{label}: {os.path.getsize(path) / 1e6:.2f} MB")
    shard_bytes = sum(os.path.getsize(os.path.join(OUT, "notes", fn))
                      for fn in os.listdir(os.path.join(OUT, "notes")))
    print(f"notes shards: {shard_bytes / 1e6:.2f} MB in {len(shards)} files")


def main():
    src = os.path.join(DATA, "perfumes.json")
    with open(src, encoding="utf-8") as f:
        perfumes = json.load(f)

    canonicalize_notes(perfumes)
    clean_names(perfumes)
    unify_brands(perfumes)
    perfumes = dedupe_and_rank(perfumes)

    with open(src, "w", encoding="utf-8") as f:
        json.dump(perfumes, f, ensure_ascii=False)
    emit(perfumes)
    print(f"final: {len(perfumes)} perfumes")


if __name__ == "__main__":
    main()
