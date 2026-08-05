// Decoy note generation from data/out/notes_vocab.json tier frequencies.
//
// Rules (see plan.md):
// - Decoys for a column are weighted by how often a note really appears in
//   that tier, so a base-column decoy smells like a base note.
// - sqrt-weighting flattens the curve a little so it isn't always Bergamot.
// - Notes that barely occur in a tier are excluded; they read as fake.
// - Scoring is tier-agnostic, so a perfume's real notes (from ANY tier) are
//   never used as decoys anywhere in that round.
// - A decoy appears in at most one column per round.
import { readFileSync } from 'node:fs';
import { VOCAB_PATH, tiersOf, allNotes, norm } from './data.js';

const MIN_TIER_COUNT = 5; // a note must appear this often in a tier to be a plausible decoy there
const vocab = JSON.parse(readFileSync(VOCAB_PATH, 'utf8'));

// tier -> [{note, weight}], filtered once at startup.
const pools = new Map();
for (const tier of ['top', 'middle', 'base']) {
  pools.set(
    tier,
    vocab
      .filter((v) => (v[tier] ?? 0) >= MIN_TIER_COUNT)
      .map((v) => ({ note: v.note, weight: Math.sqrt(v[tier]) })),
  );
}
// Flat perfumes are mostly niche; their own tier counts are thin, so plausible
// decoys for a flat column draw on overall frequency instead.
pools.set(
  'flat',
  vocab.filter((v) => v.total >= MIN_TIER_COUNT * 2).map((v) => ({ note: v.note, weight: Math.sqrt(v.total) })),
);

function decoyCount(realCount, tier) {
  return tier === 'flat'
    ? Math.min(12, Math.max(6, realCount + 3))
    : Math.min(9, Math.max(4, realCount + 2));
}

/** Weighted sample without replacement, skipping excluded notes. */
function sample(pool, count, excluded) {
  const items = pool.filter((p) => !excluded.has(norm(p.note)));
  const picked = [];
  let totalWeight = items.reduce((sum, p) => sum + p.weight, 0);
  while (picked.length < count && items.length > 0) {
    let r = Math.random() * totalWeight;
    let i = 0;
    while (i < items.length - 1 && r >= items[i].weight) r -= items[i++].weight;
    const [item] = items.splice(i, 1);
    totalWeight -= item.weight;
    picked.push(item.note);
  }
  return picked;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build the choice columns for one round.
 * @returns {Array<{tier: string, notes: string[]}>} real notes and decoys, shuffled per column
 */
export function buildColumns(entry) {
  // Starts as the real notes of every tier; grows with each column's decoys.
  const excluded = new Set(allNotes(entry).map(norm));
  return tiersOf(entry).map((tier) => {
    const real = [...new Map(entry.notes[tier].map((n) => [norm(n), n.trim()])).values()];
    const decoys = sample(pools.get(tier), decoyCount(real.length, tier), excluded);
    for (const d of decoys) excluded.add(norm(d));
    return { tier, notes: shuffle([...real, ...decoys]) };
  });
}
