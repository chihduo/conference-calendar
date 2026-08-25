import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { DateTime } from 'luxon';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CONF_DIR = path.join(ROOT, 'data', 'conferences');
export const RANK_DIR = path.join(ROOT, 'data', 'rankings');
export const REVIEW_QUEUE = path.join(ROOT, 'data', '_review_queue.json');

/* Milestone kinds are an open vocabulary. This table only supplies display order
   and a label; an unlisted kind still renders, sorted after everything known. */
/* `chain: true` marks the main review pipeline, whose stages must run in order.
   Everything else is deliberately off-chain: artifact deadlines fall at
   submission time at some venues and after acceptance at others, and an
   early-rejection notice is a branch that skips rebuttal entirely. Ordering
   those against the chain would encode an invariant that is simply not true. */
export const KIND_META = {
  abstract:              { order: 10, label: 'Abstract', chain: true },
  submission:            { order: 20, label: 'Submission', chain: true },
  tool_artifact_submission: { order: 25, label: 'Tool-paper artifact' },
  artifact_registration: { order: 30, label: 'Artifact reg.' },
  artifact_submission:   { order: 31, label: 'Artifact' },
  voluntary_artifact_submission: { order: 33, label: 'Artifact (voluntary)' },
  rebuttal_start:        { order: 40, label: 'Rebuttal opens', chain: true },
  rebuttal_end:          { order: 41, label: 'Rebuttal ends', chain: true },
  early_rejection_notification: { order: 45, label: 'Early rejection' },
  notification:          { order: 50, label: 'Notification', chain: true },
  revision:              { order: 60, label: 'Revision due', chain: true },
  final_notification:    { order: 70, label: 'Final notification', chain: true },
  /* Deliberately off-chain. ICSE finalises directly-accepted papers a month
     BEFORE it decides the major-revision ones, and rolling-cycle venues put a
     camera-ready ahead of the next round's submission. "Camera-ready follows
     final notification" is simply not an invariant. The real one - it follows
     some acceptance decision - is checked separately below. */
  camera_ready:          { order: 80, label: 'Camera-ready' },
  camera_ready_after_revision: { order: 85, label: 'Camera-ready · 修訂後' },
  early_registration:    { order: 90, label: 'Early registration' },
  registration:          { order: 91, label: 'Registration' },
  conference_start:      { order: 99, label: 'Conference' },
};
/* Rolling-deadline venues (CSF runs three cycles a year) express each round as
   `<kind>_cycleN`. The suffix is parsed rather than enumerated, so a venue with
   five cycles needs no code change - which is the point of an open vocabulary.
   Ordering interleaves by cycle so one round's stages stay together. */
const CYCLE_RE = /^(.+)_cycle(\d+)$/;
export const baseKind = (k) => CYCLE_RE.exec(k)?.[1] ?? k;
export const cycleOf  = (k) => Number(CYCLE_RE.exec(k)?.[2] ?? 0);
export const inChain = (k) => KIND_META[baseKind(k)]?.chain === true;

const prettify = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const kindLabel = (k) => {
  const m = CYCLE_RE.exec(k);
  if (m) return `${KIND_META[m[1]]?.label ?? prettify(m[1])} · 第 ${m[2]} 輪`;
  return KIND_META[k]?.label ?? prettify(k);
};
export const kindOrder = (k) => {
  const m = CYCLE_RE.exec(k);
  const base = KIND_META[m ? m[1] : k]?.order ?? 500;
  return m ? Number(m[2]) * 100 + base : base;
};

/* Display order follows the dates, not the declared pipeline position: with
   rolling cycles a venue's camera-ready has a lower pipeline order than cycle 3
   yet happens much later. Undated milestones trail, ordered structurally. */
const byDateThenKind = (a, b) => {
  if (a.date && b.date) return a.date.localeCompare(b.date) || kindOrder(a.kind) - kindOrder(b.kind);
  if (a.date) return -1;
  if (b.date) return 1;
  return kindOrder(a.kind) - kindOrder(b.kind);
};

export { byDateThenKind };

export const CONFIDENCE_RANK = { unknown: 0, estimated: 1, announced: 2, confirmed: 3 };

