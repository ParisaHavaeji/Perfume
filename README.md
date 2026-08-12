# Smell Things

I hosted a party where I made cocktails inspired by the perfumes I was digging at the time, and made this app as the party game for the evening. The game is live at **https://smellthing.parisahavaeji.com**. 

The host lines up perfumes, guests join from their phones, everyone smells the same scent strip and guesses which notes are in it. Each round ends with a reveal and a ranking, and the night ends with a winner.

## Running a night

1. Open the site and create a game. That browser is now the host.
2. Search and queue perfumes. The search covers 69,430 of them. Three settings to decide: whether players see real names or just "Perfume #1", whether you're playing too, and how scoring works (below).
3. Send the join link. Guests pick a display name and wait in the lobby.
4. Pass the scent strip around and start the round. Everyone picks notes on their phone and locks in. You can't reveal until every connected player has locked; the bar at the bottom shows who's holding things up.
5. Reveal, enjoy the arguments, start the next round.

There are two ways to score a night, and the host picks. The default is to pick as many notes as you like, +10 for each right one, -10 for each wrong one, so ticking half the board would backfire. Best-guess mode instead caps everyone at their five surest picks (four, when the perfume doesn't have as many notes to begin with) and wrong picks cost nothing (added after a friend told me he felt like he was taking the Konkoor-- the Iranian university entrance exam). Best-guess is kinder to a first-timer who'd rather not finish round one at -40. The host can flip the switch between rounds, but a round already in progress keeps the rules it started with.

Either way, scoring ignores the scent pyramid; if Bergamot is really in the perfume, picking it counts, even in the wrong column (for example, chosen as the base note rather than the top).

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

`data/` holds the dataset and the Python pipeline that builds it. 

## The dataset

69,430 perfumes merged from three sources: Fragrantica (Kaggle scrape, 46,379), Parfumo (TidyTuesday CSV, 21,681 after removing overlap), and Luckyscent (own crawl, 1,659 niche releases the databases miss-- I get my perfumes from their DTLA store so it was the most straight forward way of ensuring all my perfumes were listed). Most have a top/middle/base pyramid; 1,762 list their notes flat and get a single-column interface in the game. If a perfume is still missing, the host can add it mid-game by pasting its parfumo.com link.

Pasted perfumes are meant to stay in the dataset for good. Locally that happens on its own (the record lands in `data/raw/parfumo_new.jsonl`, which the pipeline merges and the server replays at boot). On Render the free-tier disk resets on every restart, so the server also commits each add back to this repo over the GitHub API — set a `GITHUB_TOKEN` environment variable in the Render dashboard (a fine-grained personal access token with read/write access to this repo's Contents) to turn that on. `render.yaml` tells Render not to redeploy on those data-only commits, so an add during a game night won't restart the server. Without the token, a pasted perfume still works for the night but disappears when the instance next restarts.

The build emits `data/out/search_index.json` for the perfume picker, `data/out/notes/<n>.json` in shards of 1,000 so nothing loads the whole thing, and `data/out/notes_vocab.json` with per-tier note frequencies, which is what makes the decoys believable. Bottle images come from Fragrantica's CDN by id, or from the product page's og:image, fetched once and cached in `cache/images/`.

To rebuild:

```
cd data
python build_dataset.py
python clean_dataset.py
python verify.py
```

Some notes on data cleaning: restoring the leading numerals the Parfumo export strips ("1 Million" arrives as "Million"), splitting brand, year, and concentration out of names without breaking ones like "La Vie est Belle L'Eau de Parfum", collapsing 7,527 note spellings into 6,677, and unifying brands ("D.S. & Durga" used to be three different brands). The synonym merging is deliberately cautious (an early version folded Incense into Frankincense, which is wrong, and that mistake set the bar).

The data is scraped from public sources and meant for personal use.
