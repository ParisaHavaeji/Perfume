"""Crawl Elorea's fragrance catalog (the elorea flagship assortment).

Usage:
    python elorea_refresh.py            # full run -> raw/elorea_catalog.jsonl
    python elorea_refresh.py --dry-run  # fetch + report, write nothing

The site is Shopify: /products.json lists the whole catalog in one request
(product_type "Perfume" marks full-size scents; samples/sets/home carry other
types), but notes live only on each product page's Notes tab —
<div class="tab-content tab-content-1 rte"> with lines like
"TOP / Bergamot, Magnolia Leaf, Peach Blossom" (HEART -> middle). Titles are
"PRELUDE (설렘) Eau De Parfum" — the Korean parenthetical is the brand's own
naming and is kept. ~20 requests total, so the file is rewritten whole each
run, not resumed. Run build_dataset.py + clean_dataset.py + build_stores.py
+ verify.py afterwards.
"""
import argparse
import html
import json
import os
import re
import time
import urllib.request

DATA = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(DATA, "raw", "elorea_catalog.jsonl")
BASE = "https://www.elorea.com"
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
DELAY = 0.7  # seconds between requests

BRAND = "Elorea"  # site styles it "ELOREA"

CONCENTRATIONS = ["Eau de Parfum", "Extrait de Parfum"]

NOTES_TAB = re.compile(r'class="tab-content tab-content-1[^"]*"[^>]*>(.*?)class="tab-content tab-content-2', re.S)
HTML_TAG = re.compile(r"<[^>]+>")
# EdP pages write "TOP /", Extrait pages "Top /" — match case-blind
TIER = re.compile(r"^(?P<tier>top|heart|base)\s*/\s*(?P<notes>.+)$", re.M | re.I)
TIER_KEY = {"TOP": "top", "HEART": "middle", "BASE": "base"}


def get(url):
    req = urllib.request.Request(url, headers=HDRS)
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")


def split_notes(s):
    """"Korean Wild Rose (Jjilleggot), Jasmine Absolute" -> note list (already title-cased)."""
    out = []
    for n in s.split(","):
        n = " ".join(n.replace("™", "").replace("®", "").split())  # Thalassogaia™ -> Thalassogaia
        if n and n not in out:
            out.append(n)
    return out


def parse_notes(body):
    m = NOTES_TAB.search(body)
    if not m:
        return None
    text = html.unescape(HTML_TAG.sub("\n", m.group(1)))
    text = "\n".join(" ".join(line.split()) for line in text.splitlines())
    tiers = {"top": [], "middle": [], "base": []}
    for t in TIER.finditer(text):
        tiers[TIER_KEY[t.group("tier").upper()]] = split_notes(t.group("notes"))
    return tiers if any(tiers.values()) else None


def name_and_concentration(title):
    """"PRELUDE (설렘) Eau De Parfum" -> ("Prelude (설렘)", "Eau de Parfum")."""
    t = " ".join(title.split())
    concentration = None
    for c in CONCENTRATIONS:
        if t.lower().endswith(c.lower()):
            t, concentration = t[: -len(c)].strip(), c
            break
    name = " ".join(w.capitalize() if w.isascii() else w for w in t.split())
    return name, concentration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch + report, write nothing")
    args = ap.parse_args()

    catalog = json.loads(get(f"{BASE}/products.json?limit=250"))["products"]
    perfumes = [p for p in catalog if p.get("product_type") == "Perfume"]
    print(f"catalog: {len(catalog)} products, {len(perfumes)} perfumes")

    records, skipped = [], []
    for p in perfumes:
        url = f"{BASE}/products/{p['handle']}"
        time.sleep(DELAY)
        notes = parse_notes(get(url))
        if not notes:
            skipped.append((p["handle"], "no notes tab"))
            continue
        name, concentration = name_and_concentration(html.unescape(p["title"]))
        records.append({
            "url": url,
            "name": name,
            "brand": BRAND,
            "concentration": concentration,
            "notes": notes,
        })
        print(f"  {name} ({concentration}): "
              + " / ".join(", ".join(notes[t]) for t in ("top", "middle", "base")))
    for handle, why in skipped:
        print(f"  skipped {handle}: {why}")

    if args.dry_run:
        print("dry run, nothing written")
        return
    with open(CATALOG_PATH, "w", encoding="utf-8") as out:
        for r in records:
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {CATALOG_PATH}: {len(records)} records")


if __name__ == "__main__":
    main()