/* Per-tier ceiling on how much a fetched date is allowed to be trusted.
   Enforced in the adapters so no one has to remember it. */
export const TIER_CONFIDENCE_CEILING = {
  0: 'confirmed',   // ICORE  - ranks only
  1: 'announced',   // ccf-deadlines - community-curated YAML
  2: 'confirmed',   // conf.researchr.org - the conference's own site
  3: 'announced',   // WikiCFP - community-submitted, never trusted as confirmed
  4: 'confirmed',   // official conference site
};

/** AoE (Anywhere on Earth) is a fixed UTC-12 offset. */
export const zoneOf = (tz) => (!tz || tz === 'AoE' ? 'UTC-12' : tz);

/** Absolute instant for a milestone, or null when it has no date. */
export function instantOf(milestone, edition) {
  if (!milestone.date) return null;
  const zone = zoneOf(milestone.tz || edition?.timezone);
  const dt = DateTime.fromISO(`${milestone.date}T${milestone.time || '23:59:59'}`, { zone });
  return dt.isValid ? dt : null;
}

/** Shift by 364 days (52 weeks) so the weekday is preserved. CFP deadlines
    sit on a fixed weekday far more reliably than on a fixed calendar date. */
export function shift364(isoDate, years = 1) {
  const dt = DateTime.fromISO(isoDate, { zone: 'utc' });
  if (!dt.isValid) return null;
  return dt.plus({ days: 364 * years }).toISODate();
}

/* js-yaml's DEFAULT_SCHEMA coerces bare 2027-01-10 into a JS Date. CORE_SCHEMA
   drops the timestamp type, so dates stay strings and the files stay unquoted. */
export const loadYaml = (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA });

export function loadConferences({ includeHidden = false } = {}) {
  if (!fs.existsSync(CONF_DIR)) return [];
  return fs
    .readdirSync(CONF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => {
      const doc = loadYaml(fs.readFileSync(path.join(CONF_DIR, f), 'utf8'));
      return { ...doc, _file: f };
    })
    .filter((c) => includeHidden || !c.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* A milestone spread over five block-style lines makes every automated edit look
   like a rewrite. Collapsing all-scalar list items back to flow style keeps one
   milestone on one line, so a moved date shows up as exactly one changed line. */
/* Quote values whose punctuation would break flow syntax - but never a value
   that is ALREADY a flow collection, or `[]` becomes the string "[]". */
const isFlowCollection = (v) => /^\[.*\]$/.test(v) || /^\{.*\}$/.test(v);
const needsQuote = (v) =>
  /[,{}[\]]/.test(v) && !isFlowCollection(v) && !/^['"].*['"]$/.test(v);
const quote = (v) => (needsQuote(v) ? `'${v.replace(/'/g, "''")}'` : v);

function collapseFlow(text, maxLen = 150) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const head = /^(\s*)- ([A-Za-z_][\w]*): (\S.*)$/.exec(lines[i]);
    if (head) {
      const [, indent, k0, v0] = head;
      const child = indent + '  ';
      const parts = [`${k0}: ${quote(v0.trim())}`];
      let j = i + 1, ok = true;
      while (j < lines.length && lines[j].startsWith(child) && lines[j][child.length] !== ' ') {
        const c = /^\s*([A-Za-z_][\w]*): (\S.*)$/.exec(lines[j]);
        if (!c || /^[|>&*]/.test(c[2].trim())) { ok = false; break; }
        parts.push(`${c[1]}: ${quote(c[2].trim())}`);
        j++;
      }
      const flow = `${indent}- {${parts.join(', ')}}`;
      if (ok && j > i + 1 && flow.length <= maxLen) { out.push(flow); i = j; continue; }
    }
    // short scalar arrays: `areas:` / `  - FM` -> `areas: [FM]`
    const key = /^(\s*)([A-Za-z_][\w]*):\s*$/.exec(lines[i]);
    if (key) {
      const child = key[1] + '  ';
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const it = new RegExp(`^${child}- (\\S.*)$`).exec(lines[j]);
        if (!it || /[:{}]/.test(it[1])) break;
        items.push(quote(it[1].trim())); j++;
      }
      const flow = `${key[1]}${key[2]}: [${items.join(', ')}]`;
      if (items.length && j > i + 1 - 1 && flow.length <= maxLen) { out.push(flow); i = j; continue; }
    }
    out.push(lines[i]); i++;
  }
  return out.join('\n');
}

