#!/usr/bin/env node
/* Apply a choice made in an issue conversation to an existing conference file.
   The candidate list travels in the bot's own comment (see add-conference.yml),
   so answering costs a reply rather than a YAML edit - which matters, because
   the issue route is the only one usable from a phone.

     node scripts/resolve.mjs fse --choices='<json>' --reply='2'
*/
import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR, loadYaml, saveConference } from './lib.mjs';
import * as icore from './adapters/icore.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const id = args.find((a) => !a.startsWith('--'))?.toLowerCase();
const replyRaw = (flag('reply') || '').trim();
let choices;
try { choices = JSON.parse(flag('choices') || '[]'); } catch { choices = []; }

/** Match a free-text reply against one option list. Returns null when unsure -
    a wrong guess here silently mislabels a venue, so ambiguity must not resolve. */
export function matchReply(reply, options) {
  const t = reply.trim();
  if (!t) return null;

  // a bare ordinal, the form the bot asked for
  const n = /^#?\s*(\d{1,2})\s*$/.exec(t);
  if (n) {
    const i = Number(n[1]) - 1;
    if (i >= 0 && i < options.length) return options[i];
  }
  // the underlying value typed out (an ICORE id, or a track name)
  const exact = options.filter((o) => String(o.value).toLowerCase() === t.toLowerCase());
  if (exact.length === 1) return exact[0];
  // a distinctive fragment of the label - only when it picks out exactly one
  const lo = t.toLowerCase();
  const sub = options.filter((o) => String(o.label).toLowerCase().includes(lo));
  if (sub.length === 1) return sub[0];
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!id) { console.error('usage: resolve.mjs <conference-id> --choices=<json> --reply=<text>'); process.exit(2); }
  const file = path.join(CONF_DIR, `${id}.yml`);
  if (!fs.existsSync(file)) { console.error(`no such conference file: ${file}`); process.exit(1); }
  const doc = loadYaml(fs.readFileSync(file, 'utf8'));

  const applied = [];
  const unmatched = [];

  for (const c of choices) {
    const hit = matchReply(replyRaw, c.options);
    if (!hit) { unmatched.push(c); continue; }

    if (c.field === 'icore_id') {
      const ranks = await icore.loadRanks();
      const match = ranks.find((r) => r.icore_id === Number(hit.value));
      if (!match) { unmatched.push(c); continue; }
      doc.rank = icore.rankBlock(match, { checked_on: doc.rank?.checked_on });
      doc.full_name = match.title;
      applied.push(`rank → ${match.value} (icore_id ${match.icore_id}, ${match.title})`);
    } else if (c.field === 'track') {
      const src = (doc.sources || []).find((x) => x.adapter === 'researchr');
      if (!src) { unmatched.push(c); continue; }
      src.track = String(hit.value);
      applied.push(`researchr track → "${hit.value}"`);
    } else {
      unmatched.push(c);
    }
  }

  if (!applied.length) {
    console.log(`看不懂「${replyRaw}」對應到哪個選項。請回覆選項編號（例如 1），或選項的完整名稱。`);
    process.exit(3);
  }

  saveConference({ ...doc, _file: `${id}.yml` });
  applied.forEach((a) => console.log(`已套用：${a}`));
  if (unmatched.length) console.log(`仍待決定：${unmatched.map((c) => c.field).join(', ')}`);
}
