"""Merge the raw perfume sources into data/perfumes.json.

Sources, in priority order (first one to claim a brand+name wins):
  1. Fragrantica (raw/fra_perfumes.csv) — notes parsed from the description text
  2. Parfumo    (raw/parfumo_tidytuesday.csv) — structured note columns
  3. Luckyscent (raw/luckyscent_notes.jsonl) — flat notes from our own crawl
  4. Fragrantica refresh (raw/fragrantica_new.jsonl) — 2024+ releases, own crawl
     via fragrantica_refresh.py (last so it only fills the gap)
  5. Parfumo gap crawl (raw/parfumo_gap.jsonl) — 2024+ releases Fragrantica
     won't serve us, crawled from Parfumo via parfumo_gap.py
  6. Parfumo live adds (raw/parfumo_new.jsonl) — pages the game host pasted
     mid-game, fetched by server/parfumo.js
  7. Scent Room (raw/scentroom_catalog.jsonl) — The Scent Room LA's Shopify
     catalog via scentroom_refresh.py; only records not already in the
     dataset at crawl time (dup: false) merge
  8. Malin+Goetz (raw/malingoetz_catalog.jsonl) — the brand's own fragrance
     pages via malingoetz_refresh.py (the malin-goetz flagship assortment;
     absent from every other source)

Run clean_dataset.py afterwards to normalize and emit the browser-ready files.
"""
import json
import os
import re
from collections import Counter, defaultdict

import pandas as pd

from poison import is_poisoned
from textnorm import brand_key, norm_key, split_notes, titlecase_slug

DATA = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(DATA, "raw")

FRA_URL = re.compile(r"/perfume/([^/]+)/([^/]+)-(\d+)\.html")
FRA_TIER = re.compile(r"(?P<tier>[Tt]op|[Mm]iddle|[Bb]ase) notes? (?:are|is) (?P<notes>[^;.]*)")
FRA_YEAR = re.compile(r"launched in (\d{4})")

# obvious non-perfume Luckyscent products
NON_PERFUME = re.compile(
    r"travel-spray|travel-size|refill|tester|-sample|discovery|gift|candle|"
    r"body-|hair-|-soap|shower|lotion|notecard|home-|room-spray|diffuser|deodorant"
)


def tiers_to_entry(tiers):
    """Structure/notes fields from a {top, middle, base} dict of note lists.

    A single populated tier means the source shows a flat note list, not a pyramid.
    """
    filled = sum(1 for v in tiers.values() if v)
    if filled == 1:
        return "flat", {"flat": tiers["top"] or tiers["middle"] or tiers["base"]}
    return ("pyramid" if filled == 3 else "partial"), dict(tiers)


def load_fragrantica():
    df = pd.read_csv(os.path.join(RAW, "fra_perfumes.csv")).rename(
        columns={"Rating Value": "rating", "Rating Count": "rating_count"}
    )
    out = []
    for row in df.itertuples():
        m = FRA_URL.search(str(row.url))
        if not m:
            continue
        desc = str(row.Description) if pd.notna(row.Description) else ""
        tiers = {"top": [], "middle": [], "base": []}
        for tm in FRA_TIER.finditer(desc):
            tiers[tm.group("tier").lower()] = split_notes(tm.group("notes"))
        if not any(tiers.values()):
            continue  # no note data, useless for the game
        structure, notes = tiers_to_entry(tiers)
        ym = FRA_YEAR.search(desc)
        count = str(row.rating_count)
        out.append(
            {
                "name": titlecase_slug(m.group(2)),
                "brand": titlecase_slug(m.group(1)),
                "year": int(ym.group(1)) if ym else None,
                "gender": str(row.Gender).replace("for ", "") if pd.notna(row.Gender) else None,
                "source": "fragrantica",
                "structure": structure,
                "notes": notes,
                # bottle image: https://fimgs.net/mdimg/perfume/375x500.<fid>.jpg
                "fid": int(m.group(3)),
                "concentration": None,
                "rating": float(row.rating) if pd.notna(row.rating) else None,
                "ratingCount": int(count) if count.isdigit() else None,
            }
        )
    return out


