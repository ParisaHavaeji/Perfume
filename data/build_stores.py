"""Resolve data/stores.json brand lists against the dataset; emit data/out/stores.json.

Runs after clean_dataset.py (needs the unified brand spellings). Store brand names
are matched via brand_key() so curated spellings ("D.S. & Durga") land on the
dataset's canonical string ("DS Durga") without hand-aligning stores.json.
A store may instead declare brands_from_source (its list = every brand appearing
on a perfume from that source) or brands_file (a JSON file in data/raw/), plus
optional brands_extra / brands_exclude.

brands_file comes in two shapes:
  * a plain JSON list of brand names (crawler output, e.g. scentroom_vendors.json);
  * the chain-store object form (data/raw/chains/<id>.json, schema in
    DATASET_NOTES.md § Chain harvest recipe): per-location retailer strings with
    URL + read-date provenance, a 1->1 `aliases` map (retailer spelling ->
    dataset brand), and an `ignore` list for house lines / sets. The store's
    list is the union over locations and reads; `as_of` is derived from the
    latest read, so a chain entry must not carry its own; the entry's `area`
    must name exactly the harvested locations (an optional trailing
    parenthetical like "(website brand list)" is allowed for non-facet reads).
    An alias whose target does not resolve fails the build — a typo must never
    silently shrink a store.
Stores with no list yet are skipped, not emitted: they enter the picker only
once their lists are supplied.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

from clean_dataset import BRAND_KEY_ALIASES
from textnorm import brand_key

CHAIN_METHODS = ("in_store_facet", "grid_read", "online_catalog", "paste")


def dataset_key(name):
    """brand_key, routed through the same alias merges clean_dataset applies.
    Both sides need this: a curated store list may spell a brand by a merged
    key ("By Kilian" after the bykilian -> kilian fold), and the dataset's
    canonical display can itself sit on either side of a merge ("Zoologist
    Perfumes" winning the most-common vote keys as zoologistperfumes)."""
    k = brand_key(name)
    return BRAND_KEY_ALIASES.get(k, k)

DATA = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DATA, "out")


def load_chain_file(store, raw):
    """Validate the object-form brands_file; return (distinct retailer strings
    after `ignore`, aliases, as_of) or raise ValueError with the reason."""
    if raw.get("store") != store["id"]:
        raise ValueError(f"raw file 'store' {raw.get('store')!r} != entry id {store['id']!r}")
    if raw.get("method") not in CHAIN_METHODS:
        raise ValueError(f"method must be one of {CHAIN_METHODS}, got {raw.get('method')!r}")
    locations = raw.get("locations") or []
    if not locations:
        raise ValueError("no locations")
    reads, names = [], []
    for loc in locations:
        if not loc.get("name") or not loc.get("reads") or not loc.get("urls"):
            raise ValueError(f"location {loc.get('name')!r} needs name, urls, reads")
        reads += loc["reads"]
        names.append(loc["name"])
    as_of = max(reads)[:7]
    if "as_of" in store and store["as_of"] != as_of:
        raise ValueError(f"entry as_of {store['as_of']} clashes with derived {as_of}; drop it from stores.json")
    expected = " + ".join(names)
    area = re.sub(r"\s*\([^)]*\)\s*$", "", store.get("area", ""))
    if area != expected:
        raise ValueError(f"area {store.get('area')!r} must name the harvested locations: {expected!r}")
    ignore = set(raw.get("ignore", []))
    seen, distinct = set(), []
    for loc in locations:
        for name in loc["brands"]:
            if name in ignore or name in seen:
                continue
            seen.add(name)
            distinct.append(name)
    return distinct, dict(raw.get("aliases", {})), as_of


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
        by_key[dataset_key(p["brand"])] = p["brand"]
        if p["id"] not in suppressed:
            counts[p["brand"]] += 1
        source_brands[p["source"]].add(p["brand"])

    emitted = []
    failed = False
    for store in stores:
        supplied = list(store.get("brands", []))
        aliases = {}
        as_of = store.get("as_of")
        chain_form = False
        if store.get("brands_from_source"):
            supplied += sorted(source_brands[store["brands_from_source"]])
        if store.get("brands_file"):
            with open(os.path.join(DATA, "raw", store["brands_file"]), encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, list):
                supplied += raw
            else:
                chain_form = True
                try:
                    names, aliases, as_of = load_chain_file(store, raw)
                except ValueError as e:
                    print(f"{store['id']}: FAIL: {e}")
                    failed = True
                    continue
                supplied += names
                print(f"{store['id']}: method {raw['method']}, as_of {as_of}, " + ", ".join(
                    f"{loc['name']} {len(loc['brands'])} strings / reads {' '.join(loc['reads'])}"
                    for loc in raw["locations"]))
        supplied += store.get("brands_extra", [])
        if not supplied:
            print(f"{store['id']}: SKIPPED — no brand list supplied yet")
            continue
        if as_of is None:
            print(f"{store['id']}: FAIL: no as_of")
            failed = True
            continue

        matched, unmatched, seen = [], [], set()
        for name in supplied:
            target = aliases.get(name, name)
            hit = by_key.get(dataset_key(target))
            if hit is None:
                if target is not name:
                    print(f"  ALIAS-MISS: {name} -> {target}")
                    failed = True
                unmatched.append(name)
            elif hit not in seen:
                seen.add(hit)
                matched.append(hit)
        for name in store.get("brands_exclude", []):
            hit = by_key.get(dataset_key(name))
            if hit in seen:
                seen.discard(hit)
                matched.remove(hit)
            else:
                print(f"{store['id']}: exclude did not match anything: {name}")

        n_perfumes = sum(counts[b] for b in matched)
        # Chain form: supplied is already distinct and ignore-filtered, so this
        # is "matched retailer strings / distinct retailer strings"; the legacy
        # formula is kept verbatim for list-form stores.
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
        if store["kind"] == "chain" and not chain_form:
            print(f"  NOTE: chain store without a chains/ raw file — no per-location provenance")

        emitted.append({
            "id": store["id"], "name": store["name"], "kind": store["kind"],
            "area": store["area"], "as_of": as_of,
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
