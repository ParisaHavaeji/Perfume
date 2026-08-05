"""Refresh the Luckyscent crawl: find products missing from our dataset, crawl them.

Usage:
    python luckyscent_refresh.py            # full run: sitemap -> match -> crawl
    python luckyscent_refresh.py --dry-run  # report what would be crawled, fetch nothing

Appends to raw/luckyscent_notes.jsonl (resumable: already-crawled slugs are skipped).
Run build_dataset.py + clean_dataset.py afterwards to merge the new perfumes in.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

from textnorm import brand_key, norm_key, titlecase_slug

DATA = os.path.dirname(os.path.abspath(__file__))
NOTES_PATH = os.path.join(DATA, "raw", "luckyscent_notes.jsonl")
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
DELAY = 0.7  # seconds between requests

NON_PERFUME = re.compile(
    r"discovery|sample|gift|candle|diffuser|-soap|shower|lotion|body-|hair-|"
    r"room-spray|travel-case|coffret|tote|tshirt|book-by|notecard|deodorant|"
    r"travel-spray|travel-size|refill|tester"
)
NOTE_LINK = re.compile(r'f\.l\.notes=([^"&]+)"')
LDJSON = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
VARIANT_SUFFIX = re.compile(r"(travelspray|travelsize|refill|tester|miniature)$")


def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404 or attempt == retries - 1:
                raise
            time.sleep(30 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(10)


def product_slugs():
    """All product slugs from the sitemap, minus obvious non-perfume items."""
    index = get("https://www.luckyscent.com/sitemap.xml")
    sitemaps = re.findall(r"<loc>(https://www\.luckyscent\.com/sitemap/products/\d+\.xml)</loc>", index)
    slugs = set()
    for sm in sitemaps:
        for loc in re.findall(r"<loc>([^<]+)</loc>", get(sm)):
            slug = loc.rsplit("/", 1)[1]
            if not NON_PERFUME.search(slug):
                slugs.add(slug)
        time.sleep(0.3)
    print(f"sitemap: {len(sitemaps)} files, {len(slugs)} perfume-ish slugs")
    return sorted(slugs)


def split_slug(slug):
    """"1-nota-di-viaggio-by-meo-fusciuni" -> ("1-nota-di-viaggio", "meo-fusciuni")"""
    return slug.rsplit("-by-", 1) if "-by-" in slug else (slug, "")


def missing_slugs(slugs):
    """Slugs not already covered by perfumes.json, after fuzzy matching."""
    with open(os.path.join(DATA, "perfumes.json"), encoding="utf-8") as f:
        perfumes = json.load(f)
    by_brand = {}
    for p in perfumes:
        by_brand.setdefault(brand_key(p["brand"]), set()).add(norm_key(p["name"]))

    def find_brand(b):
        if b in by_brand:
            return b
        cands = [k for k in by_brand if len(k) >= 4 and (k in b or b in k)]
        return min(cands, key=len) if cands else None

    def name_matches(n, names):
        n = VARIANT_SUFFIX.sub("", n)
        if n in names:
            return True
        for cand in names:
            if len(n) >= 5 and len(cand) >= 5 and (n in cand or cand in n):
                return True
            if SequenceMatcher(None, n, cand).ratio() >= 0.85:
                return True
        return False

    missing = []
    for slug in slugs:
        name_part, brand_part = split_slug(slug)
        b = find_brand(brand_key(brand_part.replace("-", " ")))
        if b is None:
            missing.append(slug)
            continue
        n = norm_key(name_part)
        n_alt = norm_key(re.sub(r"^\d{4}-", "", name_part))  # "1861-naxos" -> "naxos"
        if not (name_matches(n, by_brand[b]) or (n_alt != n and name_matches(n_alt, by_brand[b]))):
            missing.append(slug)
    print(f"missing from dataset: {len(missing)} of {len(slugs)}")
    return missing


def crawled_slugs():
    done = set()
    if os.path.exists(NOTES_PATH):
        with open(NOTES_PATH, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["slug"])
                except json.JSONDecodeError:
                    pass
    return done


def parse_product(html, slug):
    notes = []
    for n in NOTE_LINK.findall(html):
        n = urllib.parse.unquote(n).strip()
        if n and n not in notes:
            notes.append(n)
    name = brand = None
    for block in LDJSON.findall(html):
        try:
            ld = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for item in ld if isinstance(ld, list) else [ld]:
            if isinstance(item, dict) and item.get("@type") == "Product":
                name = item.get("name") or name
                b = item.get("brand")
                brand = (b.get("name") if isinstance(b, dict) else b) or brand
    name_part, brand_part = split_slug(slug)
    return {
        "slug": slug,
        "name": name or titlecase_slug(name_part),
        "brand": brand or titlecase_slug(brand_part),
        "notes": notes,
    }


def crawl(slugs):
    stats = {"ok": 0, "empty": 0, "err": 0}
    with open(NOTES_PATH, "a", encoding="utf-8") as out:
        for i, slug in enumerate(slugs):
            try:
                rec = parse_product(get(f"https://www.luckyscent.com/products/{slug}"), slug)
                stats["ok" if rec["notes"] else "empty"] += 1
            except Exception as e:
                rec = {"slug": slug, "error": str(e)}
                stats["err"] += 1
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if (i + 1) % 50 == 0:
                print(f"{i + 1}/{len(slugs)}  {stats}", flush=True)
            time.sleep(DELAY)
    print(f"crawl done: {stats}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report, don't crawl")
    args = ap.parse_args()

    todo = [s for s in missing_slugs(product_slugs()) if s not in crawled_slugs()]
    print(f"to crawl (not yet in {os.path.basename(NOTES_PATH)}): {len(todo)}")
    if args.dry_run or not todo:
        return
    print(f"estimated time: {len(todo) * (DELAY + 0.4) / 60:.0f} min")
    crawl(todo)


if __name__ == "__main__":
    main()