def load_parfumo():
    df = pd.read_csv(os.path.join(RAW, "parfumo_tidytuesday.csv"))
    out = []
    for row in df.itertuples():
        tiers = {
            "top": split_notes(row.Top_Notes) if pd.notna(row.Top_Notes) else [],
            "middle": split_notes(row.Middle_Notes) if pd.notna(row.Middle_Notes) else [],
            "base": split_notes(row.Base_Notes) if pd.notna(row.Base_Notes) else [],
        }
        if not any(tiers.values()):
            continue
        # the CSV contains literal header-echo rows ("Name,Brand,...,Top Notes,...")
        if str(row.Name) == "Name" and str(row.Brand) == "Brand":
            continue
        structure, notes = tiers_to_entry(tiers)
        name = str(row.Name)
        # the TidyTuesday export split leading numerals off ("1 Million" -> "Million")
        if pd.notna(row.Number):
            name = f"{str(row.Number).strip()} {name}".strip()
        out.append(
            {
                "name": name,
                "brand": str(row.Brand),
                "year": int(row.Release_Year) if pd.notna(row.Release_Year) else None,
                "gender": None,
                "source": "parfumo",
                "structure": structure,
                "notes": notes,
                "url": str(row.URL) if pd.notna(row.URL) else None,  # for og:image lookup
                "concentration": str(row.Concentration) if pd.notna(row.Concentration) else None,
                "rating": float(row.Rating_Value) if pd.notna(row.Rating_Value) else None,
                "ratingCount": int(row.Rating_Count) if pd.notna(row.Rating_Count) else None,
            }
        )
    return out


def load_luckyscent():
    path = os.path.join(RAW, "luckyscent_notes.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("error") or not rec.get("notes") or NON_PERFUME.search(rec["slug"]):
                continue
            notes = []
            for n in rec["notes"]:
                # split compound "Cedar And Cashmere Wood" style entries
                for part in re.split(r"\s+[Aa]nd\s+", n):
                    part = part.strip()
                    if part and part not in notes:
                        notes.append(part)
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": None,
                    "gender": None,
                    "source": "luckyscent",
                    "structure": "flat",
                    "notes": {"flat": notes},
                    "url": f"https://www.luckyscent.com/products/{rec['slug']}",
                    "concentration": None,
                    "rating": None,
                    "ratingCount": None,
                }
            )
    return out


def load_fragrantica_refresh():
    """2024+ releases crawled by fragrantica_refresh.py (raw/fragrantica_new.jsonl)."""
    path = os.path.join(RAW, "fragrantica_new.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("error") or not rec.get("notes"):
                continue
            structure, notes = tiers_to_entry(rec["notes"])
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": rec["year"],
                    "gender": rec["gender"],
                    "source": "fragrantica",
                    "structure": structure,
                    "notes": notes,
                    "fid": rec["fid"],
                    "concentration": None,
                    "rating": rec["rating"],
                    "ratingCount": rec["votes"],
                }
            )
    return out


def load_parfumo_gap():
    """Batch gap-fill crawled from Parfumo (parfumo_gap.py, raw/parfumo_gap.jsonl)."""
    path = os.path.join(RAW, "parfumo_gap.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            notes = rec.get("notes")
            if not notes:
                continue
            if "flat" in notes:
                structure, notes = "flat", {"flat": notes["flat"]}
            else:
                structure, notes = tiers_to_entry(notes)
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": rec["year"],
                    "gender": rec.get("gender"),
                    "source": "parfumo",
                    "structure": structure,
                    "notes": notes,
                    "url": rec["url"],  # for og:image lookup
                    # the fragrantica id the gap-matcher paired this page with —
                    # its bottle image is a plain CDN fetch, no page scrape
                    "fid": rec.get("fid"),
                    "concentration": None,
                    "rating": rec.get("rating"),
                    "ratingCount": rec.get("votes"),
                }
            )
    return out


def load_parfumo_new():
    """Live gap-fill adds from game night (server/parfumo.js, raw/parfumo_new.jsonl)."""
    path = os.path.join(RAW, "parfumo_new.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if not rec.get("notes"):
                continue
            structure, notes = tiers_to_entry(rec["notes"])
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": rec["year"],
                    "gender": rec["gender"],
                    "source": "parfumo",
                    "structure": structure,
                    "notes": notes,
                    "url": rec["url"],  # for og:image lookup
                    "concentration": None,
                    "rating": None,
                    "ratingCount": None,
                }
            )
    return out


def load_scentroom():
    """The Scent Room LA catalog (scentroom_refresh.py, raw/scentroom_catalog.jsonl).
    Records marked dup were in the dataset at crawl time; only the rest merge."""
    path = os.path.join(RAW, "scentroom_catalog.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if rec["dup"] or not rec["notes"]:
                continue
            if "flat" in rec["notes"]:
                structure, notes = "flat", {"flat": rec["notes"]["flat"]}
            else:
                structure, notes = tiers_to_entry(rec["notes"])
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": None,
                    "gender": None,
                    "source": "scentroom",
                    "structure": structure,
                    "notes": notes,
                    "url": f"https://www.thescentroom.com/products/{rec['handle']}",
                    "concentration": rec["concentration"],
                    "rating": None,
                    "ratingCount": None,
                }
            )
    return out


