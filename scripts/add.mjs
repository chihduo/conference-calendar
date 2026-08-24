#!/usr/bin/env node
/* Add a conference from nothing but its acronym.
   Runs a four-way discovery cascade, writes a complete YAML with 2027 estimated
   from the most recent real edition, and reports honestly which layers hit and
   which did not. Nothing here is trusted: a newly added venue is written with
   needs_review set so it gets one human pass before it is treated as settled. */
import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR, saveConference, byDateThenKind, editionIssues, writeReviewQueue, readReviewQueue,
         severityOf, estimateEdition, planningYear } from './lib.mjs';
import * as icore from './adapters/icore.mjs';
import * as ccfddl from './adapters/ccfddl.mjs';
import * as researchr from './adapters/researchr.mjs';
import * as wikicfp from './adapters/wikicfp.mjs';

const TARGET_YEAR = Number(process.env.TARGET_YEAR) || planningYear();
const DRY = process.argv.includes('--dry-run');

/* Guessing a researchr id is cheap (a HEAD-ish GET) and the 404 is unambiguous,
   so try the shapes the site actually uses rather than requiring configuration. */
async function findResearchr(acro, year) {
  const lo = acro.toLowerCase(), up = acro.toUpperCase();
  for (const cand of [`${lo}-${year}`, `${up}-${year}`, `${lo}${year}`,
                      `${lo}-${year - 1}`, `${up}-${year - 1}`]) {
    const r = await researchr.fetchDates(cand, { name: acro, year: Number(/(\d{4})/.exec(cand)[1]) });
    if (r?.milestones.length) return { id: cand, ...r };
  }
  return null;
}

/* Try to excise the wrong field instead of discarding the edition.
   Two rules, both about which side of a contradiction is the outlier:
   several deadlines "after the conference start" means the START date is wrong,
   not every deadline; otherwise drop the milestone furthest from the event,
   since an implausible lead time is the usual signature of a bad year. */
