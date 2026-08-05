# Parisa's Perfume Night

A party game for perfume nerds. The host lines up perfumes, guests join from their phones through a link, everyone smells the same bottle, and then everyone guesses which notes are actually in it. Right answers score 10 points, wrong ones cost 10. Each round ends with a reveal and a ranking, and the night ends with a winner.

The whole thing runs on one laptop. There are no accounts and no database, and nothing needs a build step.

## Running it

You need Node 18 or newer.

```
npm install
npm start
```

The site is at http://localhost:3000 (set `PORT` to change it). Guests need to reach your machine, so they should be on the same wifi, with the link using your LAN address instead of localhost. A tunnel like ngrok also works.

Games live in server memory and disappear after 12 hours of inactivity, or when the server restarts. For a party, that's a feature.

## How a night works

1. Open the site, click Create game. You're the host now; a key in your browser's localStorage proves it, so only that browser can run the game.
2. Search perfumes and queue them. The search covers 69,430 perfumes. Bottle photos download in the background as you add things.
3. Decide two settings: whether players see real names or just "Perfume #1" (hidden by default, better for guessing), and whether you're playing too or just running the show. Spectating hosts see the real answers during the round; the decoys show up dimmed.
4. Copy the join link and send it to the group. Guests pick a display name and wait in the lobby.
5. Pass the bottle around, start the round. Everyone picks notes on their phone and locks in. You can't reveal until every connected player has locked; the bar at the bottom tells you who's holding things up. If someone's phone dies, they stop blocking the reveal.
6. Reveal, enjoy the arguments, start the next round. After the last one, announce the winner and, if the night is going well, start a new game from right there.

Scoring ignores the pyramid: if Bergamot is really in the perfume, picking it counts, even if you found it in the wrong column. The columns exist to make you commit to more guesses, not to trick you twice.

## What's in the box

- `server/` is a plain Node server. Its only dependency is `ws` for the WebSockets. Rooms, players, and scores are held in memory; the server is authoritative and sends each client only what that client is allowed to see, so nobody can read the answers out of devtools mid-round.
- `public/` is the frontend: two HTML pages, one JS file, one stylesheet, no framework.
- `data/` holds the dataset and the Python pipeline that builds it (details below).
- `cache/images/` fills up with bottle photos as perfumes get queued, fetched once each.
- `plan.md` is the full spec, worth reading before touching the game logic.

The look borrows from heliotemil.com: black on white, Helvetica, two font sizes, uppercase everything, gray hairlines instead of boxes. The styles were written against measurements from the live site, not from memory of it.

The decoy notes are the quiet trick of the game. Fake candidates are drawn using per-tier frequency counts across the whole dataset, so a fake base note is something that plausibly *is* a base note (Musk, Amber) rather than a random word. Real notes are excluded from the decoy pool everywhere, including across tiers.

## The dataset

69,430 perfumes with their notes, merged from three sources:

- Fragrantica (Kaggle scrape): 46,379 perfumes. The notes aren't in structured columns; they get parsed out of the description text ("Top notes are Lemon, Mandarin Orange...").
- Parfumo (TidyTuesday 2024-12-10 CSV): 21,681 additions after removing overlap with Fragrantica.
- Luckyscent (own crawl): 1,659 niche perfumes from product pages, because neither database covers newer indie releases well.

Most perfumes have a top/middle/base pyramid. 1,762 list their notes flat instead, which is common for niche houses. The data keeps that distinction (`structure: "flat"`), and those perfumes get a single-column interface in the game.

### Files

- `data/perfumes.json` is the full dataset and the source of truth (25 MB).
- `data/out/search_index.json` has id, name, brand, and year for the perfume picker, sorted by popularity.
- `data/out/notes/<n>.json` holds the note data in shards of 1,000 perfumes, so nothing ever loads the whole thing.
- `data/out/notes_vocab.json` lists every note with per-tier frequency counts. This is what makes believable decoys possible: Musk appears 30,000 times as a base note and 311 times as a top note, so a fake "Musk" belongs in the base column.

Every perfume also carries a bottle image reference. Fragrantica entries store a `fid`, and the image lives at `https://fimgs.net/mdimg/perfume/375x500.<fid>.jpg`. Parfumo and Luckyscent entries store their product page URL instead, so the server pulls the `og:image` once and caches it when a perfume gets queued.

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

The data comes from scraped public sources and is intended for personal use. There are coverage gaps: Mariage Frères sells perfume but publishes no notes anywhere we pull from, and releases newer than the crawl date won't appear until the crawl is re-run. A manual "enter your own notes" option is still on the wishlist as the escape hatch.
