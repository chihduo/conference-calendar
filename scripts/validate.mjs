#!/usr/bin/env node
/* Schema validation + the shared sanity guards.
   These exist because refresh.mjs writes YAML automatically: they are the net
   that catches a mis-parsed date before it reaches the site. */
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { CONF_DIR, ROOT, loadYaml, editionIssues } from './lib.mjs';

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/conference.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const errors = [], warnings = [];
const err  = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

const files = fs.existsSync(CONF_DIR) ? fs.readdirSync(CONF_DIR).filter((f) => /\.ya?ml$/.test(f)) : [];
const seenConf = new Map(), seenEd = new Map();
let nEditions = 0, nDocs = 0;

for (const file of files) {
  let doc;
  try { doc = loadYaml(fs.readFileSync(path.join(CONF_DIR, file), 'utf8')); }
  catch (e) { err(file, `YAML parse failed: ${e.message}`); continue; }

  if (!validateSchema(doc)) {
    for (const e of validateSchema.errors) err(file, `schema ${e.instancePath || '/'} ${e.message}`);
    continue;
  }
  nDocs++;

  if (seenConf.has(doc.id)) err(file, `duplicate conference id "${doc.id}" (also ${seenConf.get(doc.id)})`);
  seenConf.set(doc.id, file);

  if (doc.rank?.ambiguous) warn(file, `rank marked ambiguous - a human needs to pick the right ICORE entry`);

  for (const ed of doc.editions) {
    nEditions++;
    if (seenEd.has(ed.id)) err(file, `duplicate edition id "${ed.id}"`);
    seenEd.set(ed.id, file);
    for (const issue of editionIssues(doc, ed)) err(file, `${ed.id}: ${issue}`);

    if (ed.status === 'confirmed' && !ed.milestones.some((m) => m.confidence === 'confirmed'))
      warn(file, `${ed.id}: status is confirmed but no milestone is confirmed`);
    if (ed.status === 'estimated' && ed.milestones.some((m) => m.confidence === 'confirmed'))
      warn(file, `${ed.id}: status is estimated but a milestone is already confirmed - promote the edition`);
    if (ed.milestones.some((m) => m.needs_review))
      warn(file, `${ed.id}: has milestones flagged needs_review`);
  }
}

console.log(`Validated ${nDocs} conference file(s), ${nEditions} edition(s).`);
if (warnings.length) { console.log(`\n${warnings.length} warning(s):`); warnings.forEach((w) => console.log('  ! ' + w)); }
if (errors.length)   { console.log(`\n${errors.length} error(s):`);     errors.forEach((e) => console.log('  x ' + e)); }
if (!errors.length && !warnings.length) console.log('All checks passed.');
process.exit(errors.length || (process.argv.includes('--strict') && warnings.length) ? 1 : 0);
