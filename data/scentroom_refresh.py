"""Crawl The Scent Room's Shopify catalog (the scentroom-la carried assortment).

Usage:
    python scentroom_refresh.py            # full run -> raw/scentroom_catalog.jsonl
                                           #          + raw/scentroom_vendors.json
    python scentroom_refresh.py --dry-run  # fetch + report, write nothing

Unlike Luckyscent this needs no per-product page fetches: Shopify's public
/products.json serves the whole ~1,100-product catalog in five requests, notes
included (tiered "Top/Heart/Base Notes:" or a flat "Notes:" line in body_html),
plus one request per scent-family collection for the profile mapping. The full
crawl is ~25 requests, so the file is rewritten whole each run, not resumed.

Every perfume product is recorded (that's what feeds the store's brand list);
records already in the dataset at crawl time are marked "dup": true and
build_dataset.py merges only the rest. Run build_dataset.py + clean_dataset.py
+ build_stores.py + verify.py afterwards.
"""
import argparse
import html
import json
import os
import re
import time
import urllib.request
from collections import Counter
from difflib import SequenceMatcher

from textnorm import brand_key, norm_key, split_notes

DATA = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(DATA, "raw", "scentroom_catalog.jsonl")
VENDORS_PATH = os.path.join(DATA, "raw", "scentroom_vendors.json")
BASE = "https://www.thescentroom.com"
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
DELAY = 0.7  # seconds between requests

# scent-family collections (profile axis, distinct from notes) as of 2026-08
FAMILY_COLLECTIONS = {
    "amber-2": "Amber", "animalic-3": "Animalic", "aquatic-2": "Aquatic",
    "aromaticn2": "Aromatic", "dark-2": "Dark", "floral-2": "Floral",
    "fresh-2": "Fresh", "fruity-2": "Fruity", "gourmande-2": "Gourmand",
    "green-2": "Green", "spicy": "Spicy", "sweet-2": "Sweet",
    "unusual-2": "Unusual", "woody": "Woody",
}

# Vendor spellings that are existing dataset brands under another name, reviewed
# by hand 2026-08-18 (cf. BRAND_DISPLAY_OVERRIDES in clean_dataset.py). Records
# and the vendors file carry the dataset spelling so brands never split in two.
# Substring auto-resolution is deliberately NOT used: it mismatches ("Anti" is
# not Sarantis, "Morris Motley" is not Morris) — new cases get reviewed here.
BRAND_ALIASES = {
    "BDK": "BDK Parfums",
    "Casamorati": "Casamorati 1888",
    "Indult Paris": "Indult",
    "Inverso": "Inverso Profumi",
    "J Lesquendieu": "Lesquendieu",
    "L'Epoque": "Lepoque Parfums",
    "LEN Fragrances": "LEN Fragrance",
    "Nicolai": "Parfums De Nicolai",
    "Renier": "Renier Perfumes",
    "Ricardo Ramos Perfumes": "Ricardo Ramos Perfumes De Autor",
    "Tauer": "Tauer Perfumes",
    "Thameen London": "Thameen",
}

# candles, discovery/gift sets, body products, duos ("2x30ml"), gift cards
NON_PERFUME = re.compile(
    r"candle|discovery|sample|\bgift\b|coffret|\bset\b|\bkit\b|miniatures|"
    r"\d+\s*x\s*\d|body wash|body cream|body lotion|laundry|detergent|"
    r"room spray|diffuser|soap|deodorant", re.I,
)

# inline formatting tags vanish (a <strong> can close mid-word: "Base Note</strong>s:"),
# every other tag becomes a space so paragraphs don't concatenate
INLINE_TAG = re.compile(r"</?(?:strong|b|em|i|u|span|a|small|sup|sub)\b[^>]*>", re.I)
HTML_TAG = re.compile(r"<[^>]+>")
TIER_LABELS = r"(?:Top|Head|Heart|Middle|Base)\s*Notes?"
TIER_SECTION = re.compile(
    rf"(?P<tier>Top|Head|Heart|Middle|Base)\s*Notes?\s*:?\s*"
    rf"(?P<notes>.*?)(?={TIER_LABELS}|[.;]|$)", re.I | re.S)
FLAT_NOTES = re.compile(r"\bNotes?\s*(?::|of\b)\s*(?P<notes>.*?)(?=[.;]|$)", re.I | re.S)
CONCENTRATIONS = {"Eau de Parfum", "Extrait de Parfum", "Eau de Toilette"}


def get_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            return json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(10 * (attempt + 1))


def fetch_paged(path):
    """All items from a Shopify /products.json endpoint, 250 per page."""
    items = []
    page = 1
    while True:
        batch = get_json(f"{BASE}{path}?limit=250&page={page}").get("products", [])
        items.extend(batch)
        if len(batch) < 250:
            return items
        page += 1
        time.sleep(DELAY)


