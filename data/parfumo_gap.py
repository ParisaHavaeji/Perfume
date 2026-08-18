"""Fill the 2024+ dataset gap from Parfumo instead of Fragrantica.

Fragrantica blocks our page fetches (and is absent from Common Crawl / hard to
reach on Wayback), so we get notes for the missing releases from Parfumo, which
serves plain HTML and publishes sitemaps. No search endpoints are used --
parfumo's robots.txt disallows /s_perfumes*.php and /action/, so instead we:

  1. download the published perfume sitemaps (~25 small requests, one-time)
  2. match our gap list (fragrantica_index.jsonl minus perfumes.json) against
     the sitemap URL slugs locally -- exact key, trailing-year variant, brand
     aliasing, and a conservative unique-containment fuzzy pass
  3. crawl only the matched perfume pages, most-voted first, at 2.5 s/page

Usage:
    python parfumo_gap.py sitemap             # refresh raw/parfumo_sitemap_urls.txt
    python parfumo_gap.py match               # write raw/parfumo_gap_matches.jsonl
    python parfumo_gap.py crawl               # fetch pages, append raw/parfumo_gap.jsonl
    python parfumo_gap.py crawl --limit 200
    python parfumo_gap.py crawl --min-votes 50
    python parfumo_gap.py status

`crawl` is resumable: it skips anything already in raw/parfumo_gap.jsonl, so
stop and rerun freely. Run build_dataset.py + clean_dataset.py to merge.
"""
import argparse
import gzip
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

from textnorm import brand_key, norm_key

DATA = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(DATA, "raw")
INDEX_PATH = os.path.join(RAW, "fragrantica_index.jsonl")
DATASET_PATH = os.path.join(DATA, "perfumes.json")
SITEMAP_PATH = os.path.join(RAW, "parfumo_sitemap_urls.txt")
MATCHES_PATH = os.path.join(RAW, "parfumo_gap_matches.jsonl")
NOTES_PATH = os.path.join(RAW, "parfumo_gap.jsonl")

DELAY = 2.5  # seconds between page fetches, same pace the fragrantica plan used
SITEMAP_DELAY = 1.0

HDRS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# page anatomy mirrors server/parfumo.js (the live gap-fill parser)
H1_RE = re.compile(r'<h1[^>]*class="p_name_h1"[^>]*>([\s\S]*?)</h1>')
YEAR_RE = re.compile(r"Release_Years/(\d{4})")
NOTE_RE = re.compile(
    r'data-nt="([tmbn])"[^>]*>\s*<span[^>]*>\s*(?:<img[^>]*alt="([^"]*)"[^>]*>)?([^<]*)'
)
TAG_RE = re.compile(r"<[^>]+>")

# fragrantica brand names that differ from parfumo's; keys are brand_key() output
BRAND_ALIASES = {
    "maisonmartinmargiela": "maisonmargiela",
}


def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip" or url.endswith(".gz"):
                    try:
                        body = gzip.decompress(body)
                    except OSError:
                        pass
                return body.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (403, 503):
                sys.exit(f"blocked ({e.code}) on {url} -- stop and retry later")
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


# -------------------------------------------------------------------- sitemap

def cmd_sitemap():
    index = get("https://www.parfumo.com/sitemap_en.xml")
    shards = re.findall(
        r"<loc>(https://www\.parfumo\.com/sitemap/sitemap_en_perfums\d+\.xml\.gz)</loc>",
        index,
    )
    if not shards:
        sys.exit("no perfume shards in sitemap_en.xml -- layout changed?")
    urls = []
    for shard in shards:
        text = get(shard)
        found = re.findall(r"<loc>(https://www\.parfumo\.com/Perfumes/[^<]+)</loc>", text)
        urls.extend(found)
        print(f"{shard.rsplit('/', 1)[-1]}: {len(found)}", flush=True)
        time.sleep(SITEMAP_DELAY)
    with open(SITEMAP_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(urls))
    print(f"saved {len(urls)} perfume urls -> {SITEMAP_PATH}")


