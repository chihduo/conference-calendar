/* Tier 2 - conf.researchr.org /dates/<id>.
   One uniform `When | Track | What` table, and the only source that carries the
   post-submission milestones. Covers the ACM SIGPLAN/SIGSOFT family only -
   CONCUR, TACAS, ESOP, RV, SEFM, ITP all 404 here. */
import { parse } from 'node-html-parser';
import { fetchText } from '../lib.mjs';

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const pad = (n) => String(n).padStart(2, '0');

/* "Wed 16 Sep 2026" and "Mon 14 - Fri 18 Dec 2026" (the range shares one month/year). */
export function parseWhen(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  const range = /^[A-Za-z]{3}\s+(\d{1,2})\s*-\s*[A-Za-z]{3}\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (range) {
    const [, d1, d2, mon, yr] = range;
    const m = MONTHS[mon.toLowerCase()];
    if (!m) return null;
    return { from: `${yr}-${pad(m)}-${pad(d1)}`, to: `${yr}-${pad(m)}-${pad(d2)}` };
  }
  const one = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(s);
  if (!one) return null;
  const m = MONTHS[one[2].toLowerCase()];
  return m ? { from: `${one[3]}-${pad(m)}-${pad(one[1])}` } : null;
}

/* Ordered, most specific first: "Artifact Submission" must not fall through to
   the generic /submission/ rule. */
const RULES = [
  // qualifier-bearing labels first: these are separate milestones, not synonyms
  [/tool paper.*artifact|artifact.*tool paper/i, 'tool_artifact_submission'],
  [/early.?reject/i,                       'early_rejection_notification'],
  [/artifact.*regist/i,                    'artifact_registration'],
  [/artifact/i,                            'artifact_submission'],
  [/abstract/i,                            'abstract'],
  [/author response|rebuttal|response period/i, 'rebuttal'],
  /* These must precede the generic revision rule: ICSE labels a row
     "Camera-ready (of accepted major revision papers)", which is a camera-ready
     that merely mentions revision, not a revision deadline. */
  /* Two camera-readies on two branches: one for papers accepted outright, one
     for papers that went through a major revision. Distinct deadlines, so
     distinct kinds - collapsing them would silently drop one. */
  [/camera.?ready.*revision|revision.*camera.?ready/i, 'camera_ready_after_revision'],
  [/camera.?ready|final version|final paper/i, 'camera_ready'],
  [/final (accept|notif|decision)/i,       'final_notification'],
  [/major revision|revision/i,             'revision'],
  [/early.*regist/i,                       'early_registration'],
  [/regist/i,                              'registration'],
  [/notification|acceptance|decision/i,    'notification'],
  [/paper submission|submission deadline|full paper|paper deadline|submission/i, 'submission'],
];
export const labelToKind = (label) => RULES.find(([re]) => re.test(label))?.[1] ?? null;

/* Multi-round venues label the round in the same cell: "Submission (Round 2)".
   Split it off so the kind matches normally and carries a _cycleN suffix. */
