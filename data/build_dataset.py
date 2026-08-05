"""Merge the raw perfume sources into data/perfumes.json.

Sources, in priority order (first one to claim a brand+name wins):
  1. Fragrantica (raw/fra_perfumes.csv) — notes parsed from the description text
  2. Parfumo    (raw/parfumo_tidytuesday.csv) — structured note columns
  3. Luckyscent (raw/luckyscent_notes.jsonl) — flat notes from our own crawl

Run clean_dataset.py afterwards to normalize and emit the browser-ready files.
"""
import json
import os
import re
from collections import Counter, defaultdict

import pandas as pd

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
    sources = [load_fragrantica(), load_parfumo(), load_luckyscent()]
    for chunk in sources:
        if chunk:
            print(f"{chunk[0]['source']}: {len(chunk)} with notes")

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
