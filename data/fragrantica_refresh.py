"""Refresh from Fragrantica: harvest new releases via its Algolia search index,
then crawl notes from the perfume pages we're missing.

Fragrantica's /search/ page server-renders its Algolia app id and a secured
search key (rotates, ~3 week validity), so we bootstrap credentials with one
page fetch and query the index directly -- no HTML scraping to enumerate.
Perfume pages themselves currently serve fine to a plain client; the notes
live in the description ("Top notes are X...; middle notes are Y...").

Usage:
    python fragrantica_refresh.py index            # harvest 2024+ releases (~1-2 min, ~100 requests)
    python fragrantica_refresh.py crawl            # crawl notes for missing perfumes (resumable)
    python fragrantica_refresh.py crawl --limit 500
    python fragrantica_refresh.py crawl --fids 129373,129374   # only these ids
    python fragrantica_refresh.py status           # counts: harvested / crawled / remaining

`index` rewrites raw/fragrantica_index.jsonl. `crawl` appends to
raw/fragrantica_new.jsonl, most-voted perfumes first, skipping anything already
crawled -- safe to stop and rerun. Run build_dataset.py + clean_dataset.py
afterwards to merge.
"""
import argparse
import base64
import gzip
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from textnorm import brand_key, norm_key, split_notes

DATA = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(DATA, "raw", "fragrantica_index.jsonl")
NOTES_PATH = os.path.join(DATA, "raw", "fragrantica_new.jsonl")

MIN_YEAR = 2024  # dataset coverage is solid through 2023
MAX_FID = 1_000_000  # bisection upper bound, far above current ~110K ids
DELAY = 2.5  # seconds between page fetches (plan: ~1 req / 2-3 s)
ALGOLIA_DELAY = 1.2  # their rate limit 429s well before this, backoff handles it

HDRS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

TIER_RE = re.compile(r"(?P<tier>[Tt]op|[Mm]iddle|[Bb]ase) notes? (?:are|is) (?P<notes>[^;.]*)")
FLAT_RE = re.compile(r"(?<![Tt]op )(?<![Mm]iddle )(?<![Bb]ase )[Nn]otes (?:are|is|include) (?P<notes>[^;.]*)")
YEAR_RE = re.compile(r"launched in (\d{4})")
DESC_RE = re.compile(r'itemprop="description">(.*?)</div>', re.S)
TAG_RE = re.compile(r"<[^>]+>")

GENDER = {"male": "men", "female": "women", "unisex": "women and men"}