const ROUND_RE = /[\s(\[]*\b(?:round|cycle|deadline)\s*#?\s*(\d+)(?:\s*\/\s*\d+)?[)\]]*/i;
export function splitRound(label) {
  const m = ROUND_RE.exec(label);
  if (!m) return { label, cycle: 0 };
  return { label: label.replace(ROUND_RE, ' ').replace(/\s{2,}/g, ' ').trim(), cycle: Number(m[1]) };
}

/* Track disambiguation is the whole ballgame here: ICSE 2027 lists 40 tracks,
   POPL's page carries its co-located conferences and workshops, and picking the
   wrong row silently imports a workshop deadline as the paper deadline.
   Scored rather than first-match, and a tie or a non-positive best means we
   refuse to guess and say so. */
const NEGATIVE = /artifact|workshop|poster|\bsrc\b|student|doctoral|tutorial|demo|industry|journal.?first|nier|co-located|shadow|mentoring|competition|challenge|volunteer|showcase|replication|education|society|in practice|registered report|early research|mining|benchmark|symposium|briefing/i;
const EXACT_MAIN = /^(research (track|papers?)|technical papers?|main (track|conference)|full papers?|papers?)$/i;

export function scoreTrack(t, name, year) {
  const T = t.trim(); const lo = T.toLowerCase(); const N = (name || '').toLowerCase();
  if (N && year && lo === `${N} ${year}`) return 100;
  if (N && lo === N) return 95;
  if (N && new RegExp(`^${N}\\b`, 'i').test(lo) && /(research|technical)\s+(track|papers?)$|papers?$/i.test(lo)) return 90;
  if (EXACT_MAIN.test(T)) return 80;
  if (NEGATIVE.test(T)) return -50;
  if (N && lo.includes(N) && /paper|research|main|technical/i.test(lo)) return 60;
  return 0;
}

/** @returns {{track:string|null, ambiguous:boolean}} */
export function pickTrack(tracks, { name, year, track } = {}) {
  if (track) return { track, ambiguous: false };
  if (tracks.length === 1) return { track: tracks[0], ambiguous: false };
  const scored = tracks.map((t) => ({ t, s: scoreTrack(t, name, year) })).sort((a, b) => b.s - a.s);
  const best = scored[0];
  const tie = scored[1] && scored[1].s === best.s;
  if (!best || best.s <= 0 || tie) return { track: best?.t ?? null, ambiguous: true };
  return { track: best.t, ambiguous: false };
}

/** @returns {{milestones:[], track:string, tracks:string[], ambiguous:boolean}|null} */
export async function fetchDates(id, { name, year, track } = {}) {
  let html;
  try { html = await fetchText(`https://conf.researchr.org/dates/${id}`); }
  catch { return null; }
  const root = parse(html);
  const table = root.querySelectorAll('table').find((t) => {
    const head = t.querySelectorAll('tr')[0];
    return head && /when/i.test(head.text) && /what/i.test(head.text);
  });
  if (!table) return null;

  const rows = table.querySelectorAll('tr').slice(1).map((tr) => {
    const c = tr.querySelectorAll('td,th').map((td) => td.text.replace(/\s+/g, ' ').trim());
    if (c.length < 3) return null;
    // researchr appends an "updated"/"new" badge straight onto the label text
    return { when: c[0], track: c[1], what: c[2].replace(/\s*(new|updated)$/i, '').trim() };
  }).filter(Boolean);
  if (!rows.length) return null;

  const tracks = [...new Set(rows.map((r) => r.track))];
  const { track: chosen, ambiguous } = pickTrack(tracks, { name, year, track });
  if (!chosen) return null;

  const src = `https://conf.researchr.org/dates/${id}`;
  const out = [];
  for (const r of rows.filter((r) => r.track === chosen)) {
    const { label, cycle } = splitRound(r.what);
    const kind = labelToKind(label);
    const when = parseWhen(r.when);
    if (!kind || !when) continue;
    const suffix = cycle ? `_cycle${cycle}` : '';
    const base = { confidence: 'confirmed', source_url: src, adapter: 'researchr', note: r.what, cycle };
    if (kind === 'rebuttal') {
      out.push({ ...base, kind: `rebuttal_start${suffix}`, date: when.from });
      if (when.to) out.push({ ...base, kind: `rebuttal_end${suffix}`, date: when.to });
    } else {
      out.push({ ...base, kind: `${kind}${suffix}`, date: when.to || when.from });
    }
  }

  /* A round that notifies twice is notifying once about the paper and once
     about the revision; the later one is the final decision, not a duplicate. */
  const byCycle = new Map();
  for (const m of out) {
    const c = m.cycle || 0;
    if (!/^notification(_cycle\d+)?$/.test(m.kind)) continue;
    (byCycle.get(c) || byCycle.set(c, []).get(c)).push(m);
  }
  for (const [c, list] of byCycle) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (const m of list.slice(1)) m.kind = `final_notification${c ? `_cycle${c}` : ''}`;
  }
  for (const m of out) delete m.cycle;

  return { milestones: out, track: chosen, tracks, ambiguous };
}