export function dumpConference(doc) {
  return collapseFlow(yaml.dump(doc, { lineWidth: 200, noRefs: true, sortKeys: false, schema: yaml.CORE_SCHEMA }));
}

export function saveConference(conf) {
  const { _file, ...doc } = conf;
  const file = path.join(CONF_DIR, _file || `${doc.id}.yml`);
  fs.mkdirSync(CONF_DIR, { recursive: true });
  const text = dumpConference(doc);
  // never write something we cannot read back identically
  const back = loadYaml(text);
  if (JSON.stringify(back) !== JSON.stringify(doc)) {
    const where = firstDiff(doc, back);
    throw new Error(`serialisation round-trip failed for ${doc.id} at ${where.path}: ` +
      `wrote ${JSON.stringify(where.before)}, read back ${JSON.stringify(where.after)}; refusing to write`);
  }
  fs.writeFileSync(file, text);
  return file;
}

/* Two lifecycles share this file: refresh-produced findings are rebuilt every
   run, while add-produced notes persist until a human clears them. Severity
   keeps the actionable ones from drowning in the informational ones. */
export const ACTIONABLE = new Set(['conflict', 'guard', 'multiple-candidates', 'wrong-venue',
                                   'ambiguous-track', 'add-rejected', 'no-adapter', 'fetch-failed',
                                   'estimate-unconfirmed', 'estimate-expired', 'stale-base']);
export const severityOf = (reason) => (ACTIONABLE.has(reason) ? 'action' : 'info');

/** Locate the first structural divergence between two objects. */
export function firstDiff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return { path: path || '/', before: a, after: b };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], `${path}/${k}`);
    if (d) return d;
  }
  return { path: path || '/', before: a, after: b };
}

export const ACK_FILE = path.join(ROOT, 'data', '_acknowledged.json');

/* A finding that cannot be dismissed becomes wallpaper, and then a genuinely new
   one goes unread. Most of what this queue reports is a stable fact rather than
   a pending decision - WikiCFP's CADE is a different conference and will be
   again tomorrow - so those need to be answerable once.

   The fingerprint drops 4-digit years, which is the difference between
   acknowledging "WikiCFP's CADE is wrong" once and re-answering it every year.
   Everything else stays in, so a conflict whose dates move re-surfaces: that
   one really is a new decision. */
export const fingerprint = (item) => {
  /* wrong-venue is a statement about a mapping, not about one year's impostor.
     WikiCFP's CADE carries a different bogus title each year, so keying on the
     detail would ask the same question again every December. Keying on the
     venue answers it once - and cannot hide anything, because a correct entry
     produces no finding at all. */
  if (item.reason === 'wrong-venue') return `wrong-venue|${item.conference || ''}`;
  return [
    item.reason, item.conference || '', item.edition || '', item.kind || '',
    String(item.detail || '').replace(/\b(19|20)\d{2}\b/g, 'Y'),
  ].join('|');
};

export function loadAcks() {
  try { return JSON.parse(fs.readFileSync(ACK_FILE, 'utf8')); } catch { return []; }
}
export function saveAcks(list) {
  fs.mkdirSync(path.dirname(ACK_FILE), { recursive: true });
  fs.writeFileSync(ACK_FILE, JSON.stringify(list, null, 2) + '\n');
}
/** Acknowledged findings stay in the file as a record; they just stop shouting. */
export function applyAcks(items, acks = loadAcks()) {
  const seen = new Set(acks.map((a) => a.fingerprint));
  return items.map((it) => (seen.has(fingerprint(it)) ? { ...it, severity: 'acknowledged' } : it));
}

