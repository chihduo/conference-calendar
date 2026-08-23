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

/** -> [{ year, link, place, dates, timezone, milestones:[{kind,date,time,...}] }] */
export async function fetchEditions(ref) {
  const url = RAW + ref;
  const docs = loadYaml(await fetchText(url));
  const doc = Array.isArray(docs) ? docs[0] : docs;
  if (!doc?.confs) return [];
  return doc.confs.map((c) => {
    const tl = (c.timeline || [])[0] || {};
    const ms = [];
    const a = splitDT(tl.abstract_deadline);
    const d = splitDT(tl.deadline);
    if (a) ms.push({ kind: 'abstract', ...a });
    if (d) ms.push({ kind: 'submission', ...d });
    return {
      year: c.year, link: c.link || null, place: c.place || null, dates: c.date || null,
      timezone: c.timezone || 'AoE',
      milestones: ms.map((m) => ({ ...m, confidence: 'announced', source_url: url, adapter: 'ccfddl' })),
      extra_cycles: (c.timeline || []).length > 1 ? (c.timeline || []).length - 1 : 0,
      source_url: url,
    };
  });
}
