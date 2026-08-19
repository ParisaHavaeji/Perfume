"""Resolve data/stores.json brand lists against the dataset; emit data/out/stores.json.

Runs after clean_dataset.py (needs the unified brand spellings). Store brand names
are matched via brand_key() so curated spellings ("D.S. & Durga") land on the
dataset's canonical string ("DS Durga") without hand-aligning stores.json.
A store may instead declare brands_from_source (its list = every brand appearing
on a perfume from that source) or brands_file (a JSON list in data/raw/ written
by a crawler, e.g. scentroom_refresh.py), plus optional brands_extra /
brands_exclude.
Stores with no list yet are skipped, not emitted: they enter the picker only
once their lists are supplied.
"""
import json
import os
import sys
from collections import Counter, defaultdict

from textnorm import brand_key

DATA = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DATA, "out")


def main():
    with open(os.path.join(DATA, "perfumes.json"), encoding="utf-8") as f:
        perfumes = json.load(f)
    with open(os.path.join(DATA, "stores.json"), encoding="utf-8") as f:
        stores = json.load(f)
    # The server hides dedup-suppressed variant rows from /list, so the
    # emitted perfume counts must exclude them too — the picker number and the
    # store's query total have to agree. Brand presence still counts all rows.
    with open(os.path.join(OUT, "dedup.json"), encoding="utf-8") as f:
        suppressed = {int(i) for i in json.load(f)["suppress"]}

    by_key = {}
    counts = Counter()
    source_brands = defaultdict(set)
    for p in perfumes:
        by_key[brand_key(p["brand"])] = p["brand"]
        if p["id"] not in suppressed:
            counts[p["brand"]] += 1
        source_brands[p["source"]].add(p["brand"])

    emitted = []
    failed = False
    for store in stores:
        supplied = list(store.get("brands", []))
        if store.get("brands_from_source"):
            supplied += sorted(source_brands[store["brands_from_source"]])
        if store.get("brands_file"):
            with open(os.path.join(DATA, "raw", store["brands_file"]), encoding="utf-8") as f:
                supplied += json.load(f)
        supplied += store.get("brands_extra", [])
        if not supplied:
            print(f"{store['id']}: SKIPPED — no brand list supplied yet")
            continue

        matched, unmatched, seen = [], [], set()
        for name in supplied:
            hit = by_key.get(brand_key(name))
            if hit is None:
                unmatched.append(name)
            elif hit not in seen:
                seen.add(hit)
                matched.append(hit)
        for name in store.get("brands_exclude", []):
            hit = by_key.get(brand_key(name))
            if hit in seen:
                seen.discard(hit)
                matched.remove(hit)
            else:
                print(f"{store['id']}: exclude did not match anything: {name}")

        n_perfumes = sum(counts[b] for b in matched)
        rate = (len(supplied) - len(unmatched)) / len(supplied)
        print(f"{store['id']}: {len(matched)} brands matched of {len(supplied)} supplied "
              f"({rate:.0%}), {n_perfumes} perfumes")
        for name in unmatched:
            print(f"  UNMATCHED: {name}")

        if store["kind"] == "flagship":
            if unmatched or len(matched) != 1:
                print(f"  FAIL: flagship must resolve to exactly one dataset brand")
                failed = True
        elif rate < 0.6:
            print(f"  FAIL: match rate below 60%")
            failed = True
        if n_perfumes == 0:
            print(f"  FAIL: store matches zero perfumes")
            failed = True

        emitted.append({
            "id": store["id"], "name": store["name"], "kind": store["kind"],
            "area": store["area"], "as_of": store["as_of"],
            "brands": sorted(matched), "perfumes": n_perfumes,
        })

    if failed:
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "stores.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(emitted, f, ensure_ascii=False)
    print(f"stores.json: {len(emitted)} stores emitted, {os.path.getsize(path) / 1e3:.1f} KB")


if __name__ == "__main__":
    main()
