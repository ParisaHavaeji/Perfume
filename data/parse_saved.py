"""Parse Fragrantica perfume pages saved from a browser (Ctrl+S) into
raw/fragrantica_new.jsonl -- the manual fallback for when Cloudflare blocks
the plain-HTTP crawler.

Save each perfume page as HTML into a folder (default: raw/saved), then:

    python parse_saved.py
    python parse_saved.py --dir some/other/folder

Each file is matched to its index entry by the fid in the page's canonical
URL, so filenames don't matter. Records are appended exactly as `crawl`
would write them; already-crawled fids are skipped, so rerunning is safe.
Run build_dataset.py + clean_dataset.py afterwards to merge.
"""
import argparse
import json
import os
import re
import sys

from fragrantica_refresh import INDEX_PATH, NOTES_PATH, YEAR_RE, load_jsonl, parse_notes

DATA = os.path.dirname(os.path.abspath(__file__))
CANON_RE = re.compile(r'<link[^>]*rel="canonical"[^>]*>')
FID_RE = re.compile(r"/perfume/[^\"'\s]+-(\d+)\.html")


def find_fid(page):
    """fid from the canonical link, falling back to the first perfume URL
    in the file (the head's og:url, in practice)."""
    canon = CANON_RE.search(page)
    m = FID_RE.search(canon.group(0)) if canon else FID_RE.search(page)
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=os.path.join(DATA, "raw", "saved"), help="folder of saved .html pages")
    args = ap.parse_args()

    files = sorted(
        os.path.join(args.dir, f) for f in (os.listdir(args.dir) if os.path.isdir(args.dir) else [])
        if f.lower().endswith((".html", ".htm"))
    )
    if not files:
        sys.exit(f"no .html files in {args.dir} -- save the perfume pages there first (Ctrl+S in your browser)")

    index = {e["fid"]: e for e in load_jsonl(INDEX_PATH)}
    crawled = {r["fid"] for r in load_jsonl(NOTES_PATH)}

    ok = skipped = failed = 0
    with open(NOTES_PATH, "a", encoding="utf-8") as out:
        for path in files:
            base = os.path.basename(path)
            with open(path, encoding="utf-8", errors="replace") as f:
                page = f.read()
            fid = find_fid(page)
            if fid is None:
                print(f"  ? {base}: no perfume URL inside -- not a Fragrantica perfume page?")
                failed += 1
                continue
            if fid in crawled:
                print(f"  = {base}: fid {fid} already crawled, skipping")
                skipped += 1
                continue
            entry = index.get(fid)
            if entry is None:
                print(f"  ? {base}: fid {fid} not in {os.path.basename(INDEX_PATH)} -- reharvest the index?")
                failed += 1
                continue
            rec = dict(entry)
            parsed = parse_notes(page)
            if parsed:
                tiers, desc = parsed
                rec["notes"] = tiers
                ym = YEAR_RE.search(desc)
                if not rec["year"] and ym:
                    rec["year"] = int(ym.group(1))
                ok += 1
                print(f"  + {entry['brand']} - {entry['name']}: {sum(len(v) for v in tiers.values())} notes")
            else:
                rec["error"] = "no notes found"
                failed += 1
                print(f"  ! {entry['brand']} - {entry['name']}: page has no notes description")
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            crawled.add(fid)

    print(f"done: {ok} with notes, {failed} problems, {skipped} already crawled -> {NOTES_PATH}")
    if ok:
        print("next: python build_dataset.py && python clean_dataset.py && python verify.py")


if __name__ == "__main__":
    main()
