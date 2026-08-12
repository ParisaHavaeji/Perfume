// Durable store for live-added perfumes (the "paste a Parfumo link" flow).
// The local append to data/raw/parfumo_new.jsonl is enough on a laptop, but
// Render's free tier resets the disk on every deploy and idle spin-down, so
// on its own a live add only lasts until the instance restarts. When a
// GITHUB_TOKEN is set we therefore mirror every add into the same file in
// the GitHub repo, and replay that file into the served dataset at boot —
// a perfume pasted once stays in the dataset forever.
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPerfume, findByUrl } from './data.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_NOTES_PATH = path.join(ROOT, 'data', 'raw', 'parfumo_new.jsonl');

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO ?? 'ParisaHavaeji/Perfume';
const BRANCH = process.env.GITHUB_BRANCH ?? 'main';
const API_URL = `https://api.github.com/repos/${REPO}/contents/data/raw/parfumo_new.jsonl`;

const GH_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'nose-game',
};

/** Structure/notes fields from a {top, middle, base} dict (build_dataset.tiers_to_entry). */
export function tiersToEntry(tiers) {
  const filled = ['top', 'middle', 'base'].filter((t) => tiers[t]?.length);
  if (filled.length === 1) return { structure: 'flat', notes: { flat: tiers[filled[0]] } };
  return { structure: filled.length === 3 ? 'pyramid' : 'partial', notes: tiers };
}

/** Current file content in the repo plus the sha needed to update it. */
async function ghRead() {
  const res = await fetch(`${API_URL}?ref=${BRANCH}`, { headers: GH_HEADERS });
  if (res.status === 404) return { text: '', sha: null }; // file not committed yet
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const body = await res.json();
  return { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

async function ghAppend(line, record) {
  // read-append-write with the sha as optimistic lock; one retry on conflict
  for (let attempt = 0; ; attempt++) {
    const { text, sha } = await ghRead();
    if (text.includes(`"url":${JSON.stringify(record.url)}`)) return; // already saved
    const base = text && !text.endsWith('\n') ? text + '\n' : text;
    const res = await fetch(API_URL, {
      method: 'PUT',
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: `live add: ${record.brand} - ${record.name}`,
        content: Buffer.from(base + line).toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return;
    if ((res.status === 409 || res.status === 422) && attempt === 0) continue;
    throw new Error(`GitHub write failed (${res.status})`);
  }
}

/**
 * Persist a live-added perfume record: always to the local jsonl (feeds the
 * offline pipeline and local restarts), and to the GitHub copy when a token
 * is configured. A GitHub failure never fails the add itself — the perfume
 * still works for the night, it just won't outlive the next deploy.
 */
export async function appendRecord(record) {
  const line = JSON.stringify(record) + '\n';
  await appendFile(RAW_NOTES_PATH, line, 'utf8');
  if (!TOKEN) return;
  try {
    await ghAppend(line, record);
  } catch (err) {
    console.error(`live-adds: could not save ${record.url} to GitHub: ${err.message}`);
  }
}

function* parseRecords(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      console.error(`live-adds: skipping malformed line: ${line.slice(0, 80)}`);
    }
  }
}

/**
 * Re-add every stored live add that the dataset on disk doesn't have yet.
 * Runs once at boot, after initData(). Reads the local jsonl and (with a
 * token) the GitHub copy — the union covers both a fresh Render instance
 * (empty disk, populated repo) and a laptop running without a token.
 */
export async function replayLiveAdds() {
  const texts = [];
  try {
    texts.push(await readFile(RAW_NOTES_PATH, 'utf8'));
  } catch {} // no local adds yet
  if (TOKEN) {
    try {
      texts.push((await ghRead()).text);
    } catch (err) {
      console.error(`live-adds: could not read from GitHub: ${err.message}`);
    }
  }
  let restored = 0;
  for (const record of parseRecords(texts.join('\n'))) {
    if (!record?.url || !record?.notes) continue;
    if (await findByUrl(record.url)) continue;
    const { structure, notes } = tiersToEntry(record.notes);
    await addPerfume({ ...record, structure, notes });
    restored++;
  }
  if (restored) console.log(`live-adds: restored ${restored} perfume(s) into the dataset`);
}
