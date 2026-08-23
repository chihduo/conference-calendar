#!/usr/bin/env node
/* Tiered refresh: fetch every configured source, merge into the YAML, and route
   anything suspicious to the review queue instead of writing it.
   Writes land as ordinary file edits, so `git diff` shows exactly what changed
   and `git revert` is the undo. --dry-run reports without touching disk. */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONF_DIR, loadYaml, saveConference, writeReviewQueue, readReviewQueue, severityOf,
  CONFIDENCE_RANK, TIER_CONFIDENCE_CEILING, editionIssues, daysBetween, shift364, kindOrder,
} from './lib.mjs';
import * as ccfddl from './adapters/ccfddl.mjs';
import * as researchr from './adapters/researchr.mjs';
import * as wikicfp from './adapters/wikicfp.mjs';

const DRY = process.argv.includes('--dry-run');
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const MAX_MOVE_DAYS = 180;
const NOW = new Date();
const THIS_YEAR = NOW.getUTCFullYear();

/* Apply the tier's ceiling: a community source can never claim "confirmed". */
const capped = (conf, tier) => {
  const ceil = TIER_CONFIDENCE_CEILING[tier] ?? 'announced';
  return CONFIDENCE_RANK[conf] > CONFIDENCE_RANK[ceil] ? ceil : conf;
};

const review = [];
const flag = (conf, edId, kind, reason, detail) =>
  review.push({ conference: conf, edition: edId, kind, reason,
                severity: severityOf(reason), detail, seen_at: NOW.toISOString() });

/* ---------- fetch ---------- */

async function candidatesFor(doc) {
  const groups = new Map();          // year -> {edition fields, milestones[]}
  const add = (year, patch, ms, tier) => {
    if (!year) return;
    const g = groups.get(year) || { year, milestones: [] };
    Object.assign(g, Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null)));
    for (const m of ms) g.milestones.push({ ...m, tier, confidence: capped(m.confidence, tier) });
    groups.set(year, g);
  };

  const sources = (doc.sources || []).filter((s) => !s.disabled)
    .sort((a, b) => trust(a.tier) - trust(b.tier));       // most trusted applied last

  for (const s of sources) {
    try {
      if (s.adapter === 'ccfddl') {
        const ref = s.ref || (await ccfddl.resolve(doc.name));
        if (!ref) continue;
        for (const e of await ccfddl.fetchEditions(ref))
          add(e.year, { link: e.link, place: e.place, dates: e.dates, timezone: e.timezone }, e.milestones, s.tier);

      } else if (s.adapter === 'researchr') {
        const year = Number(/(\d{4})/.exec(s.ref || '')?.[1]) || null;
        const r = await researchr.fetchDates(s.ref, { name: doc.name, year, track: s.track });
        if (!r) continue;
        if (r.ambiguous) flag(doc.id, `${doc.id}-${year}`, null, 'ambiguous-track',
          `researchr ${s.ref}: could not identify the main track among ${r.tracks.join(' / ')}; used "${r.track}"`);
        add(year, { link: `https://conf.researchr.org/home/${s.ref}` }, r.milestones, s.tier);

      } else if (s.adapter === 'wikicfp') {
        const eds = await wikicfp.fetchSeries(s.ref || doc.name, { limit: 4, expectTitle: doc.full_name });
        for (const e of eds)
          add(e.year, { place: e.place, start_date: e.start_date, end_date: e.end_date }, e.milestones, s.tier);
        for (const r of (eds.rejected || []))
          flag(doc.id, null, null, 'wrong-venue',
            `WikiCFP "${doc.name} ${r.year}" is "${r.title}" (similarity ${r.similarity}) - discarded, not the same conference`);

      } else {
        // A source nobody implements must not look like a source that found nothing.
        flag(doc.id, null, null, 'no-adapter', `"${s.adapter}" has no implementation; this source contributed nothing`);
      }
    } catch (e) {
      flag(doc.id, null, null, 'fetch-failed', `${s.adapter}${s.ref ? ' ' + s.ref : ''}: ${e.message}`);
    }
  }
  return groups;
}
const trust = (tier) => ({ 3: 1, 1: 2, 2: 3, 4: 4 }[tier] ?? 0);

/* ---------- merge ---------- */

