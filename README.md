# Smell Things

I hosted a party where I made cocktails inspired by the perfumes I was digging at the time, and made this app as the party game for the evening. The game is live at **https://smellthings.parisahavaeji.com/**. It has since grown a second page, Smell List, which is the page I use more: a filter for what to go sniff when I'm standing in a store and trying to see what a particular note smelled like.

The host lines up perfumes, guests join from their phones, everyone smells the same scent strip and guesses which notes are in it. Each round ends with a reveal and a ranking, and the night ends with a winner.

## Running a night

1. Open the site and create a game. That browser is now the host.
2. Search and queue perfumes. The search covers 82,659 of them. Three settings to decide: whether players see real names or just "Perfume #1", whether you're playing too, and how scoring works (below).
3. Send the join link. Guests pick a display name and wait in the lobby.
4. Pass the scent strip around and start the round. Everyone picks notes on their phone and locks in. You can't reveal until every connected player has locked; the bar at the bottom shows who's holding things up.
5. Reveal, enjoy the arguments, start the next round.

There are two ways to score a night, and the host picks. The default is to pick as many notes as you like, +10 for each right one, -10 for each wrong one, so ticking half the board would backfire. Best-guess mode instead caps everyone at their five surest picks (four, when the perfume doesn't have as many notes to begin with) and wrong picks cost nothing (added after a friend told me he felt like he was taking the Konkoor-- the Iranian university entrance exam). Best-guess is kinder to a first-timer who'd rather not finish round one at -40. The host can flip the switch between rounds, but a round already in progress keeps the rules it started with.

Either way, scoring ignores the scent pyramid; if Bergamot is really in the perfume, picking it counts, even in the wrong column (for example, chosen as the base note rather than the top).

The decoys are the quiet trick of the game. Fake notes are drawn from per-tier frequency counts across the whole dataset, so a fake base note is something that plausibly is a base note (Musk, Amber) rather than a random word.

## Smell List

I kept walking into Scent Bar wanting "something with tea and nothing with apple" and having no way to ask the shelf, so the game's dataset got a second front end at `/list`.

Pick a location or leave it on Anywhere, then type what you like and what you avoid. Both boxes take notes and brands, so "vanilla, oud, Le Labo" is a fine answer to "I like". By default a perfume has to match every "I like" pick; there's a switch to make it any of them instead. Results come back as cards in the game's reveal layout, wanted notes in black ink and the rest dimmed, sorted by popularity, rating, or year. A Smelled button on each card keeps a checklist in your browser so a second visit can hide what you've already tried, and "Surprise me" pulls one at random from whatever the filters left. The last results are cached, so the page still works in a store with no signal.

The location list is LA only, because that's where I am: seven chains (Sephora, Ulta, Nordstrom, Bloomingdale's, Macy's, Neiman Marcus, Saks), three boutiques (Scent Bar, The Scent Room, Beverly Hills Perfumery), and nine single-brand flagships (Le Labo, Byredo, Diptyque, Frédéric Malle, and so on). A store filters by the brands it carries, not by what's on the shelf today; the picker says so and shows the month each list was read. Chain lists come from the retailers' own "available in store" filters, read one door at a time (Sephora is just the USC Village cluster, and Saks is their website's brand list, since their store pages don't expose one). Boutique lists are curated by hand, except Scent Bar's, which is derived from the Luckyscent crawl because it's their store. The lists live in `data/stores.json` and `data/raw/chains/`, and `build_stores.py` resolves the retailers' spellings against the dataset's brands. It fails the build on any alias that doesn't resolve, so a typo can't quietly shrink a store.

The "best rated" sort only ranks perfumes with at least five votes.

## Layout

`server/` is a plain Node server whose only dependency is `ws`. Rooms, players, and scores are held in memory, and the server sends each client only what it's allowed to see, so nobody can read the answers out of devtools mid-round. `smelllist.js` builds the note and brand indexes for the list page at boot and serves its API.

`public/` is the frontend: three HTML pages, one JS file each, one stylesheet, no framework.

`data/` holds the dataset and the Python pipeline that builds it.

## The dataset

82,659 perfumes merged from several sources: Fragrantica (46,668-- a Kaggle scrape plus a small refresh crawl before the site started blocking crawlers), Parfumo (16,782-- the TidyTuesday CSV; a 2024+ gap crawl, `data/parfumo_gap.py`, exists but is quarantined because Parfumo poisons scripted fetches, see `data/DATASET_NOTES.md`), rdemarqui's Fragrantica scrape (17,252-- github.com/rdemarqui/perfume_recommender, flat notes only, and about 10,000 of them have no picture at all), Luckyscent (own crawl, 1,655 niche releases the databases miss-- I get my perfumes from their DTLA store so it was the most straight forward way of ensuring all my perfumes were listed), and a few brand and retailer catalogs (The Scent Room, Malin+Goetz, Elorea). Most have a top/middle/base pyramid; 19,053 list their notes flat and get a single-column interface in the game.

There used to be a mid-game "paste a parfumo.com link" flow for missing perfumes, but Parfumo serves deliberately falsified notes to scripted fetches (see `data/DATASET_NOTES.md`), so the feature is removed until it can be rebuilt on another source.

The build emits `data/out/search_index.json` for the perfume picker, `data/out/notes/<n>.json` in shards of 1,000 so nothing loads the whole thing, `data/out/notes_vocab.json` with per-tier note frequencies, which is what makes the decoys believable, and `data/out/stores.json` for the list page. Bottle images come from Fragrantica's CDN by id, or from the product page's og:image, fetched once and cached in `cache/images/`. Render's disk doesn't survive a deploy, so the images that need a page scrape (Luckyscent, Scent Room, the flagships) are also committed under `data/image_seed/`, keyed by URL rather than id because every pipeline rerun renumbers the ids. After adding a source, `node server/warm_images.js <brand>` and then `node server/seed_images.js` refresh that folder.

To rebuild:

```
cd data
python build_dataset.py
python clean_dataset.py
python build_stores.py
python verify.py
```

Some notes on data cleaning: restoring the leading numerals the Parfumo export strips ("1 Million" arrives as "Million"), splitting brand, year, and concentration out of names without breaking ones like "La Vie est Belle L'Eau de Parfum", merging duplicate note spellings down to 6,380 notes, and unifying brands ("D.S. & Durga" used to be three different brands, and ~76 more houses arrived split like "Zoologist" / "Zoologist Perfumes"; 3,800 remain). The synonym merging is deliberately cautious (an early version folded Incense into Frankincense, which is wrong, and that mistake set the bar).

## License

The code is MIT-licensed (see [LICENSE](LICENSE)). The dataset is scraped from public sources, is meant for personal use, and isn't covered by that license.
