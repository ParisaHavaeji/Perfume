# Perfume note guessing game

A party game for perfume nerds. The host lines up some perfumes, players join through a link, and everyone guesses which notes are actually in each scent. Right answers score 10 points, wrong ones cost 10. There's a reveal and ranking after every round, plus an overall leaderboard at the end.

The game itself isn't built yet. What's here so far is the data layer.

## The dataset

69,430 perfumes with their notes, merged from three sources:

- Fragrantica (Kaggle scrape): 46,379 perfumes. The notes aren't in structured columns; they get parsed out of the description text ("Top notes are Lemon, Mandarin Orange...").
- Parfumo (TidyTuesday 2024-12-10 CSV): 21,681 additions after removing overlap with Fragrantica.
- Luckyscent (own crawl): 1,659 niche perfumes from product pages, because neither database covers newer indie releases well.

Most perfumes have a top/middle/base pyramid. 1,762 list their notes flat instead, which is common for niche houses. The data keeps that distinction (`structure: "flat"`) so the game can show a different interface for them.

### Files

- `data/perfumes.json` is the full dataset and the source of truth (25 MB).
- `data/out/search_index.json` has id, name, brand, and year for the perfume picker, sorted by popularity.
- `data/out/notes/<n>.json` holds the note data in shards of 1,000 perfumes, so the client never loads the whole thing.
- `data/out/notes_vocab.json` lists every note with per-tier frequency counts. This is what makes believable decoy answers possible: Musk appears 30,000 times as a base note and 311 times as a top note, so a fake "Musk" belongs in the base column.

Every perfume also carries a bottle image reference for the reveal screen. Fragrantica entries store a `fid`, and the image lives at `https://fimgs.net/mdimg/perfume/375x500.<fid>.jpg`. Parfumo and Luckyscent entries store their product page URL instead, so the game server can pull the `og:image` once and cache it when a perfume gets queued.

### Rebuilding

```
cd data
python build_dataset.py    # merge raw sources
python clean_dataset.py    # normalize, dedupe, emit the files in data/out
python verify.py           # invariant checks on the output
```

Raw inputs live in `data/raw/`: the Fragrantica and Parfumo CSVs, plus `luckyscent_notes.jsonl` produced by `data/luckyscent_refresh.py`. That script finds Luckyscent products missing from the dataset and crawls them, resumably, at about one request per second; `--dry-run` reports what it would fetch.

### What the cleaning fixes

Things learned the hard way:

- The TidyTuesday Parfumo export moves leading numerals into a separate column, so "1 Million" arrives as "Million". The build step puts them back.
- Parfumo names embed the brand, year, and concentration ("English Freesia Yardley 2017 Eau de Toilette"). These get split into separate fields, with a guard so real product names like "La Vie est Belle L'Eau de Parfum" don't lose their tails.
- Note spellings needed canonicalizing: 7,527 raw variants collapse to 6,677 ("Lily-of-the-Valley" vs "Lily of the valley", "Vetyver" vs "Vetiver"). The synonym merging is deliberately cautious. An early version folded Incense into Frankincense, which is wrong, and that mistake set the bar for how aggressive the mapping gets to be.
- Brand spellings are unified. "D.S. & Durga", "DS and Durga", and "DS Durga" used to be three different brands.
- Luckyscent sometimes lists compound notes ("Cedar And Cashmere Wood"), which get split in two.

### Caveats

The data comes from scraped public sources and is intended for personal use. There are coverage gaps: Mariage Frères sells perfume but publishes no notes anywhere we pull from, and releases newer than the crawl date won't appear until the crawl is re-run. A manual "enter your own notes" option is planned as the escape hatch.

## The game (planned)

The host queues perfumes from a search dropdown and decides whether players see real names or just "Perfume #3". Players join by link and pick a display name. Each perfume shows candidate notes per tier, a mix of real ones and decoys, and players pick what they believe is in the bottle. The host triggers the reveal, and scores update. Pyramid perfumes get three columns; flat ones get a single list.
