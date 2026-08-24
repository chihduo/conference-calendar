#!/usr/bin/env node
/* Tier 0 - ICORE conference rankings.
   The portal 403s without a browser User-Agent, and its bulk CSV export hands
   over every ranked venue in a single request, so ranks never need scraping. */
import fs from 'node:fs';
import path from 'node:path';
import { RANK_DIR, fetchText } from '../lib.mjs';

export const EDITION = 'ICORE2026';
const EXPORT_URL = `https://portal.core.edu.au/conf-ranks/?search=&by=all&source=${EDITION}&sort=arank&page=1&do=Export`;
const CACHE = path.join(RANK_DIR, `${EDITION.toLowerCase()}.csv`);

/* Minimal RFC-4180 reader: venue titles contain commas and are quoted. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 4 && r[0]);
}

/** Fetch the ranking table, caching to disk. maxAgeDays=0 forces a refetch. */
export async function loadRanks({ maxAgeDays = 30, offline = false } = {}) {
  let text;
  const fresh = fs.existsSync(CACHE) &&
    (Date.now() - fs.statSync(CACHE).mtimeMs) / 86400000 < maxAgeDays;
  if (fresh || offline) {
    if (!fs.existsSync(CACHE)) throw new Error(`no cached ranks at ${CACHE} and offline requested`);
    text = fs.readFileSync(CACHE, 'utf8');
  } else {
    text = await fetchText(EXPORT_URL, { timeout: 60000 });
    fs.mkdirSync(RANK_DIR, { recursive: true });
    fs.writeFileSync(CACHE, text);
  }
  return parseCSV(text).map((r) => ({
    icore_id: Number(r[0]), title: r[1], acronym: r[2],
    source: r[3], value: r[4], dblp: r[5] === 'Yes', for1: r[6],
  }));
}

/** All ranked venues matching an acronym. More than one means the acronym is
    ambiguous (FSE is both Fast Software Encryption and ACM FoSE) - the caller
    must disambiguate rather than silently taking the first. */
export function lookup(ranks, acronym) {
  const a = acronym.trim().toLowerCase();
  return ranks.filter((r) => r.acronym.toLowerCase() === a);
}

/** Build the `rank` block for a conference YAML. */
export function rankBlock(match, { checked_on, ambiguous = false } = {}) {
  return {
    source: EDITION,
    value: match.value,
    icore_id: match.icore_id,
    checked_on: checked_on || new Date().toISOString().slice(0, 10),
    ...(ambiguous ? { ambiguous: true } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ranks = await loadRanks({ maxAgeDays: process.argv.includes('--force') ? 0 : 30 });
  console.log(`${EDITION}: ${ranks.length} ranked venues (cache: ${CACHE})`);
  const queries = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const q of queries) {
    const m = lookup(ranks, q);
    if (!m.length) console.log(`  ${q.padEnd(10)} not ranked`);
    else m.forEach((r) => console.log(`  ${q.padEnd(10)} ${r.value.padEnd(3)} id=${String(r.icore_id).padEnd(5)} ${r.title}`));
  }
}