def load_malingoetz():
    """Malin+Goetz's own fragrance pages (malingoetz_refresh.py,
    raw/malingoetz_catalog.jsonl). Name and concentration are pre-split by
    the crawler; notes are always tiered."""
    path = os.path.join(RAW, "malingoetz_catalog.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if not rec.get("notes"):
                continue
            structure, notes = tiers_to_entry(rec["notes"])
            out.append(
                {
                    "name": rec["name"],
                    "brand": rec["brand"],
                    "year": None,
                    "gender": None,
                    "source": "malingoetz",
                    "structure": structure,
                    "notes": notes,
                    "url": rec["url"],  # for og:image lookup
                    "concentration": rec["concentration"],
                    "rating": None,
                    "ratingCount": None,
                }
            )
    return out


def load_elorea():
    """Elorea's own product pages (elorea_refresh.py, raw/elorea_catalog.jsonl).
    The concentration goes back INTO the name (clean_name re-splits it): GIT and
    HAZY BLUE exist as EdP and Extrait with different pyramids, and the
    build-stage dedupe key is (brand, name) only — a bare name would silently
    drop one of the pair here instead of letting the dedup-map tiers rule."""
    path = os.path.join(RAW, "elorea_catalog.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            if not rec.get("notes"):
                continue
            structure, notes = tiers_to_entry(rec["notes"])
            name = rec["name"]
            if rec.get("concentration"):
                name = f"{name} {rec['concentration']}"
            out.append(
                {
                    "name": name,
                    "brand": rec["brand"],
                    "year": None,
                    "gender": None,
                    "source": "elorea",
                    "structure": structure,
                    "notes": notes,
                    "url": rec["url"],  # for og:image lookup
                    "concentration": rec["concentration"],
                    "rating": None,
                    "ratingCount": None,
                }
            )
    return out


def dedupe(perfumes):
    """Keep one entry per (brand, name); higher-priority source / more votes wins."""
    by_key = {}
    order = []
    for p in perfumes:
        key = (brand_key(p["brand"]), norm_key(p["name"]))
        old = by_key.get(key)
        if old is None:
            by_key[key] = p
            order.append(key)
        elif (p["ratingCount"] or 0) > (old["ratingCount"] or 0):
            by_key[key] = p
    return [by_key[k] for k in order], len(perfumes) - len(order)


def main():
    # the refresh goes last so it only adds what the older dumps are missing
    sources = [load_fragrantica(), load_parfumo(), load_luckyscent(), load_fragrantica_refresh(), load_parfumo_gap(), load_parfumo_new(), load_scentroom(), load_malingoetz(), load_elorea()]
    for chunk in sources:
        if chunk:
            print(f"{chunk[0]['source']}: {len(chunk)} with notes")

    # Parfumo rows carrying known decoy notes are dropped whole — the real
    # notes can't be told apart from the remaining fabrications (data/poison.py).
    n_poisoned = 0
    for i, chunk in enumerate(sources):
        kept = [p for p in chunk if not is_poisoned(p)]
        n_poisoned += len(chunk) - len(kept)
        sources[i] = kept
    print(f"poisoned parfumo rows dropped: {n_poisoned}")

    # earlier sources win: fragrantica > parfumo > luckyscent
    claimed = set()
    perfumes = []
    for chunk in sources:
        chunk_keys = set()
        added = skipped = 0
        for p in chunk:
            key = (brand_key(p["brand"]), norm_key(p["name"]))
            if key in claimed:  # already claimed by an earlier source
                skipped += 1
                continue
            chunk_keys.add(key)
            perfumes.append(p)
            added += 1
        claimed |= chunk_keys  # same-source duplicates stay; dedupe() picks the best
        if chunk:
            print(f"  kept {added}, cross-source duplicates skipped {skipped}")

    perfumes, n_dup = dedupe(perfumes)
    print(f"in-set dedupe removed {n_dup} -> {len(perfumes)} perfumes")

    print("structure:", dict(Counter(p["structure"] for p in perfumes)))
    print("source:", dict(Counter(p["source"] for p in perfumes)))
    vocab = defaultdict(set)
    for p in perfumes:
        for tier_notes in p["notes"].values():
            vocab[p["source"]].update(tier_notes)
    print("note vocab:", {k: len(v) for k, v in vocab.items()})

    out = os.path.join(DATA, "perfumes.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(perfumes, f, ensure_ascii=False)
    print(f"wrote {out}: {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