export function readReviewQueue() {
  try { return JSON.parse(fs.readFileSync(REVIEW_QUEUE, 'utf8')); } catch { return []; }
}
export function writeReviewQueue(items) {
  fs.mkdirSync(path.dirname(REVIEW_QUEUE), { recursive: true });
  fs.writeFileSync(REVIEW_QUEUE, JSON.stringify(items, null, 2) + '\n');
}

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export async function fetchText(url, { timeout = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/* ---- sanity guards ----
   Shared by validate.mjs (checking what is on disk) and refresh.mjs (vetting a
   proposed write before it lands), so the two can never drift apart. */
export const AT_CONFERENCE = new Set(['registration', 'early_registration', 'conference_start']);
export const MAX_LEAD_MONTHS = 24;

/** @returns {string[]} human-readable problems with one edition; empty means clean. */
export function editionIssues(conf, ed) {
  const out = [];
  const start = ed.start_date ? DateTime.fromISO(ed.start_date, { zone: 'utc' }) : null;

  if (ed.id !== `${conf.id}-${ed.year}`) out.push(`edition id "${ed.id}" should be "${conf.id}-${ed.year}"`);
  if (start && ed.end_date) {
    const end = DateTime.fromISO(ed.end_date, { zone: 'utc' });
    if (end < start) out.push(`end_date ${ed.end_date} precedes start_date ${ed.start_date}`);
  }

  const kinds = new Set();
  const dated = [];
  for (const m of ed.milestones || []) {
    if (kinds.has(m.kind)) out.push(`duplicate milestone kind "${m.kind}"`);
    kinds.add(m.kind);
    if (!m.date) continue;
    const d = DateTime.fromISO(m.date, { zone: 'utc' });
    if (!d.isValid) { out.push(`${m.kind}: unparseable date "${m.date}"`); continue; }
    dated.push({ ...m, _d: d });

    if (start && !AT_CONFERENCE.has(m.kind) && d > start)
      out.push(`${m.kind}: ${m.date} is after the conference start ${ed.start_date}`);
    if (start && start.diff(d, 'months').months > MAX_LEAD_MONTHS)
      out.push(`${m.kind}: ${m.date} is more than ${MAX_LEAD_MONTHS} months before the conference`);
    // A 2027 edition whose deadline sits in 2026 is normal; only a date outside
    // [year-2, year] indicates a mis-parse.
    if (d.year > ed.year || d.year < ed.year - 2)
      out.push(`${m.kind}: ${m.date} is implausible for a ${ed.year} edition`);
    if (m.derived_from) {
      const [srcEd, srcKind] = m.derived_from.split('/');
      const src = (conf.editions || []).find((e) => e.id === srcEd);
      if (!src) out.push(`${m.kind}: derived_from points at unknown edition "${srcEd}"`);
      else if (!src.milestones.some((x) => x.kind === srcKind))
        out.push(`${m.kind}: derived_from points at missing milestone "${m.derived_from}"`);
    }
  }

  /* The true camera-ready invariant: it cannot precede the first acceptance
     decision of its edition, whichever branch it belongs to. */
  const firstNotification = dated
    .filter((m) => /^notification(_cycle\d+)?$/.test(m.kind))
    .sort((a, b) => a._d - b._d)[0];
  if (firstNotification) {
    for (const m of dated.filter((x) => /^camera_ready/.test(x.kind))) {
      if (m._d < firstNotification._d)
        out.push(`${m.kind} (${m.date}) precedes the first notification (${firstNotification.date})`);
    }
  }

  /* Check the chain within each submission cycle separately. Cycle 2's
     submission legitimately precedes cycle 1's notification, so comparing
     across cycles would flag a correct calendar as broken. */
  const groups = new Map();
  for (const m of dated.filter((x) => inChain(x.kind))) {
    const c = cycleOf(m.kind);
    (groups.get(c) || groups.set(c, []).get(c)).push(m);
  }
  for (const [, list] of groups) {
    const ordered = list.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]._d < ordered[i - 1]._d)
        out.push(`${ordered[i].kind} (${ordered[i].date}) precedes ${ordered[i - 1].kind} (${ordered[i - 1].date})`);
    }
  }
  return out;
}

