/* Tier 1 - ccfddl/ccf-deadlines.
   Already YAML on GitHub, so no HTML parsing. Broad coverage of mainstream
   venues, but it only carries abstract + submission, and it is community
   maintained: ceiling is "announced", never "confirmed". */
import { fetchText, loadYaml } from '../lib.mjs';

const RAW = 'https://raw.githubusercontent.com/ccfddl/ccf-deadlines/main/';
const TREE = 'https://api.github.com/repos/ccfddl/ccf-deadlines/git/trees/main?recursive=1';
let treeCache = null;

/** Every conference/<AREA>/<id>.yml path, keyed by bare id. */
export async function index() {
  if (treeCache) return treeCache;
  const t = JSON.parse(await fetchText(TREE, { timeout: 40000 }));
  treeCache = new Map();
  for (const e of t.tree || []) {
    const m = /^conference\/[A-Z]+\/([^/]+)\.yml$/.exec(e.path);
    if (m) treeCache.set(m[1].toLowerCase(), e.path);
  }
  return treeCache;
}

export async function resolve(acronym) {
  const idx = await index();
  return idx.get(acronym.toLowerCase()) || null;
}

const splitDT = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s).trim());
  return m ? { date: m[1], time: m[2] } : null;
};

/* Several timeline entries are usually rounds: S&P, CCS, NDSS, USENIX Security,
   OOPSLA and ICSE each list one entry per round. Reading only the first
   imported S&P 2027 as closed in June while its November round was open.
   Not always, though - VMCAI 2027 lists "Paper Registration" and then "Paper
   Submission", one round in two steps. An entry whose comment names a
   registration or an abstract, and no round, is that first step. */
const ROUND = /cycle|round|first|second|third|summer|fall|autumn|winter|spring/i;
const STEP = /regist|abstract/i;

export function milestonesOf(timeline = []) {
  const entries = timeline
    .map((t) => ({ abs: splitDT(t.abstract_deadline), due: splitDT(t.deadline), note: String(t.comment || '') }))
    .filter((t) => t.due);
  const steps = entries.filter((t) => STEP.test(t.note) && !ROUND.test(t.note));
  const rounds = entries.filter((t) => !steps.includes(t)).sort((x, y) => x.due.date.localeCompare(y.due.date));
  if (rounds.length > 1)
    return rounds.flatMap((t, i) => [
      ...(t.abs ? [{ kind: `abstract_cycle${i + 1}`, ...t.abs }] : []),
      { kind: `submission_cycle${i + 1}`, ...t.due },
    ]);
  const main = rounds[0] ?? entries[0];
  if (!main) return [];
  const abs = main.abs ?? (main === rounds[0] ? steps[0]?.due : null);
  return [...(abs ? [{ kind: 'abstract', ...abs }] : []), { kind: 'submission', ...main.due }];
}

/** -> [{ year, link, place, dates, timezone, milestones:[{kind,date,time,...}] }] */
export async function fetchEditions(ref) {
  const url = RAW + ref;
  const docs = loadYaml(await fetchText(url));
  const doc = Array.isArray(docs) ? docs[0] : docs;
  if (!doc?.confs) return [];
  return doc.confs.map((c) => ({
    year: c.year, link: c.link || null, place: c.place || null, dates: c.date || null,
    timezone: c.timezone || 'AoE',
    milestones: milestonesOf(c.timeline).map((m) => ({ ...m, confidence: 'announced', source_url: url, adapter: 'ccfddl' })),
    source_url: url,
  }));
}
