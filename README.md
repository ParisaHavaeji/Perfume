# Smell Things

A party game. The host lines up perfumes, guests join from their phones, everyone smells the same bottle and guesses which notes are in it. Right answers are +10, wrong ones are -10. Each round ends with a reveal and a ranking, and the night ends with a winner.

The game is live at **https://smellthing.parisahavaeji.com**. There are no accounts and no database, and nothing needs a build step.

## Running a night

1. Open the site and create a game. That browser is now the host.
2. Search and queue perfumes. The search covers 69,430 of them. Two settings to decide: whether players see real names or just "Perfume #1", and whether you're playing too or just running the show.
3. Send the join link. Guests pick a display name and wait in the lobby.
4. Pass the bottle around and start the round. Everyone picks notes on their phone and locks in. You can't reveal until every connected player has locked; the bar at the bottom shows who's holding things up.
5. Reveal, enjoy the arguments, start the next round.

Scoring ignores the scent pyramid; if Bergamot is really in the perfume, picking it counts, even in the wrong column.

The decoys are the quiet trick of the game. Fake notes are drawn from per-tier frequency counts across the whole dataset, so a fake base note is something that plausibly is a base note (Musk, Amber) rather than a random word.

## Running it locally

You need Node 18 or newer.

```
npm install
npm start
```

The site is at http://localhost:3000. Guests need to reach your machine, so use your LAN address or a tunnel like ngrok. Games live in server memory and disappear after 12 hours of inactivity, or when the server restarts.



## Layout

`server/` is a plain Node server whose only dependency is `ws`. Rooms, players, and scores are held in memory, and the server sends each client only what it's allowed to see, so nobody can read the answers out of devtools mid-round.

`public/` is the frontend: two HTML pages, one JS file, one stylesheet, no framework.

`data/` holds the dataset and the Python pipeline that builds it. `plan.md` is the full spec, worth reading before touching the game logic.

## The dataset

69,430 perfumes merged from three sources: Fragrantica (Kaggle scrape, 46,379), Parfumo (TidyTuesday CSV, 21,681 after removing overlap), and Luckyscent (own crawl, 1,659 niche releases the databases miss). Most have a top/middle/base pyramid; 1,762 list their notes flat and get a single-column interface in the game.

The build emits `data/out/search_index.json` for the perfume picker, `data/out/notes/<n>.json` in shards of 1,000 so nothing loads the whole thing, and `data/out/notes_vocab.json` with per-tier note frequencies, which is what makes the decoys believable. Bottle images come from Fragrantica's CDN by id, or from the product page's og:image, fetched once and cached in `cache/images/`.

To rebuild:

```
cd data
python build_dataset.py
python clean_dataset.py
python verify.py
```

Some notes on data cleaning: restoring the leading numerals the Parfumo export strips ("1 Million" arrives as "Million"), splitting brand, year, and concentration out of names without breaking ones like "La Vie est Belle L'Eau de Parfum", collapsing 7,527 note spellings into 6,677, and unifying brands ("D.S. & Durga" used to be three different brands). The synonym merging is deliberately cautious: an early version folded Incense into Frankincense, which is wrong, and that mistake set the bar.

The data is scraped from public sources and meant for personal use. Coverage has gaps, and releases newer than the crawl won't appear until it's re-run.