def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (403, 503):
                sys.exit(f"blocked ({e.code}) on {url} -- Cloudflare is challenging us; retry later")
            if e.code == 429:
                if attempt == retries - 1:
                    sys.exit(f"rate limited (429) on {url} even after backoff -- retry later")
                time.sleep(120 * (attempt + 1))
                continue
            if e.code == 404 or attempt == retries - 1:
                raise
            time.sleep(15 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(10)


# ---------------------------------------------------------------- credentials

def algolia_credentials():
    """(app_id, api_key) scraped from the /search/ page."""
    page = get("https://www.fragrantica.com/search/")
    m = re.search(r'algoliaAppId\\?":\\?"([A-Z0-9]+)', page)
    if not m:
        sys.exit("could not find algoliaAppId on /search/ -- page layout changed?")
    app_id = m.group(1)
    for cand in re.findall(r'"([A-Za-z0-9+/]{60,}={0,2})"', page):
        try:
            if b"validUntil" in base64.b64decode(cand):
                return app_id, cand
        except Exception:
            continue
    sys.exit("could not find a secured Algolia key on /search/ -- page layout changed?")


def algolia_query(app_id, key, filters, page=0):
    # the secured key clamps hitsPerPage to 30 and pagination to ~1000 hits;
    # callers page through nbPages and bisect the fid range past the cap
    params = urllib.parse.urlencode(
        {
            "query": "",
            "hitsPerPage": 1000,
            "page": page,
            "filters": filters,
            "attributesToHighlight": "[]",
            "attributesToRetrieve": '["id","slug","naslov","dizajner","godina","spol","rating","votes"]',
        }
    )
    req = urllib.request.Request(
        f"https://{app_id}-dsn.algolia.net/1/indexes/fragrantica_perfumes/query",
        data=json.dumps({"params": params}).encode(),
        headers={
            "Content-Type": "application/json",
            "x-algolia-application-id": app_id,
            "x-algolia-api-key": key,
        },
    )
    # their quota looks hourly, not per-burst: waits of several minutes are normal
    for attempt in range(15):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 14:
                wait = min(300, 30 * 2**attempt)
                print(f"  rate limited, sleeping {wait}s", flush=True)
                time.sleep(wait)
            else:
                raise


# ---------------------------------------------------------------------- index

def cmd_index():
    """Resumable and self-verifying: hits append to the index file as fid ranges
    complete (finished ranges in a .state sidecar), and each year is skipped
    outright when the local count already matches Algolia's nbHits. Harvests
    year by year with equality filters -- the numeric `godina>=` filter returns
    inconsistent counts on this index and silently dropped ~3K of 2025.
    Rate-limit waits make a full run slow (hours), but it converges."""
    app_id, key = algolia_credentials()
    print(f"algolia app {app_id}, key ...{key[-12:]}", flush=True)

    state_path = INDEX_PATH + ".state"
    done = set()
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            done = set(json.load(f))
    have = load_jsonl(INDEX_PATH)
    found = {r["fid"] for r in have}
    per_year = {}
    for r in have:
        per_year[r["year"]] = per_year.get(r["year"], 0) + 1
    if found:
        print(f"resuming: {len(found)} perfumes already harvested, {len(done)} ranges done", flush=True)
    requests = 0

    with open(INDEX_PATH, "a", encoding="utf-8") as out:

        def take(hits):
            for h in hits:
                if h["id"] in found:
                    continue
                found.add(h["id"])
                year = h["godina"] or None
                per_year[year] = per_year.get(year, 0) + 1
                rec = {
                    "fid": h["id"],
                    "slug": h["slug"],  # "Brand-Slug/Name-Slug", page at /perfume/<slug>-<fid>.html
                    "name": h["naslov"],
                    "brand": h["dizajner"],
                    "year": year,
                    "gender": GENDER.get(h.get("spol")),
                    "rating": h.get("rating"),
                    "votes": h.get("votes"),
                }
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")

        def walk(year, lo, hi):
            """Collect all hits for `year` in fid range [lo, hi]; bisect past the pagination cap."""
            nonlocal requests
            tag = f"{year}:{lo}:{hi}"
            if tag in done:
                return
            filters = f"godina:{year} AND id:{lo} TO {hi}"
            res = algolia_query(app_id, key, filters)
            requests += 1
            time.sleep(ALGOLIA_DELAY)
            reachable = res["nbPages"] * res["hitsPerPage"]
            if res["nbHits"] > reachable and lo < hi:
                mid = (lo + hi) // 2
                walk(year, lo, mid)
                walk(year, mid + 1, hi)
            else:
                take(res["hits"])
                for page in range(1, res["nbPages"]):
                    more = algolia_query(app_id, key, filters, page=page)
                    requests += 1
                    time.sleep(ALGOLIA_DELAY)
                    take(more["hits"])
                out.flush()
            done.add(tag)
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(sorted(done), f)
            if requests % 50 < 2:
                print(f"  {requests} queries, {len(found)} perfumes so far", flush=True)

        def exhaustive_count(year, lo, hi):
            """True hit count: nbHits on wide ranges is an estimate (a few
            thousand high for 2025) -- subdivide until Algolia marks it exact."""
            nonlocal requests
            res = algolia_query(app_id, key, f"godina:{year} AND id:{lo} TO {hi}")
            requests += 1
            time.sleep(ALGOLIA_DELAY)
            if res.get("exhaustiveNbHits", True) or lo >= hi:
                return res["nbHits"]
            mid = (lo + hi) // 2
            return exhaustive_count(year, lo, mid) + exhaustive_count(year, mid + 1, hi)

        for year in range(MIN_YEAR, MIN_YEAR + 6):
            n = exhaustive_count(year, 0, MAX_FID)
            requests += 1
            time.sleep(ALGOLIA_DELAY)
            local = per_year.get(year, 0)
            if n == local:
                print(f"{year}: {local}/{n} already complete", flush=True)
                continue
            print(f"{year}: have {local} of {n}, harvesting", flush=True)
            walk(year, 0, MAX_FID)

    # consolidate: dedupe (paranoia) and sort by fid
    rows = {r["fid"]: r for r in load_jsonl(INDEX_PATH)}
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        for r in sorted(rows.values(), key=lambda r: r["fid"]):
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    if os.path.exists(state_path):
        os.remove(state_path)
    print(f"{len(rows)} perfumes with year >= {MIN_YEAR} -> {INDEX_PATH} ({requests} queries this run)", flush=True)


# ---------------------------------------------------------------------- crawl

def load_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def missing_entries():
    """Index entries not yet in perfumes.json and not yet crawled, most-voted first."""
    index = load_jsonl(INDEX_PATH)
    if not index:
        sys.exit(f"no index at {INDEX_PATH} -- run `python fragrantica_refresh.py index` first")

    with open(os.path.join(DATA, "perfumes.json"), encoding="utf-8") as f:
        perfumes = json.load(f)
    have_fid = {p["fid"] for p in perfumes if p.get("fid")}
    have_key = {(brand_key(p["brand"]), norm_key(p["name"])) for p in perfumes}
    crawled = {r["fid"] for r in load_jsonl(NOTES_PATH)}

    missing = [
        e
        for e in index
        if e["fid"] not in have_fid
        and e["fid"] not in crawled
        and (brand_key(e["brand"]), norm_key(e["name"])) not in have_key
    ]
    missing.sort(key=lambda e: e["votes"] or 0, reverse=True)
    return index, crawled, missing


def parse_notes(page):
    """{top/middle/base: [...]} from the description; single-tier dict for flat lists."""
    m = DESC_RE.search(page)
    if not m:
        return None
    desc = htmllib.unescape(TAG_RE.sub("", m.group(1)))
    tiers = {"top": [], "middle": [], "base": []}
    for tm in TIER_RE.finditer(desc):
        tiers[tm.group("tier").lower()] = split_notes(tm.group("notes"))
    if not any(tiers.values()):
        fm = FLAT_RE.search(desc)
        if fm:
            tiers["top"] = split_notes(fm.group("notes"))
    if not any(tiers.values()):
        return None
    return tiers, desc


def cmd_crawl(limit, dry_run, match=None, fids=None):
    _, crawled, missing = missing_entries()
    if fids:
        missing = [e for e in missing if e["fid"] in fids]
        absent = fids - {e["fid"] for e in missing}
        if absent:
            print(f"skipping {len(absent)} fids not in the index or already crawled/merged: {sorted(absent)}", flush=True)
    if match:
        m = match.lower()
        missing = [e for e in missing if m in f"{e['brand']} {e['name']}".lower()]
    todo = missing[:limit] if limit else missing
    print(f"{len(missing)} missing perfumes, crawling {len(todo)} (already crawled {len(crawled)})", flush=True)
    if dry_run:
        for e in todo[:40]:
            print(f"  {e['votes'] or 0:>6} votes  {e['brand']} - {e['name']} ({e['year']})")
        return

    ok = failed = 0
    with open(NOTES_PATH, "a", encoding="utf-8") as out:
        for i, e in enumerate(todo, 1):
            url = f"https://www.fragrantica.com/perfume/{e['slug']}-{e['fid']}.html"
            rec = dict(e)
            try:
                parsed = parse_notes(get(url))
                if parsed:
                    tiers, desc = parsed
                    rec["notes"] = tiers
                    ym = YEAR_RE.search(desc)
                    if not rec["year"] and ym:
                        rec["year"] = int(ym.group(1))
                    ok += 1
                else:
                    rec["error"] = "no notes found"
                    failed += 1
            except Exception as exc:
                rec["error"] = f"{type(exc).__name__}: {exc}"[:200]
                failed += 1
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if i % 25 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}  ok {ok}  no-notes/errors {failed}  last: {e['brand']} - {e['name']}", flush=True)
            time.sleep(DELAY)
    print(f"done: {ok} with notes, {failed} without -> {NOTES_PATH}")
    print("next: python build_dataset.py && python clean_dataset.py && python verify.py")


def cmd_status():
    index, crawled, missing = missing_entries()
    with_notes = sum(1 for r in load_jsonl(NOTES_PATH) if r.get("notes"))
    print(f"index:   {len(index)} perfumes (year >= {MIN_YEAR})")
    print(f"crawled: {len(crawled)} ({with_notes} with notes)")
    print(f"left:    {len(missing)}  (~{len(missing) * DELAY / 3600:.1f} h at {DELAY}s/page)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["index", "crawl", "status"])
    ap.add_argument("--limit", type=int, help="crawl at most N pages this run")
    ap.add_argument("--dry-run", action="store_true", help="crawl: list what would be fetched")
    ap.add_argument("--match", help="crawl: only perfumes whose brand+name contains this (case-insensitive)")
    ap.add_argument("--fids", help="crawl: only these Fragrantica ids, comma-separated")
    args = ap.parse_args()
    if args.phase == "index":
        cmd_index()
    elif args.phase == "crawl":
        fids = {int(x) for x in args.fids.split(",")} if args.fids else None
        cmd_crawl(args.limit, args.dry_run, args.match, fids)
    else:
        cmd_status()


if __name__ == "__main__":
    main()