export const daysBetween = (a, b) =>
  Math.abs(DateTime.fromISO(a, { zone: 'utc' }).diff(DateTime.fromISO(b, { zone: 'utc' }), 'days').days);

/* ---- estimate audit ----
   Re-fetching daily replaces an estimate the moment a real date appears, but
   nothing in that loop notices an estimate that is running out of time without
   ever being confirmed. TACAS 2027 sat at an estimated 2026-10-08 derived from
   a 2024 base while the real deadline was 2026-10-15 - close enough to look
   fine, wrong enough to miss a submission by a week. These checks escalate
   before the date arrives rather than after. */
export const ESTIMATE_WARN_DAYS = 90;
export const STALE_BASE_YEARS = 2;

export function auditEstimates(conf, { today = DateTime.utc() } = {}) {
  const out = [];
  for (const ed of conf.editions || []) {
    if (ed.status === 'past') continue;
    for (const m of ed.milestones || []) {
      if (m.confidence !== 'estimated' || !m.date) continue;
      const days = Math.round(DateTime.fromISO(m.date, { zone: 'utc' }).diff(today, 'days').days);

      if (days < 0) {
        out.push({ edition: ed.id, kind: m.kind, reason: 'estimate-expired',
          detail: `estimated ${m.date} has passed and was never confirmed - the CFP either moved or was never found` });
      } else if (days <= ESTIMATE_WARN_DAYS) {
        out.push({ edition: ed.id, kind: m.kind, reason: 'estimate-unconfirmed',
          detail: `estimated ${m.date} is ${days} day(s) away and still unconfirmed - check the official CFP` });
      }

      if (m.derived_from) {
        const srcYear = Number(/-(\d{4})\//.exec(m.derived_from)?.[1]);
        const shift = srcYear ? ed.year - srcYear : 0;
        if (shift > STALE_BASE_YEARS) {
          out.push({ edition: ed.id, kind: m.kind, reason: 'stale-base',
            detail: `derived from ${m.derived_from}, a ${shift}-year shift - too far back to trust` });
        }
      }
    }
  }
  return out;
}

/* ---- forward projection ----
   The estimate machinery only ever ran when a venue was first added, so a
   calendar seeded for 2027 would quietly stop looking ahead once 2027's calls
   closed. Shared by add.mjs (first seeding) and refresh.mjs (rolling forward)
   so the two produce identical shapes. */

/** The year worth planning for: this year until its calls close mid-year, then the next. */
export const planningYear = (now = DateTime.utc()) => (now.month >= 7 ? now.year + 1 : now.year);

/** Project an edition `targetYear` from `base` by shifting +364d per year. */
export function estimateEdition(confId, base, targetYear,
                                { placeholders = ['notification', 'camera_ready', 'registration'] } = {}) {
  const n = targetYear - base.year;
  if (n <= 0) return null;
  const start = base.start_date ? shift364(base.start_date, n) : null;
  const end = base.end_date || base.start_date ? shift364(base.end_date || base.start_date, n) : null;
  const fmt = (d) => DateTime.fromISO(d, { zone: 'utc' }).toFormat('LLL d');

  const ed = {
    year: targetYear, id: `${confId}-${targetYear}`, timezone: base.timezone || 'AoE',
    place: 'TBD', status: 'estimated', needs_review: true,
    dates: start ? `${fmt(start)}-${DateTime.fromISO(end, { zone: 'utc' }).toFormat('d')}, ${targetYear} (estimated)` : 'TBD',
    ...(start ? { start_date: start, end_date: end } : {}),
    milestones: base.milestones
      .filter((m) => m.date)
      .map((m) => ({ kind: m.kind, date: shift364(m.date, n), confidence: 'estimated',
                     derived_from: `${base.id}/${m.kind}` })),
  };
  for (const k of placeholders)
    if (!ed.milestones.some((m) => baseKind(m.kind) === k)) ed.milestones.push({ kind: k, confidence: 'unknown' });
  ed.milestones.sort(byDateThenKind);
  return ed;
}

/** Kinds that represent "the call is still open" for planning purposes. */
export const CALL_KINDS = new Set(['abstract', 'submission']);