function decide(existing, cand) {
  if (existing?.locked) return { action: 'skip', why: 'locked' };
  if (!existing) return { action: 'write', why: 'new' };
  if (!existing.date) return { action: 'write', why: 'was unpublished' };
  if (existing.date === cand.date) {
    return CONFIDENCE_RANK[cand.confidence] > CONFIDENCE_RANK[existing.confidence]
      ? { action: 'write', why: `confidence ${existing.confidence} -> ${cand.confidence}` }
      : { action: 'skip', why: 'unchanged' };
  }
  const delta = Math.round(daysBetween(existing.date, cand.date));
  /* A confirmed value with no source_url was typed in by a human from the
     official CFP. Machines may extend a date they own; they may not overrule a
     person's reading of the call. */
  if (existing.confidence === 'confirmed' && !existing.source_url)
    return { action: 'review', why: `hand-entered ${existing.date} vs ${cand.date} from ${cand.adapter} (${delta}d) - confirm which is right` };
  if (CONFIDENCE_RANK[cand.confidence] < CONFIDENCE_RANK[existing.confidence])
    return { action: 'review', why: `lower-trust source disagrees: ${existing.date} (${existing.confidence}) vs ${cand.date} (${cand.confidence})` };
  if (delta > MAX_MOVE_DAYS)
    return { action: 'review', why: `date moves ${delta} days: ${existing.date} -> ${cand.date}` };
  return { action: 'write', why: `${existing.date} -> ${cand.date} (${delta}d)` };
}

/** Keep estimates in step with their base edition: re-derive ones whose base
    moved, and fill in `unknown` milestones once the base finally has that date.
    Without the second half, discovering FMCAD 2026's notification would never
    give FMCAD 2027 an estimated one, and a submitted paper would show no
    upcoming date at all. */
function reestimate(doc, changes) {
  for (const ed of doc.editions) {
    if (ed.status === 'past') continue;

    // which edition are this edition's estimates anchored to?
    const anchor = ed.milestones.find((m) => m.derived_from)?.derived_from?.split('/')[0];
    const src = anchor ? doc.editions.find((e) => e.id === anchor) : null;

    for (const m of ed.milestones) {
      if (m.locked) continue;

      if (m.confidence === 'estimated' && m.derived_from) {
        const [srcId, srcKind] = m.derived_from.split('/');
        const from = doc.editions.find((e) => e.id === srcId);
        const base = from?.milestones.find((x) => x.kind === srcKind);
        if (!base?.date) continue;
        const want = shift364(base.date, ed.year - from.year);
        if (want && want !== m.date) {
          changes.push(`${ed.id}/${m.kind}: re-estimated ${m.date} -> ${want} (base ${srcId}/${srcKind} moved)`);
          m.date = want;
        }
      } else if (m.confidence === 'unknown' && src) {
        const base = src.milestones.find((x) => x.kind === m.kind && x.date);
        if (!base) continue;
        const want = shift364(base.date, ed.year - src.year);
        if (!want) continue;
        m.date = want;
        m.confidence = 'estimated';
        m.derived_from = `${src.id}/${m.kind}`;
        changes.push(`${ed.id}/${m.kind}: newly estimated ${want} from ${src.id}`);
      }
    }
  }
}