function repairEdition(doc, e, maxSteps = 4) {
  let issues = editionIssues(doc, e);
  const removed = [];
  for (let step = 0; step < maxSteps && issues.length; step++) {
    const afterStart = issues.filter((i) => /is after the conference start/.test(i));
    if (afterStart.length >= 2 && e.start_date) {
      removed.push({ what: `start_date ${e.start_date}` });
      delete e.start_date; delete e.end_date; delete e.dates;
      issues = editionIssues(doc, e);
      continue;
    }
    const dated = (e.milestones || []).filter((m) => m.date);
    const scored = dated
      /* Without a conference date to measure against, fall back to how far the
         milestone's YEAR sits from the edition's - a wrong year is the usual
         cause and the biggest outlier. */
      .map((m) => ({ m, hits: issues.filter((i) => i.includes(m.kind)).length,
                     lead: e.start_date
                       ? Math.abs(new Date(e.start_date) - new Date(m.date))
                       : Math.abs(Number(m.date.slice(0, 4)) - e.year) * 365 * 86400000 }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.lead - a.lead);
    if (!scored.length) break;
    const victim = scored[0].m;
    e.milestones = e.milestones.filter((m) => m !== victim);
    removed.push({ what: `${victim.kind} ${victim.date}` });
    issues = editionIssues(doc, e);
  }
  return { ok: !issues.length, removed, issues };
}

const AREA_HINT = [
  [/verification|model check|formal|automata|proof|theorem|satisfiab|abstract interp|runtime|automated (deduction|reasoning)/i, 'FM'],
  [/programming language|compiler|functional programming|program analysis|types?\b/i, 'PL'],
  [/artificial intelligence|knowledge representation|machine learning|planning|reasoning|constraint/i, 'AI'],
  [/software engineering|testing|maintenance|requirements/i, 'SE'],
  [/logic|computation theory|semantics|deduction|automated reasoning|automata|concurrency/i, 'LOGIC'],
];
/* A regex over conference titles is a guess, not knowledge. When nothing
   matches, say so instead of silently defaulting - a wrong area tag quietly
   corrupts the filters and the per-area ICS feeds. */
const guessAreas = (title) => {
  const hits = AREA_HINT.filter(([re]) => re.test(title || '')).map(([, a]) => a);
  return hits.length ? { areas: [...new Set(hits)], guessed: false }
                     : { areas: ['FM'], guessed: true };
};

async function discover(acronym) {
  const report = { acronym, layers: {}, notes: [], next: [] };
  /* "Reported rather than guessed" is only useful if the report says what to do
     about it. Every condition that needs a human names the file and the field. */
  const act = (how) => { if (!report.next.includes(how)) report.next.push(how); };
  const doc = { id: acronym.toLowerCase(), name: acronym.toUpperCase(), areas: ['FM'], sources: [], editions: [] };

  /* Tier 0 - rank */
  try {
    const ranks = await icore.loadRanks();
    const hits = icore.lookup(ranks, acronym);
    if (!hits.length) { report.layers.icore = 'not ranked'; doc.rank = { source: icore.EDITION, value: 'unranked' }; }
    else {
      const pick = hits.length > 1 ? hits.sort((a, b) => (b.value === 'A*') - (a.value === 'A*'))[0] : hits[0];
      doc.rank = icore.rankBlock(pick, { ambiguous: hits.length > 1 });
      doc.full_name = pick.title;
      doc.name = pick.acronym || doc.name;      // keep the community's casing, e.g. NeurIPS
      const g = guessAreas(pick.title);
      doc.areas = g.areas;
      if (g.guessed) {
        report.notes.push(`Could not infer the research area from "${pick.title}"; defaulted to FM.`);
        act(`設定領域：編 data/conferences/${doc.id}.yml 的 areas:，從 FM / PL / AI / SE / LOGIC / SEC 選（可多選）`);
      }
      report.layers.icore = `${pick.value} (id ${pick.icore_id})${hits.length > 1 ? ` - AMBIGUOUS, ${hits.length} matches` : ''}`;
      if (hits.length > 1) {
        report.notes.push(`ICORE has ${hits.length} venues called ${acronym}: ${hits.map((h) => `${h.value} id=${h.icore_id} ${h.title}`).join(' | ')}`);
        act(`挑對排名：編 data/conferences/${doc.id}.yml 的 rank.icore_id 與 rank.value，並移除 rank.ambiguous`);
      }
    }
  } catch (e) { report.layers.icore = 'failed: ' + e.message; }

  const editions = new Map();
  const put = (year, patch, ms) => {
    if (!year || year < TARGET_YEAR - 2) return;
    const e = editions.get(year) || { year, id: `${doc.id}-${year}`, timezone: 'AoE', milestones: [] };
    Object.assign(e, Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null)));
    for (const m of ms) if (!e.milestones.some((x) => x.kind === m.kind)) e.milestones.push(m);
    editions.set(year, e);
  };

  /* Tier 1 - ccf-deadlines */
  try {
    const ref = await ccfddl.resolve(acronym);
    if (!ref) report.layers.ccfddl = 'no file';
    else {
      doc.sources.push({ tier: 1, adapter: 'ccfddl', ref });
      const eds = await ccfddl.fetchEditions(ref);
      for (const e of eds) put(e.year, { link: e.link, place: e.place, dates: e.dates, timezone: e.timezone }, e.milestones);
      report.layers.ccfddl = `${ref} (${eds.length} editions)`;
    }
  } catch (e) { report.layers.ccfddl = 'failed: ' + e.message; }

  /* Tier 2 - researchr */
  try {
    const r = await findResearchr(acronym, TARGET_YEAR);
    if (!r) report.layers.researchr = 'no page (venue is probably not on researchr)';
    else {
      doc.sources.push({ tier: 2, adapter: 'researchr', ref: r.id, ...(r.ambiguous ? {} : { track: r.track }) });
      put(Number(/(\d{4})/.exec(r.id)[1]), { link: `https://conf.researchr.org/home/${r.id}` }, r.milestones);
      report.layers.researchr = `${r.id}, track "${r.track}"${r.ambiguous ? ' (AMBIGUOUS)' : ''}`;
      if (r.ambiguous) {
        report.notes.push(`researchr track could not be identified among: ${r.tracks.join(' / ')}`);
        act(`指定 track：在 data/conferences/${doc.id}.yml 的 researchr 那筆 sources 加 track: "<主 track 名>"，然後 npm run refresh ${doc.id}`);
      }
    }
  } catch (e) { report.layers.researchr = 'failed: ' + e.message; }

  /* Tier 3 - WikiCFP (the broad fallback) */
  try {
    const eds = await wikicfp.fetchSeries(acronym, { limit: 3, expectTitle: doc.full_name });
    doc.sources.push({ tier: 3, adapter: 'wikicfp' });
    for (const e of eds) put(e.year, { place: e.place, start_date: e.start_date, end_date: e.end_date }, e.milestones);
    const rej = eds.rejected || [];
    report.layers.wikicfp = (eds.length ? `${eds.length} editions (${eds.map((e) => e.year).join(', ')})` : 'no matching events')
      + (rej.length ? `; ${rej.length} rejected as a different venue` : '');
    for (const r of rej)
      report.notes.push(`WikiCFP "${acronym} ${r.year}" is a different conference ("${r.title}", similarity ${r.similarity}) - discarded.`);
    if (rej.length && !eds.length)
      act(`WikiCFP 上的 ${acronym} 是別的會議。若這個會議在 WikiCFP 用另一個縮寫，把 sources 那筆改成 {tier: 3, adapter: wikicfp, ref: <正確縮寫>}；若根本不在上面，改寫 tier-4 官網 adapter`);
  } catch (e) { report.layers.wikicfp = 'failed: ' + e.message; }

  /* assemble */
  for (const e of editions.values()) {
    e.milestones.sort(byDateThenKind);
    e.status = e.year < TARGET_YEAR ? 'past'
      : e.milestones.some((m) => m.confidence === 'confirmed') ? 'confirmed' : 'announced';
    for (const m of e.milestones) { delete m.adapter; delete m.tier; delete m.note; }
  }
  doc.editions = [...editions.values()].sort((a, b) => b.year - a.year);

  /* Upstream feeds carry real errors - ccf-deadlines has IJCAR 2026 with
     `deadline: 2025-02-15` for a July 2026 conference, a one-character year
     typo. Excise the offending field rather than discarding a whole venue over
     it, and say exactly what was removed. */
  report.dropped = [];
  report.repaired = [];
  doc.editions = doc.editions.filter((e) => {
    const r = repairEdition(doc, e);
    if (r.removed.length) report.repaired.push({ id: e.id, removed: r.removed });
    if (r.ok) return true;
    report.dropped.push({ id: e.id, issues: r.issues });
    return false;
  });
  for (const r of report.repaired) {
    report.notes.push(`Repaired ${r.id}: dropped ${r.removed.map((x) => x.what).join(', ')} (upstream data looks wrong)`);
    act(`核對被丟掉的值：拿官方 CFP 對照 ${r.id}，正確的話手填並加 locked: true，自動抓取就不會再覆蓋`);
  }
  for (const d of report.dropped) {
    report.notes.push(`Dropped ${d.id}: ${d.issues.join('; ')}`);
    act(`${d.id} 整屆被丟掉（上游資料自相矛盾）。需要它的話照 schema/conference.schema.json 手寫一屆`);
  }

  /* Estimate the target year when nobody has published it yet. */
  if (!doc.editions.some((e) => e.year === TARGET_YEAR)) {
    const base = doc.editions.find((e) => e.milestones.some((m) => m.date));
    const est = base && estimateEdition(doc.id, base, TARGET_YEAR);
    if (est) {
      doc.editions.unshift(est);
      report.notes.push(`${TARGET_YEAR} not published yet - estimated from ${base.id} by +364d x ${TARGET_YEAR - base.year}.`);
    } else {
      report.notes.push(`No dated edition found anywhere; ${TARGET_YEAR} left as placeholders.`);
      act(`沒有任何來源有日期。到官網找 CFP 手填一屆（格式見 schema/conference.schema.json 或任一現有檔案），或寫 scripts/adapters/custom/${doc.id}.mjs`);
      doc.editions.unshift({
        year: TARGET_YEAR, id: `${doc.id}-${TARGET_YEAR}`, timezone: 'AoE', place: 'TBD', dates: 'TBD',
        status: 'announced', needs_review: true,
        milestones: ['abstract', 'submission', 'notification', 'camera_ready', 'registration']
          .map((kind) => ({ kind, confidence: 'unknown' })),
      });
    }
  }
  for (const e of doc.editions) if (e.year >= TARGET_YEAR) e.needs_review = true;

  // final pass: anything still broken (e.g. an estimate built on a dropped base)
  report.issues = doc.editions.flatMap((e) => editionIssues(doc, e).map((i) => `${e.id}: ${i}`));

  // emit keys in the same order as the hand-written files
  const ordered = {
    id: doc.id, name: doc.name, ...(doc.full_name ? { full_name: doc.full_name } : {}),
    areas: doc.areas, ...(doc.dblp ? { dblp: doc.dblp } : {}),
    ...(doc.rank ? { rank: doc.rank } : {}), sources: doc.sources, editions: doc.editions,
  };
  return { doc: ordered, report };
}

