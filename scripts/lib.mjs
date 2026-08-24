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
  rebuttal_start:        { order: 40, label: 'Rebuttal opens', chain: true },
  rebuttal_end:          { order: 41, label: 'Rebuttal ends', chain: true },
  early_rejection_notification: { order: 45, label: 'Early rejection' },
  notification:          { order: 50, label: 'Notification', chain: true },
  revision:              { order: 60, label: 'Revision due', chain: true },
  final_notification:    { order: 70, label: 'Final notification', chain: true },
  camera_ready:          { order: 80, label: 'Camera-ready', chain: true },
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
                                   'ambiguous-track', 'add-rejected', 'no-adapter', 'fetch-failed']);
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
