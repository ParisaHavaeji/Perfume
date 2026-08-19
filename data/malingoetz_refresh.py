"""Crawl Malin+Goetz's fragrance catalog (the malin-goetz flagship assortment).

Usage:
    python malingoetz_refresh.py            # full run -> raw/malingoetz_catalog.jsonl
    python malingoetz_refresh.py --dry-run  # fetch + report, write nothing

The site is Magento (no Shopify /products.json); the /scent/fragrance category
page lists every fragrance product as a product-item-link, and each product
page carries a PageBuilder block — <h2>notes.</h2> <p>top. <strong>bergamot,
plum + anise.</strong><br>middle. … — with lowercase comma/plus-separated
notes. The whole crawl is ~15 requests, so the file is rewritten whole each
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
CATALOG_PATH = os.path.join(DATA, "raw", "malingoetz_catalog.jsonl")
BASE = "https://www.malinandgoetz.com"
LIST_URL = f"{BASE}/scent/fragrance"
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
DELAY = 0.7  # seconds between requests

BRAND = "Malin+Goetz"  # site styles it "(MALIN+GOETZ)"

# holiday gift sets and discovery kits carry no notes and aren't single scents;
# the Brain Dead collab is Leather in collab packaging (pyramid identical to
# Leather EdP/oil, verified 2026-08-18), not a composition of its own
NON_PERFUME = re.compile(r"holiday|discovery|-kit\b|candle|votive|\bset\b|gift|brain-dead", re.I)

CONCENTRATIONS = ["Eau de Parfum", "Perfume Oil", "Eau de Toilette"]

ITEM_LINK = re.compile(r'href="([^"]+)"[^>]*class="product-item-link"')
PRODUCT_NAME = re.compile(r'"@type":"Product","name":"([^"]+)"')
NOTES_BLOCK = re.compile(r"<h2[^>]*>\s*notes\.?\s*</h2>\s*(.*?)</p>", re.I | re.S)
HTML_TAG = re.compile(r"<[^>]+>")
TIER = re.compile(r"\b(?P<tier>top|middle|base)[.:]\s*(?P<notes>[^.]*)", re.I)


def get(url):
    req = urllib.request.Request(url, headers=HDRS)
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")


def split_notes(s):
    """"bergamot, plum + anise" / "grapefruit peel and cardamom" -> note list."""
    out = []
    for n in re.split(r",|\+|\band\b", s):
        n = " ".join(w[:1].upper() + w[1:] for w in n.split())
        if n and n not in out:
            out.append(n)
    return out


def parse_notes(body):
    m = NOTES_BLOCK.search(body)
    if not m:
        return None
    text = re.sub(r"\s+", " ", html.unescape(HTML_TAG.sub(" ", m.group(1))))
    tiers = {"top": [], "middle": [], "base": []}
    for t in TIER.finditer(text):
        tiers[t.group("tier").lower()] = split_notes(t.group("notes"))
    return tiers if any(tiers.values()) else None


def name_and_concentration(title):
    """"dark rum eau de parfum." -> ("Dark Rum", "Eau de Parfum")."""
    t = title.strip().rstrip(".").strip()
    concentration = None
    for c in CONCENTRATIONS:
        if t.lower().endswith(c.lower()):
            t, concentration = t[: -len(c)].strip(), c
            break
    name = " ".join(w if w.isupper() else w.capitalize() for w in t.split())
    return name, concentration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch + report, write nothing")
    args = ap.parse_args()

    listing = get(LIST_URL)
    urls = sorted(set(ITEM_LINK.findall(listing)))
    print(f"listing: {len(urls)} products")

    records, skipped = [], []
    for url in urls:
        slug = url.rstrip("/").rsplit("/", 1)[-1]
        if NON_PERFUME.search(slug):
            skipped.append((slug, "non-perfume"))
            continue
        time.sleep(DELAY)
        body = get(url)
        title_m = PRODUCT_NAME.search(body)
        notes = parse_notes(body)
        if not title_m or not notes:
            skipped.append((slug, "no title" if not title_m else "no notes block"))
            continue
        name, concentration = name_and_concentration(html.unescape(title_m.group(1)))
        records.append({
            "url": url,
            "name": name,
            "brand": BRAND,
            "concentration": concentration,
            "notes": notes,
        })
        print(f"  {name} ({concentration}): "
              + " / ".join(", ".join(notes[t]) for t in ("top", "middle", "base")))
    for slug, why in skipped:
        print(f"  skipped {slug}: {why}")

    if args.dry_run:
        print("dry run, nothing written")
        return
    with open(CATALOG_PATH, "w", encoding="utf-8") as out:
        for r in records:
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {CATALOG_PATH}: {len(records)} records")


if __name__ == "__main__":
    main()
