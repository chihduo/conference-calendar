#!/usr/bin/env node
/* Local, no-network audit of every estimated date. Answers "which of these
   guesses is about to matter, and which is built on sand?" */
import { loadConferences, auditEstimates, ESTIMATE_WARN_DAYS, STALE_BASE_YEARS } from './lib.mjs';

const rows = [];
for (const c of loadConferences({ includeHidden: true }))
  for (const a of auditEstimates(c)) rows.push({ conference: c.name, ...a });

const groups = { 'estimate-expired': [], 'estimate-unconfirmed': [], 'stale-base': [] };
for (const r of rows) groups[r.reason]?.push(r);

const TITLE = {
  'estimate-expired':     'Expired without confirmation',
  'estimate-unconfirmed': `Due within ${ESTIMATE_WARN_DAYS} days, still an estimate`,
  'stale-base':           `Derived from a base more than ${STALE_BASE_YEARS} years back`,
};
for (const [k, list] of Object.entries(groups)) {
  if (!list.length) continue;
  console.log(`\n${TITLE[k]}  (${list.length})`);
  for (const r of list) console.log(`   ${r.conference.padEnd(9)} ${r.edition}/${r.kind}\n      ${r.detail}`);
}
const total = rows.length;
console.log(total ? `\n${total} estimate(s) need attention.` : 'No estimates need attention.');
