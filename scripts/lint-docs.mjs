#!/usr/bin/env node
/* Parse every mermaid block in the docs.
   A broken diagram renders as an error box on GitHub, and the syntax is not
   something you can eyeball - an empty dotted-link label (`-. .->`) looks
   perfectly reasonable and is not valid.
     npm run lint:docs
*/
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'https://example.org/' });
for (const k of ['window','document','navigator','Element','SVGElement','HTMLElement','DOMPurify','MutationObserver','requestAnimationFrame','getComputedStyle'])
  if (dom.window[k] !== undefined) global[k] = dom.window[k];
global.self = dom.window;

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

const DOCS = ['README.md', 'supabase/SETUP.md'].filter((f) => fs.existsSync(f));
const blocks = DOCS.flatMap((f) =>
  [...fs.readFileSync(f, 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => ({ file: f, src: m[1] })));
if (!blocks.length) { console.log('沒有 mermaid 圖。'); process.exit(0); }
let ok = 0;
for (const [i, { file, src }] of blocks.entries()) {
  try {
    await mermaid.parse(src);
    console.log(`  ok   ${file} 圖 ${i + 1}  (${src.trim().split('\n')[0]})`);
    ok++;
  } catch (e) {
    console.log(`  FAIL ${file} 圖 ${i + 1}: ${String(e.message || e).split('\n').slice(0, 4).join(' | ')}`);
  }
}
console.log(`  ${ok}/${blocks.length} 可解析`);
process.exit(ok === blocks.length ? 0 : 1);
