"""Sanity checks for the pipeline output. Run after clean_dataset.py; exits 1 on failure."""
import json
import os
import sys

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

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