/* ---------- run ---------- */

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wishlist = path.join(CONF_DIR, '..', 'wishlist.txt');
const fromWishlist = !names.length;
const queued = names.length ? names
  : fs.existsSync(wishlist)
    ? fs.readFileSync(wishlist, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    : [];

if (!queued.length) { console.log('Nothing to add. Pass acronyms, or list them in data/wishlist.txt.'); process.exit(0); }

/* Lines that resolved are consumed; lines that did not stay, annotated with why,
   so the file always reads as "still outstanding" rather than as a growing log.
   A venue too new for any source can start resolving on a later night. */
const unresolved = new Map();

const review = readReviewQueue();
const dropPrior = (id) => { for (let i = review.length - 1; i >= 0; i--) if (review[i].conference === id) review.splice(i, 1); };
let added = 0, skipped = 0, failed = 0;
for (const acro of queued) {
  const file = path.join(CONF_DIR, `${acro.toLowerCase()}.yml`);
  if (fs.existsSync(file)) { console.log(`${acro}: already present, skipped`); skipped++; continue; }

  const { doc, report } = await discover(acro);
  const dated = doc.editions.reduce((n, e) => n + e.milestones.filter((m) => m.date).length, 0);
  console.log(`\n${acro}  ->  ${doc.full_name || '(no title)'}`);
  for (const [k, v] of Object.entries(report.layers)) console.log(`   ${k.padEnd(10)} ${v}`);
  console.log(`   ${'result'.padEnd(10)} ${doc.editions.length} editions, ${dated} dated milestones`);
  report.notes.forEach((n) => console.log(`   note       ${n}`));
  (report.repaired || []).forEach((r) => console.log(`   repaired   ${r.id}: removed ${r.removed.map((x) => x.what).join(', ')}`));
  (report.dropped || []).forEach((d) => console.log(`   dropped    ${d.id}`));

  if (report.issues.length) {
    // A half-formed file is worse than none: report why and write nothing.
    console.log(`   REJECTED   ${report.issues.length} guard issue(s):`);
    report.issues.forEach((i) => console.log(`      x ${i}`));
    console.log('   ── 下一步 ──');
    console.log(`   1. 上游資料互相矛盾，沒有寫出檔案。到官網確認正確日期後手寫 data/conferences/${doc.id}.yml`);
    report.next.forEach((a, i) => console.log(`   ${i + 2}. ${a}`));
    dropPrior(doc.id);
    review.push({ conference: doc.id, edition: null, kind: null, reason: 'add-rejected',
                  severity: severityOf('add-rejected'), detail: report.issues.join('; '), seen_at: new Date().toISOString() });
    unresolved.set(acro, `guard: ${report.issues[0]}`);
    failed++; continue;
  }
  if (!dated) {
    console.log('   REJECTED   no dates found by any layer - nothing was written');
    if (report.next.length) {
      console.log('   ── 下一步 ──');
      report.next.forEach((a, i) => console.log(`   ${i + 1}. ${a}`));
    }
    unresolved.set(acro, 'no dates found by any source');
    failed++; continue;
  }
  if (report.next.length) {
    console.log('   ── 下一步 ──');
    report.next.forEach((a, i) => console.log(`   ${i + 1}. ${a}`));
  }
  if (!DRY) saveConference({ ...doc, _file: `${doc.id}.yml` });
  dropPrior(doc.id);   // a successful add supersedes anything said about it before
  for (const n of report.notes)
    review.push({ conference: doc.id, edition: null, kind: null, reason: 'newly-added',
                  severity: severityOf('newly-added'), detail: n, seen_at: new Date().toISOString() });
  added++;
}
if (!DRY) writeReviewQueue(review);

if (fromWishlist && !DRY && fs.existsSync(wishlist)) {
  const header = fs.readFileSync(wishlist, 'utf8')
    .split('\n').filter((l) => /^\s*(#|$)/.test(l)).join('\n').replace(/\n+$/, '');
  const body = [...unresolved].map(([a, why]) => `${a}  # ${why}`);
  fs.writeFileSync(wishlist, [header, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  const done = queued.length - unresolved.size;
  if (done) console.log(`\nwishlist: removed ${done} resolved line(s), ${unresolved.size} still outstanding.`);
}

console.log(`\n${added} added, ${skipped} skipped, ${failed} rejected.${DRY ? ' (dry run - nothing written)' : ''}`);
