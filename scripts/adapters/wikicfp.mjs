/* Tier 3 - WikiCFP.
   The broad fallback: it covers the long tail nothing else reaches (TACAS,
   CIAA, SEFM, ITP, LPAR...) and its event pages carry four milestone kinds in a
   clean label/value table. It is community-submitted, so the ceiling is
   "announced" - a WikiCFP date must never be written as confirmed.
   HTTP only; the site has no TLS listener. */
import { parse } from 'node-html-parser';
import { fetchText } from '../lib.mjs';

const BASE = 'http://www.wikicfp.com';
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const pad = (n) => String(n).padStart(2, '0');

/** "Apr 20, 2026" -> "2026-04-20"; "TBD" and friends -> null. */
export function parseDate(s) {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/.exec(String(s || ''));
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  return mo ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : null;
}
export function parseRange(s) {
  const all = [...String(s || '').matchAll(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/g)]
    .map((m) => { const mo = MONTHS[m[1].toLowerCase()]; return mo ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : null; })
    .filter(Boolean);
  return all.length ? { start: all[0], end: all[all.length - 1] } : null;
}

/** All editions of a series, newest first: [{year, eventid}] */
export async function search(acronym) {
  const html = await fetchText(`${BASE}/cfp/servlet/tool.search?q=${encodeURIComponent(acronym)}&year=a`);
  const out = [];
  const re = new RegExp(`eventid=(\\d+)[^"]*">\\s*${acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d{4})`, 'gi');
  for (const m of html.matchAll(re)) out.push({ eventid: Number(m[1]), year: Number(m[2]) });
  const seen = new Set();
  return out.filter((x) => !seen.has(x.year) && seen.add(x.year)).sort((a, b) => b.year - a.year);
}

/* WikiCFP is keyed by acronym, and acronyms collide across fields: its "SAS
   2026" is the Society for Animation Studies, not the Static Analysis Symposium.
   The <title> carries the full name, so identity can be checked before trusting
   anything on the page. */
const STOP = new Set(['the','of','on','in','and','for','a','an','to','international','conference',
  'symposium','annual','workshop','proceedings','joint','acm','ieee','st','nd','rd','th']);
const tokens = (s) => [...new Set(String(s || '').toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ').split(/[\s]+/)
  .map((w) => w.replace(/^\d+(st|nd|rd|th)$/, ''))
  .filter((w) => w.length > 2 && !STOP.has(w)))];

/** 0..1 overlap of significant words; null when either side is unknown. */
export function titleSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return null;
  const shared = A.filter((w) => B.includes(w)).length;
  return shared / Math.min(A.length, B.length);
}
export const SIMILARITY_FLOOR = 0.4;

const FIELD = {
  'abstract registration due': 'abstract',
  'submission deadline':       'submission',
  'notification due':          'notification',
  'final version due':         'camera_ready',
};

/** -> { year, place, start_date, end_date, milestones[], source_url } */
export async function fetchEvent(eventid, year) {
  const url = `${BASE}/cfp/servlet/event.showcfp?eventid=${eventid}`;
  const root = parse(await fetchText(url));
  const rawTitle = (root.querySelector('title')?.text || '').trim();
  const title = rawTitle.replace(/^\s*\S+\s+\d{4}\s*:\s*/, '').trim() || null;
  const cells = root.querySelectorAll('th,td').map((n) => n.text.replace(/\s+/g, ' ').trim());
  const ed = { year, title, place: null, start_date: null, end_date: null, milestones: [], source_url: url };
  for (let i = 0; i < cells.length - 1; i++) {
    const key = cells[i].toLowerCase();
    const val = cells[i + 1];
    if (key === 'when') { const r = parseRange(val); if (r) { ed.start_date = r.start; ed.end_date = r.end; } }
    else if (key === 'where') { if (val && !/^tbd$/i.test(val)) ed.place = val; }
    else if (FIELD[key]) {
      const d = parseDate(val);
      if (d) ed.milestones.push({ kind: FIELD[key], date: d, confidence: 'announced', source_url: url, adapter: 'wikicfp' });
    }
  }
  if (!ed.year && ed.start_date) ed.year = Number(ed.start_date.slice(0, 4));
  return ed;
}

/** The most recent N editions of a series.
    `expectTitle` (normally the ICORE title) rejects same-acronym impostors;
    rejects are returned separately so the caller can report rather than guess. */
export async function fetchSeries(acronym, { limit = 3, expectTitle = null } = {}) {
  const hits = (await search(acronym)).slice(0, limit);
  const out = [], rejected = [];
  for (const h of hits) {
    let e;
    try { e = await fetchEvent(h.eventid, h.year); } catch { continue; }
    const sim = expectTitle ? titleSimilarity(expectTitle, e.title) : null;
    if (sim !== null && sim < SIMILARITY_FLOOR) {
      rejected.push({ year: e.year, title: e.title, similarity: Number(sim.toFixed(2)) });
      continue;
    }
    out.push(e);
  }
  out.rejected = rejected;
  return out;
}