async function refreshOne(file) {
  const full = path.join(CONF_DIR, file);
  const doc = loadYaml(fs.readFileSync(full, 'utf8'));
  const before = JSON.stringify(doc);
  const groups = await candidatesFor(doc);
  const changes = [];

  for (const [year, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (year < THIS_YEAR - 1) continue;                 // don't import a decade of history
    let ed = doc.editions.find((e) => e.year === year);
    if (!ed) {
      if (!g.milestones.length) continue;
      ed = { year, id: `${doc.id}-${year}`, timezone: g.timezone || 'AoE', status: 'announced', milestones: [] };
      doc.editions.push(ed);
      changes.push(`${ed.id}: new edition discovered`);
    }
    const snapshot = JSON.parse(JSON.stringify(ed));

    for (const f of ['link', 'place', 'dates', 'start_date', 'end_date']) {
      if (g[f] && !ed[f]) { ed[f] = g[f]; changes.push(`${ed.id}: ${f} = ${g[f]}`); }
    }

    /* GUARD: two rows of one source mapping to the same kind means the label
       rules under-discriminate (ATVA lists both a paper and an early-rejection
       notification). Picking one silently would be a coin flip, so pick none. */
    const byKindSource = new Map();
    for (const m of g.milestones) {
      const k = `${m.kind}|${m.adapter}`;
      (byKindSource.get(k) || byKindSource.set(k, []).get(k)).push(m);
    }
    const collided = new Set();
    for (const [k, list] of byKindSource) {
      const dates = [...new Set(list.map((x) => x.date))];
      if (dates.length > 1) {
        const [kind, adapter] = k.split('|');
        collided.add(kind);
        flag(doc.id, ed.id, kind, 'multiple-candidates',
          `${adapter} offers ${dates.length} dates for "${kind}" (${list.map((x) => `${x.date} "${x.note || ''}"`).join('; ')}) - not written`);
      }
    }

    // strongest candidate per kind
    const best = new Map();
    for (const m of g.milestones) {
      if (collided.has(m.kind)) continue;
      const cur = best.get(m.kind);
      if (!cur || CONFIDENCE_RANK[m.confidence] > CONFIDENCE_RANK[cur.confidence] ||
          (CONFIDENCE_RANK[m.confidence] === CONFIDENCE_RANK[cur.confidence] && trust(m.tier) > trust(cur.tier)))
        best.set(m.kind, m);
    }

    for (const [kind, cand] of best) {
      const existing = ed.milestones.find((m) => m.kind === kind);
      const { action, why } = decide(existing, cand);
      if (action === 'skip') continue;
      if (action === 'review') { flag(doc.id, ed.id, kind, 'conflict', why); continue; }
      /* Flag only a date that MOVED under a non-authoritative source. A first
         fill is already communicated by its confidence level; flagging those too
         would make needs_review meaningless. */
      const moved = existing?.date && existing.date !== cand.date;
      const next = {
        kind, date: cand.date, ...(cand.time ? { time: cand.time } : {}),
        confidence: cand.confidence,
        ...(moved && cand.confidence !== 'confirmed' ? { needs_review: true } : {}),
        source_url: cand.source_url,
      };
      if (existing) Object.assign(existing, next, { derived_from: undefined });
      else ed.milestones.push(next);
      changes.push(`${ed.id}/${kind}: ${why}`);
    }
    ed.milestones.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    for (const m of ed.milestones) if (m.derived_from === undefined) delete m.derived_from;

    // GUARD: vet the merged edition; roll back wholesale if it no longer holds together
    const issues = editionIssues(doc, ed);
    if (issues.length) {
      const i = doc.editions.indexOf(ed);
      doc.editions[i] = snapshot;
      issues.forEach((x) => flag(doc.id, ed.id, null, 'guard', x));
      changes.push(`${ed.id}: ROLLED BACK - ${issues.length} guard issue(s)`);
    } else if (ed.status !== 'past' && ed.milestones.some((m) => m.confidence === 'confirmed')) {
      if (ed.status === 'estimated') { ed.status = 'confirmed'; changes.push(`${ed.id}: status estimated -> confirmed`); }
    }
  }

  reestimate(doc, changes);
  const empty = doc.editions.filter((e) => !e.milestones?.length && !e.start_date);
  if (empty.length) {
    doc.editions = doc.editions.filter((e) => !empty.includes(e));
    empty.forEach((e) => changes.push(`${e.id}: dropped (no milestones)`));
  }
  doc.editions.sort((a, b) => b.year - a.year);

  const dirty = JSON.stringify(doc) !== before;
  if (dirty && !DRY) saveConference({ ...doc, _file: file });
  return { file, changes, dirty };
}

/* ---------- run ---------- */

const files = fs.readdirSync(CONF_DIR).filter((f) => /\.ya?ml$/.test(f))
  .filter((f) => !ONLY.length || ONLY.some((o) => f.startsWith(o.toLowerCase())));

console.log(`${DRY ? '[dry-run] ' : ''}Refreshing ${files.length} conference file(s)...\n`);
let touched = 0;
for (const f of files) {
  const r = await refreshOne(f);
  if (r.changes.length) {
    touched++;
    console.log(`${r.file}${r.dirty ? '' : ' (no net change)'}`);
    r.changes.forEach((c) => console.log('   · ' + c));
  }
}
/* Refresh owns its own findings and rebuilds them wholesale, but must not
   discard the notes add.mjs left behind for venues it did not touch. */
if (!DRY) {
  const touchedIds = new Set(files.map((f) => f.replace(/\.ya?ml$/, '')));
  const kept = readReviewQueue().filter((r) => r.reason === 'newly-added' && !touchedIds.has(r.conference));
  writeReviewQueue([...kept, ...review]);
}
console.log(`\n${touched} file(s) with changes, ${review.filter((r) => r.severity === 'action').length} item(s) needing a decision.`);
const actionable = review.filter((r) => r.severity === 'action');
if (actionable.length) {
  console.log('\nNeeds a decision:');
  for (const r of actionable) console.log(`   ! [${r.reason}] ${r.conference}${r.edition ? '/' + r.edition : ''}: ${r.detail}`);
}
if (DRY) console.log('\n(dry run - nothing was written)');