def parse_notes(body_html):
    """{top, middle, base} from labeled sections, {flat: [...]} from a bare
    "Notes:" line, or None. Head=Top, Heart=Middle."""
    text = re.sub(r"\s+", " ",
                  html.unescape(HTML_TAG.sub(" ", INLINE_TAG.sub("", body_html or ""))))
    ok = lambda n: 0 < len(n) <= 40 and ":" not in n  # ":" = tier-label parse residue
    tiers = {"top": [], "middle": [], "base": []}
    for m in TIER_SECTION.finditer(text):
        tier = {"head": "top", "heart": "middle"}.get(
            m.group("tier").lower(), m.group("tier").lower())
        for n in split_notes(m.group("notes")):
            if ok(n) and n not in tiers[tier]:
                tiers[tier].append(n)
    if any(tiers.values()):
        return tiers
    m = FLAT_NOTES.search(text)
    if m:
        flat = [n for n in split_notes(m.group("notes")) if ok(n)]
        if flat:
            return {"flat": flat}
    return None


def dataset_matcher():
    """(brand, name) -> already-in-dataset predicate. Brands match on exact
    brand_key only (BRAND_ALIASES is applied before this); names use the
    Luckyscent refresh's fuzzy rules (substring, 0.85 ratio). Rows this crawl
    itself merged earlier (source scentroom) don't count — otherwise a re-crawl
    would mark its own additions dup and build_dataset would drop them."""
    with open(os.path.join(DATA, "perfumes.json"), encoding="utf-8") as f:
        perfumes = json.load(f)
    by_brand = {}
    for p in perfumes:
        if p["source"] != "scentroom":
            by_brand.setdefault(brand_key(p["brand"]), set()).add(norm_key(p["name"]))

    def known(brand, name):
        names = by_brand.get(brand_key(brand))
        if names is None:
            return False
        n = norm_key(name)
        if n in names:
            return True
        for cand in names:
            if len(n) >= 5 and len(cand) >= 5 and (n in cand or cand in n):
                return True
            if SequenceMatcher(None, n, cand).ratio() >= 0.85:
                return True
        return False

    return known, set(by_brand)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch + report, write nothing")
    args = ap.parse_args()

    products = fetch_paged("/products.json")
    print(f"catalog: {len(products)} products")

    families = {}  # product id -> [family, ...]
    for handle, family in FAMILY_COLLECTIONS.items():
        time.sleep(DELAY)
        for p in fetch_paged(f"/collections/{handle}/products.json"):
            families.setdefault(p["id"], []).append(family)
    print(f"family collections: {len(FAMILY_COLLECTIONS)}, "
          f"{sum(len(v) for v in families.values())} memberships")

    known, dataset_keys = dataset_matcher()
    records = []
    stats = Counter()
    for p in products:
        if NON_PERFUME.search(p["title"]):
            stats["excluded"] += 1
            continue
        notes = parse_notes(p.get("body_html"))
        stats["tiered" if notes and "flat" not in notes else
              "flat" if notes else "no notes"] += 1
        vendor = p["vendor"].strip()
        brand = BRAND_ALIASES.get(vendor, vendor)
        records.append({
            "handle": p["handle"],
            "name": p["title"].strip(),
            "brand": brand,
            "concentration": p["product_type"] if p["product_type"] in CONCENTRATIONS else None,
            "families": sorted(families.get(p["id"], [])),
            "notes": notes,
            "dup": known(brand, p["title"]),
        })

    vendors = sorted({r["brand"] for r in records})
    new = [r for r in records if not r["dup"] and r["notes"]]
    print(f"kept {len(records)} perfumes ({stats['excluded']} non-perfume excluded): "
          f"{stats['tiered']} tiered / {stats['flat']} flat / {stats['no notes']} without notes")
    print(f"vendors: {len(vendors)}; already in dataset: {sum(r['dup'] for r in records)}; "
          f"NEW with notes: {len(new)}")
    for brand, n in Counter(r["brand"] for r in new).most_common(15):
        print(f"  new {n:3d}  {brand}")
    fresh = sorted(b for b in {r["brand"] for r in records} if brand_key(b) not in dataset_keys)
    print(f"brands new to the dataset ({len(fresh)}) — check each is not an alias "
          f"of an existing brand: {fresh}")

    if args.dry_run:
        print("dry run, nothing written")
        return
    with open(CATALOG_PATH, "w", encoding="utf-8") as out:
        for r in records:
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(VENDORS_PATH, "w", encoding="utf-8") as out:
        json.dump(vendors, out, ensure_ascii=False, indent=1)
    print(f"wrote {CATALOG_PATH} + {VENDORS_PATH}")


if __name__ == "__main__":
    main()
