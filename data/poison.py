"""The Parfumo decoy-note fingerprint.

parfumo.com poisons unauthenticated fetches: randomized fake notes (and years)
are mixed into the real ones, so a row carrying ANY known decoy has a note
list that cannot be trusted at all — build_dataset.py drops such parfumo rows
whole, and verify.py asserts none survive.

The pool below was measured from the dataset (2026-08-18): every token is
parfumo-exclusive, uniformly sampled (~15-70 rows each), and spread across
brands that would never carry it (Avon, 4711, Bath & Body Works). Three
families: pure gibberish, adjective+note fabrications, and "disgusting" notes.
This is a frozen, reviewable list on purpose — a co-occurrence expansion finds
nothing more (decoys land ~one per row), so re-scan for new pool tokens after
any future crawl. Matching is on textnorm.norm_key of the note name.
Real-word collateral is accepted and tiny: e.g. "Rust" is a genuine note on a
luckyscent row (Beaufort Pyroclasm), which survives because only parfumo rows
are ever dropped.
"""
from textnorm import norm_key

GIBBERISH = [
    "Blimfark", "Blorkzanthumer", "Bregnotrix", "Brimzalthok", "Clorpt",
    "Crondivexil", "Drenzlor", "Drindle", "Drupzelwinkon", "Dwebnorplix",
    "Fempzilnordax", "Finglebop", "Flabtus", "Flibtix", "Flixzampuron",
    "Glimzorith", "Glomtak", "Gorptik", "Grebzor", "Grimtak", "Gronthelwix",
    "Grothzenvixol", "Hempzidralok", "Humdraxpelum", "Jilthzorpanex",
    "Junkrothfelm", "Klempzordivan", "Krunzelpithor", "Lorpzinvethul",
    "Moplonk", "Muxbrantolyx", "Nebulonix", "Norbflixtamor", "Plonktar",
    "Plorzinkwedal", "Pungidity", "Quarklox", "Quembrathosin", "Quintozar",
    "Rilthondexum", "Sneerlax", "Snorplax", "Thrumvoxeldran", "Trungle",
    "Urpzilthnomex", "Vexlim", "Vextronplibar", "Vorblex", "Vorplaxa",
    "Vorptal", "Wumzkalthiron", "XylophazQ", "Xondripleval", "Yorbzinthalux",
    "Zarbot", "Zarquon", "Zempfrixdolam", "Zenthorium", "Zorplox",
]

FABRICATED = [
    "Abstract Ambrette", "Aged Pepper", "Angular Anise", "Backwards Bergamot",
    "Bifurcated Vetiver", "Branched Benzoin", "Calcified Cypress",
    "Compressed Cardamom", "Conjugated Labdanum", "Diagonal Sandalwood",
    "Displaced Daffodil", "Distorted Davana", "Drowsy Iris", "Echoed Elemi",
    "Fermented Almond", "Forgotten Frankincense", "Ghost Galbanum",
    "Hexagonal Frangipani", "Hollow Musk", "Hypothetical Heliotrope",
    "Inverse Incense", "Inverted Amber", "Layered Lotus",
    "Melancholic Myrrh", "Mirrored Magnolia", "Negative Narcissus",
    "Nervous Neroli", "Nested Nutmeg", "Oblique Oakmoss", "Orbital Orris",
    "Parallel Patchouli", "Perpendicular Pepper", "Petrified Petitgrain",
    "Phantom Peony", "Pivoted Plum", "Quantum Jasmine", "Recursive Rose",
    "Refracted Tuberose", "Residual Rosewood", "Rotated Resins",
    "Scaled Smoke", "Shadow Sage", "Silent Cedar", "Simulated Suede",
    "Spectral Styrax", "Suspended Saffron", "Tangential Tonka",
    "Theoretical Tobacco", "Translated Turmeric", "Vertical Vanilla",
    "Virtual Violet",
]

GROSS = [
    "Acid", "Acridity", "Bilge", "Brine", "Burnt Electronics", "Cabbage",
    "Carcass", "Carrion", "Chemical", "Chlorine", "Contamination", "Damp",
    "Dankness", "Decay", "Decomposing Leaf", "Diesel", "Disgust", "Filth",
    "Foulness", "Fume", "Funk", "Garbage", "Grease", "Grim", "Grunge",
    "Gymwear", "Harshness", "Infestation", "Malodor", "Manure",
    "Melting Plastic", "Mildew", "Mold", "Moldy Leather", "Moldy Wallpaper",
    "Mothball", "Must", "Nastiness", "Nausea", "Noxiousness", "Odor",
    "Offense", "Onion", "Pollution", "Pungency", "Putrescence", "Putridity",
    "Rancid Oil", "Rancidness", "Rankness", "Repulse", "Rot", "Rotten Egg",
    "Rotten Onion", "Rotting Flower", "Rust", "Scum", "Sewage", "Sewer",
    "Skunk", "Sludge", "Smog", "Sock", "Sour Milk", "Spoil", "Spoilage",
    "Spoiled Meat", "Spoiled Spice", "Stalebread", "Staleness", "Stench",
    "Stink", "Sulfur", "Swamp", "Vinegar",
]

POISON_KEYS = {norm_key(n) for n in GIBBERISH + FABRICATED + GROSS}


def is_poisoned(p):
    """True for a parfumo row whose note list carries any known decoy."""
    return p["source"] == "parfumo" and any(
        norm_key(n) in POISON_KEYS for tier in p["notes"].values() for n in tier
    )
