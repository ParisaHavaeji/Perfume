"""Sanity checks for the pipeline output. Run after clean_dataset.py; exits 1 on failure."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clean_dataset import BRAND_DISPLAY_OVERRIDES, TIER2_FORMAT_KEYS
from textnorm import norm_key

DATA = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DATA, "out")

failures = []


def check(ok, msg):
    print(("ok   " if ok else "FAIL ") + msg)
    if not ok:
        failures.append(msg)


with open(os.path.join(DATA, "perfumes.json"), encoding="utf-8") as f:
    perfumes = json.load(f)

check(len(perfumes) > 65000, f"dataset size: {len(perfumes)}")
check(all(p["id"] == i for i, p in enumerate(perfumes)), "ids are contiguous and ordered")
check(all(p["structure"] in ("pyramid", "flat", "partial") for p in perfumes), "structures valid")
check(all(any(p["notes"].values()) for p in perfumes), "every perfume has at least one note")
check(all(p.get("fid") or p.get("url") for p in perfumes), "every perfume has an image reference")

flat = sum(p["structure"] == "flat" for p in perfumes)
check(flat > 1500, f"flat-structure perfumes: {flat}")

sauvage = next((p for p in perfumes if p["name"] == "Sauvage" and p["brand"] == "Dior"), None)
check(sauvage is not None and sauvage["notes"]["top"], "Dior Sauvage present with top notes")
million = next((p for p in perfumes if p["name"] == "1 Million"), None)
check(million is not None, '"1 Million" name restored from Parfumo Number column')

dataset_brands = {p["brand"] for p in perfumes}
check(all(v in dataset_brands for v in BRAND_DISPLAY_OVERRIDES.values()),
      "brand display overrides applied (D.S. & Durga et al.)")

vocab_notes = {n for p in perfumes for t in p["notes"].values() for n in t}
check(not any(n[:1].islower() for n in vocab_notes), "no lowercase-leading note names")
check("Frankincense" in vocab_notes and "Incense" in vocab_notes, "Frankincense and Incense kept distinct")

with open(os.path.join(OUT, "search_index.json"), encoding="utf-8") as f:
    index = json.load(f)
check(len(index) == len(perfumes), "search index covers every perfume")
counts = [p.get("ratingCount") or 0 for p in perfumes]
check(counts == sorted(counts, reverse=True), "index sorted by popularity")

shard_files = os.listdir(os.path.join(OUT, "notes"))
expected_shards = (len(perfumes) - 1) // 1000 + 1
check(len(shard_files) == expected_shards, f"shard count: {len(shard_files)}")
with open(os.path.join(OUT, "notes", "0.json"), encoding="utf-8") as f:
    shard0 = json.load(f)
check(len(shard0) == 1000, "shard 0 holds 1000 entries")
check(all({"notes", "structure", "name", "brand"} <= set(e) for e in shard0.values()),
      "shard entries carry required fields")

with open(os.path.join(OUT, "notes_vocab.json"), encoding="utf-8") as f:
    vocab = json.load(f)
check(vocab[0]["total"] >= vocab[-1]["total"], "vocab sorted by frequency")
musk = next(v for v in vocab if v["note"] == "Musk")
check(musk["base"] > 10 * musk["top"], "Musk is overwhelmingly a base note (tier counts sane)")

with open(os.path.join(OUT, "find_meta.json"), encoding="utf-8") as f:
    meta = json.load(f)
scales = {"fragrantica": 5, "parfumo": 10}
check(len(meta) == len(index), "find_meta length matches search index (at pipeline time)")
check(all((m is None) == (p["rating"] is None or p["source"] not in scales)
          for m, p in zip(meta, perfumes)),
      "find_meta null exactly when unrated (incl. all luckyscent)")
check(all(m is None or (0 <= m[0] <= m[1] == scales[p["source"]])
          for m, p in zip(meta, perfumes)),
      "find_meta ratings within [0, scale], scale matches source")
check(all(m is None or (m[2] is not None) == ((p.get("ratingCount") or 0) >= 5)
          for m, p in zip(meta, perfumes)),
      "percentile null exactly when ratingCount < 5 (honesty gate)")
for src in scales:
    pairs = sorted((m[0], m[2]) for m, p in zip(meta, perfumes)
                   if p["source"] == src and m is not None and m[2] is not None)
    monotone = all(a[1] <= b[1] for a, b in zip(pairs, pairs[1:]))
    ties = all(a[1] == b[1] for a, b in zip(pairs, pairs[1:]) if a[0] == b[0])
    check(monotone and ties, f"{src} percentile monotone in rating, ties share a value")

with open(os.path.join(OUT, "stores.json"), encoding="utf-8") as f:
    stores = json.load(f)
brand_set = {p["brand"] for p in perfumes}
check(all(b in brand_set for s in stores for b in s["brands"]),
      "every emitted store brand exists verbatim in the dataset")
check(all(s["perfumes"] > 0 for s in stores), "every emitted store has perfumes > 0")
check(all(len(s["brands"]) == 1 for s in stores if s["kind"] == "flagship"),
      "flagship stores have exactly one brand")

with open(os.path.join(OUT, "dedup.json"), encoding="utf-8") as f:
    dedup = json.load(f)
sup = {int(k): v for k, v in dedup["suppress"].items()}
union = dedup["unionNotes"]
n = len(perfumes)
check(all(0 <= s < n and 0 <= c < n for s, c in sup.items()), "dedup ids in range")
check(not set(sup) & set(sup.values()), "no canonical id is itself suppressed")
check(4000 < len(sup) < 12000, f"dedup magnitude sane: {len(sup)}")
check(all(perfumes[s]["brand"] == perfumes[c]["brand"] for s, c in sup.items()),
      "suppressed and canonical share the exact brand string")


def base_key(name):
    k = norm_key(name)
    for fmt in TIER2_FORMAT_KEYS:
        if k.endswith(fmt) and len(k) > len(fmt):
            return k[: -len(fmt)]
    return k


check(all(base_key(perfumes[s]["name"]) == base_key(perfumes[c]["name"]) for s, c in sup.items()),
      "suppressed and canonical share the base name key")

dedup_groups = {}
for s, c in sup.items():
    dedup_groups.setdefault(c, [c]).append(s)


def pick_key(p, base):
    return (norm_key(p["name"]) != base,  # base name first
            p["rating"] is None or (p["ratingCount"] or 0) < 5,  # then gate-passing rating
            p["source"] != "fragrantica",
            p["id"])


bad_pick = [c for c, ids in dedup_groups.items()
            if min(ids, key=lambda i: pick_key(perfumes[i], base_key(perfumes[c]["name"]))) != c]
check(not bad_pick, "canonical pick matches the pinned priority order")

check(union == [i for i in sorted(sup) if perfumes[i]["source"] != "parfumo"],
      "unionNotes = exactly the non-parfumo suppressed ids, ascending")

sup_ids = set(sup)
unsup_counts = {}
for p in perfumes:
    if p["id"] not in sup_ids:
        unsup_counts[p["brand"]] = unsup_counts.get(p["brand"], 0) + 1
check(all(s["perfumes"] == sum(unsup_counts.get(b, 0) for b in s["brands"]) for s in stores),
      "store perfume counts exclude suppressed rows")

oil = next((p for p in perfumes if p["brand"] == "Le Labo" and p["name"] == "Neroli 36 Perfume Oil"), None)
oil_canon = oil and sup.get(oil["id"])
check(oil_canon is not None and perfumes[oil_canon]["name"] == "Neroli 36",
      "Neroli 36 Perfume Oil folds into Neroli 36")

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
