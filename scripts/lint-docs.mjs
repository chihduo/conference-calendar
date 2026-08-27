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

/* Markdown joins a wrapped line to the next with a space. That is right for
   English and wrong for Chinese: hard-wrapping a CJK paragraph puts a visible
   gap mid-word in the rendered page ("某個 會議"), and nothing about the source
   looks wrong. So CJK paragraphs are not hard-wrapped, and this keeps it that
   way. */
const CJK = '\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef';
const endsCJK = new RegExp(`[${CJK}]$`);
const startsCJK = new RegExp(`^[${CJK}]`);
let wrapped = 0;
for (const f of DOCS) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let fence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i], nx = lines[i + 1];
    if (l.trim().startsWith('```')) { fence = !fence; continue; }
    if (fence || !l.trim() || !nx.trim()) continue;
    if (/^\s*([|#>]|[-*+]\s|\d+\.\s)/.test(nx) || /^\s*[|#]/.test(l)) continue;
    if (endsCJK.test(l) && startsCJK.test(nx.trim())) {
      wrapped++;
      if (wrapped <= 5) console.log(`  FAIL ${f}:${i + 1} 中文段落在此換行，渲染時會多一個空格`
        + `\n       …${l.slice(-12)} ⏎ ${nx.trim().slice(0, 12)}…`);
    }
  }
}
if (wrapped) console.log(`  ${wrapped} 處中文硬斷行（中文段落請寫成一行，不要折行）`);
else console.log('  ok   中文段落沒有硬斷行');

/* Half-width punctuation next to Chinese, and a stray space after a full-width
   mark. Both render as a gap the source does not show - the same failure mode
   as the wrapping above, which is why it belongs to a linter rather than to a
   proofreader. Anything inside a code span or fence is left alone: a comma in
   `a,b` is code. */
const HALF = new RegExp(`(?:[${CJK}][,;:!?()]|[,;:!?()][${CJK}])`);
const STRAY = new RegExp(`[，。、；：！？）」] +(?=[*_\`\\[]|[${CJK}])`);
let punct = 0;
for (const f of DOCS) {
  let fence = false;
  fs.readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
    if (raw.trim().startsWith('```')) { fence = !fence; return; }
    if (fence || raw.trim().startsWith('|')) return;
    /* HALF reads the line with code spans blanked, because a comma inside
       `a,b` is code. STRAY has to read the raw line: blanking a span turns
       「，`code`」 into a comma followed by spaces and fabricates the very
       defect it is looking for. */
    const bare = raw.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
    for (const [re, why, subject] of [[HALF, '中文旁用了半形標點', bare],
                                      [STRAY, '全形標點後多了空格', raw]]) {
      const m = re.exec(subject);
      if (!m) continue;
      punct++;
      if (punct <= 5) console.log(`  FAIL ${f}:${i + 1} ${why}\n       …${raw.slice(Math.max(0, m.index - 14), m.index + 16)}…`);
    }
  });
}
if (punct) console.log(`  ${punct} 處中文標點問題`);
else console.log('  ok   中文標點都是全形，且沒有多餘空格');

process.exit(ok === blocks.length && wrapped === 0 && punct === 0 ? 0 : 1);