# ---------------------------------------------------------------------- match

def load_gap():
    """Index entries whose brand+name is absent from perfumes.json, votes desc."""
    with open(DATASET_PATH, encoding="utf-8") as f:
        ds = json.load(f)
    have = {
        (brand_key(p.get("brand", "")), norm_key(p.get("name", "")))
        for p in (ds if isinstance(ds, list) else ds.get("perfumes", []))
    }
    gap = []
    with open(INDEX_PATH, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if (brand_key(r["brand"]), norm_key(r["name"])) not in have:
                gap.append(r)
    gap.sort(key=lambda r: -r.get("votes", 0))
    return gap


def parfumo_universe():
    """{brand_key: {name_key: url}} from the sitemap dump (year-stripped keys too)."""
    brands = {}
    with open(SITEMAP_PATH, encoding="utf-8") as f:
        for url in f:
            url = url.strip()
            m = re.match(r"https://www\.parfumo\.com/Perfumes/([^/]+)/([^/]+)$", url)
            if not m:
                continue
            b = brand_key(m.group(1).replace("_", " "))
            name = m.group(2).replace("_", " ").replace("-", " ")
            names = brands.setdefault(b, {})
            names.setdefault(norm_key(name), url)
            ym = re.match(r"(.*?)\s+(?:19|20)\d\d$", name)
            if ym:
                names.setdefault(norm_key(ym.group(1)), url)
    return brands


def resolve_brand(bkey, brands):
    if bkey in brands:
        return bkey
    if bkey in BRAND_ALIASES and BRAND_ALIASES[bkey] in brands:
        return BRAND_ALIASES[bkey]
    # substring either way, unique winner only ("essentialparfums" ~ "essentialparfumsparis")
    cands = [b for b in brands if (bkey in b or b in bkey) and min(len(b), len(bkey)) >= 6]
    return cands[0] if len(cands) == 1 else None


def match_name(r, names):
    """URL for one gap entry within a parfumo brand's {name_key: url}, or None."""
    nkey = norm_key(r["name"])
    if nkey in names:
        return names[nkey], "exact"
    if r.get("year"):
        k = norm_key(f"{r['name']} {r['year']}")
        if k in names:
            return names[k], "year"
    # fragrantica often prefixes the brand ("Narciso Rodriguez For Her Musc Nude")
    bare = norm_key(re.sub(re.escape(r["brand"]), "", r["name"], count=1, flags=re.I))
    if bare and bare in names:
        return names[bare], "brand-stripped"
    # containment, but only when exactly one candidate matches (safety over coverage)
    cands = {
        u
        for k, u in names.items()
        if (nkey in k or k in nkey) and min(len(k), len(nkey)) >= max(6, len(nkey) // 2)
    }
    if len(cands) == 1:
        return cands.pop(), "contain"
    return None, None


def cmd_match():
    gap = load_gap()
    brands = parfumo_universe()
    matched, how_counts = [], {}
    for r in gap:
        b = resolve_brand(brand_key(r["brand"]), brands)
        if not b:
            continue
        url, how = match_name(r, brands[b])
        if url:
            matched.append({**r, "parfumo_url": url, "match": how})
            how_counts[how] = how_counts.get(how, 0) + 1
    with open(MATCHES_PATH, "w", encoding="utf-8") as f:
        for m in matched:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"gap: {len(gap)}  matched: {len(matched)}  {how_counts}")
    for t in (500, 100, 50, 20):
        n = sum(1 for m in matched if m.get("votes", 0) >= t)
        tot = sum(1 for r in gap if r.get("votes", 0) >= t)
        print(f"  >= {t:>3} votes: {n}/{tot}")


# ---------------------------------------------------------------------- crawl

def unescape(s):
    return htmllib.unescape(s)


def parse_page(page):
    """{"year": int|None, "notes": {"top": [], "middle": [], "base": []} | {"flat": []}}"""
    tiers = {"t": [], "m": [], "b": [], "n": []}
    h1 = H1_RE.search(page)
    year = None
    if h1:
        ym = YEAR_RE.search(h1.group(1))
        if ym:
            year = int(ym.group(1))
    for m in NOTE_RE.finditer(page):
        nt, alt, text = m.groups()
        note = unescape((alt or text or "").strip())
        note = TAG_RE.sub("", note).strip()
        if note and note not in tiers[nt]:
            tiers[nt].append(note)
    if tiers["n"] and not (tiers["t"] or tiers["m"] or tiers["b"]):
        return year, {"flat": tiers["n"]}
    if tiers["t"] or tiers["m"] or tiers["b"]:
        return year, {"top": tiers["t"], "middle": tiers["m"], "base": tiers["b"]}
    return year, None


def cmd_crawl(limit, min_votes, fids):
    with open(MATCHES_PATH, encoding="utf-8") as f:
        matches = [json.loads(line) for line in f]
    done = set()
    if os.path.exists(NOTES_PATH):
        with open(NOTES_PATH, encoding="utf-8") as f:
            for line in f:
                done.add(json.loads(line)["fid"])
    todo = [m for m in matches if m["fid"] not in done and m.get("votes", 0) >= min_votes]
    if fids:
        todo = [m for m in todo if m["fid"] in fids]
    todo.sort(key=lambda m: -m.get("votes", 0))
    if limit:
        todo = todo[:limit]
    print(f"crawling {len(todo)} pages (~{len(todo) * DELAY / 60:.0f} min)", flush=True)
    got = 0
    with open(NOTES_PATH, "a", encoding="utf-8") as out:
        for i, m in enumerate(todo):
            try:
                page = get(m["parfumo_url"])
            except urllib.error.HTTPError as e:
                print(f"  [{i + 1}/{len(todo)}] {m['parfumo_url']} -> HTTP {e.code}", flush=True)
                time.sleep(DELAY)
                continue
            year, notes = parse_page(page)
            rec = {
                "fid": m["fid"],
                "name": m["name"],  # keep fragrantica naming, consistent with the index
                "brand": m["brand"],
                "year": m.get("year") or year,
                "gender": m.get("gender"),
                "rating": m.get("rating"),
                "votes": m.get("votes"),
                "url": m["parfumo_url"],
                "match": m.get("match"),
                "notes": notes,
            }
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if notes:
                got += 1
            if (i + 1) % 25 == 0 or i + 1 == len(todo):
                print(f"  [{i + 1}/{len(todo)}] {got} with notes", flush=True)
            time.sleep(DELAY)
    print(f"done: {got} new perfumes with notes -> {NOTES_PATH}")


def cmd_status():
    matches = []
    if os.path.exists(MATCHES_PATH):
        with open(MATCHES_PATH, encoding="utf-8") as f:
            matches = [json.loads(line) for line in f]
    done, with_notes = set(), 0
    if os.path.exists(NOTES_PATH):
        with open(NOTES_PATH, encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                done.add(rec["fid"])
                if rec.get("notes"):
                    with_notes += 1
    left = [m for m in matches if m["fid"] not in done]
    print(f"matched: {len(matches)}")
    print(f"crawled: {len(done)} ({with_notes} with notes)")
    print(f"left:    {len(left)}  (~{len(left) * DELAY / 3600:.1f} h at {DELAY}s/page)")
    for t in (100, 50):
        n = sum(1 for m in left if m.get("votes", 0) >= t)
        print(f"  left with >= {t} votes: {n}  (~{n * DELAY / 60:.0f} min)")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["sitemap", "match", "crawl", "status"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-votes", type=int, default=0)
    ap.add_argument("--fids", type=lambda s: {int(x) for x in s.split(",")}, default=None)
    args = ap.parse_args()
    if args.cmd == "sitemap":
        cmd_sitemap()
    elif args.cmd == "match":
        cmd_match()
    elif args.cmd == "crawl":
        cmd_crawl(args.limit, args.min_votes, args.fids)
    else:
        cmd_status()


if __name__ == "__main__":
    main()
