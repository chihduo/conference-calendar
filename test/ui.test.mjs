#!/usr/bin/env node
/* Browser-level regression tests, run against the built dist/index.html in a
   real DOM. A hand-rolled stub is not enough here: it dispatches no events and
   implements every API, so it happily passed code that was dead in a browser.
   window.confirm is stubbed to return false throughout, which is exactly what a
   sandboxed iframe without allow-modals does - the published artifact runs in
   one, and that is how the delete button came to look broken.
     npm run test:ui
*/
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function boot() {
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/' });
  const { window } = dom;
  window.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: [
    { id: 'p1', paper: 'Paper ONE', venue: 'vmcai-2027', status: 'submitted', history: [] },
    { id: 'p2', paper: 'Paper TWO', venue: 'tacas-2027', status: 'planned',   history: [] },
  ]}));
  // what a sandboxed iframe without allow-modals actually does
  window.confirm = () => false;
  window.alert = () => {};
  window.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
  // Local-only mode: this suite is about the UI, and must not change behaviour
  // just because data/sync-config.json exists in the checkout.
  window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
    .replace(/window\.__SYNC_CONFIG__ = [\s\S]*?;/, 'window.__SYNC_CONFIG__ = null;'));
  [...window.document.querySelectorAll('.tab')].find(t => t.textContent.includes('我的投稿')).click();
  return { dom, window };
}
const subsOf = (w) => JSON.parse(w.localStorage.getItem('cc-submissions')).submissions;
const titles = (w) => [...w.document.querySelectorAll('#main .card')]
  .filter(c => c.querySelector('h3')).map(c => c.querySelector('h3').textContent);
const btns = (w) => [...w.document.querySelectorAll('#main button')].filter(b => /刪除|再按一次/.test(b.textContent));

let pass = 0, total = 0;
const check = (name, cond, detail = '') => { total++; if (cond) pass++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

console.log('=== 兩段式刪除(confirm 被封鎖)===');
{
  const { dom, window: w } = boot();
  const before = titles(w);
  console.log('  卡片順序(依下一個待辦排序): ' + before.join(', '));
  btns(w)[0].click();
  check('第一次點只是待確認', subsOf(w).length === 2, `按鈕變成「${btns(w)[0].textContent}」`);
  btns(w)[0].click();
  const after = subsOf(w).map(x => x.paper);
  check('第二次點才真的刪除', after.length === 1 && after[0] !== before[0].trim(),
        `剩下 ${after.join(', ')}`);
  check('畫面同步更新', titles(w).length === 1);
  dom.window.close();
}

console.log('\n=== 4 秒未確認自動還原 ===');
{
  const { dom, window: w } = boot();
  btns(w)[0].click();
  check('已進入待確認', btns(w)[0].textContent === '再按一次確認');
  await new Promise(r => setTimeout(r, 4300));
  check('逾時還原成「刪除」', btns(w)[0].textContent === '刪除');
  check('資料未被動到', subsOf(w).length === 2);
  dom.window.close();
}

console.log('\n=== 刪光之後 ===');
{
  const { dom, window: w } = boot();
  for (let i = 0; i < 2; i++) { btns(w)[0].click(); btns(w)[0].click(); }
  check('兩筆都刪掉', subsOf(w).length === 0);
  check('顯示空狀態提示', (w.document.querySelector('#main .empty')?.textContent || '').includes('還沒有投稿紀錄'));
  dom.window.close();
}

console.log('\n=== 與我無關的列要灰掉 ===');
{
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const mk = (subs) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      { runScripts: 'dangerously', url: 'https://example.org/' });
    const w = dom.window; w.confirm = () => false;
    w.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: subs }));
    w.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
    w.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
      .replace(/window\.__SYNC_CONFIG__ = [\s\S]*?;/, 'window.__SYNC_CONFIG__ = null;'));
    return dom;
  };
  const rows = (w) => [...w.document.querySelectorAll('#main .row')].map((r) => ({
    cls: r.className,
    txt: [...r.querySelectorAll('.cname,.mkind')].map((n) => n.textContent).join(' ').trim(),
  }));

  let d = mk([]);
  const all = rows(d.window);
  const moot = all.filter((r) => r.cls.includes('moot'));
  check('投稿已截止且沒追蹤的後續日期會變灰', moot.length > 0, `${moot.length}/${all.length} 列`);
  check('投稿與摘要本身永遠不灰（那才是你要決定的）',
        !moot.some((r) => /Submission|Abstract/.test(r.txt)));
  check('已過期的列不重複套用（.past 已經處理）',
        !moot.some((r) => r.cls.includes('past')));
  d.window.close();

  // tracking a paper makes the whole edition relevant again
  d = mk([{ id: 'a', paper: 'P', venue: 'icse-2027', status: 'submitted', history: [] }]);
  const icse = rows(d.window).filter((r) => /ICSE 2027/.test(r.txt));
  check('追蹤了論文之後該會議整屆恢復正常',
        icse.length > 0 && !icse.some((r) => r.cls.includes('moot')), `${icse.length} 列`);
  d.window.close();

  // a venue still taking submissions in a later round must not be greyed
  d = mk([]);
  const csf = rows(d.window).filter((r) => /CSF 2027/.test(r.txt));
  check('滾動截稿：還有下一輪可投時整屆都不灰',
        csf.length > 0 && !csf.some((r) => r.cls.includes('moot')), `${csf.length} 列`);
  d.window.close();
}

console.log('\n=== AoE 時鐘 ===');
{
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/' });
  const w = dom.window;
  w.confirm = () => false;
  w.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
  // Local-only mode: these suites are about the UI, and must not change
  // behaviour just because data/sync-config.json exists in the checkout.
  w.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
    .replace(/window\.__SYNC_CONFIG__ = [\s\S]*?;/, 'window.__SYNC_CONFIG__ = null;') + '\nglobalThis.__c={digitSVG,clockHTML,SEG_PATH};');
  const { digitSVG, clockHTML, SEG_PATH } = w.__c;
  const NAMES = Object.keys(SEG_PATH);
  const EXPECT = { 0:'abcdef',1:'bc',2:'abdeg',3:'abcdg',4:'bcfg',5:'acdfg',6:'acdefg',7:'abc',8:'abcdefg',9:'abcdfg' };
  const box = w.document.createElement('div');
  const segsOf = (node) => [...node.querySelectorAll('polygon')]
    .map((p, i) => p.getAttribute('class').includes('on') ? NAMES[i] : null).filter(Boolean).sort().join('');

  let bad = [];
  for (const d of '0123456789') {
    box.innerHTML = digitSVG(d);
    if (segsOf(box) !== [...EXPECT[d]].sort().join('')) bad.push(d);
  }
  check('十個數字的七段對應都正確', bad.length === 0, bad.length ? '錯的: ' + bad.join(',') : '');

  box.innerHTML = digitSVG('8');
  check('未點亮的段也畫出來（鬼影，LCD 的關鍵）',
        box.querySelectorAll('polygon').length === 7);

  const dimAt = (sec) => { box.innerHTML = clockHTML(new Date(Date.UTC(2026, 7, 25, 12, 0, sec)));
    return box.querySelector('.lcd-colon').getAttribute('class').includes('dim'); };
  check('冒號每秒閃爍（沒有秒數時，這是唯一在動的東西）',
        dimAt(0) === false && dimAt(1) === true && dimAt(2) === false);

  /* Read the panel back the way an eye would: decode the lit segments of each
     digit rather than trusting a text node, so a mis-mapped digit fails here. */
  const readField = (sel) => [...box.querySelectorAll(`${sel} .lcd-digit`)]
    .map((d) => Object.entries(EXPECT).find(([, v]) => [...v].sort().join('') === segsOf(d))?.[0] ?? '?')
    .join('');

  box.innerHTML = clockHTML(new Date('2026-08-25T12:00:00Z'));
  check('日期用七段顯示，和時間同一尺寸',
        box.querySelectorAll('.lcd-date .lcd-digit').length === 4 &&
        box.querySelectorAll('.lcd-time .lcd-digit').length === 4,
        `日期 ${box.querySelectorAll('.lcd-date .lcd-digit').length} 位，時間 ${box.querySelectorAll('.lcd-time .lcd-digit').length} 位`);
  check('不顯示秒數（總共 8 位數字）',
        box.querySelectorAll('.lcd-digit').length === 8);

  let rollOk = 0, rolls = [];
  for (const [iso, wantDate, wantTime] of [['2026-08-25T11:59:00Z', '0824', '2359'],
                                           ['2026-08-25T12:00:00Z', '0825', '0000'],
                                           ['2026-01-01T00:00:00Z', '1231', '1200']]) {
    box.innerHTML = clockHTML(new Date(iso));
    const got = `${readField('.lcd-date')} ${readField('.lcd-time')}`;
    rolls.push(got);
    if (got === `${wantDate} ${wantTime}`) rollOk++;
  }
  check('AoE 比 UTC 慢 12 小時（含跨日、跨年）', rollOk === 3, rolls.join(' | '));

  const clock = w.document.querySelector('#clock');
  check('時鐘在 header 裡（render() 不會重置它）',
        !!clock && !w.document.querySelector('#main').contains(clock));
  dom.window.close();
}

console.log('\n=== 主題預設 ===');
{
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const mk = (pre) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      { runScripts: 'dangerously', url: 'https://example.org/' });
    if (pre) dom.window.localStorage.setItem('cc-theme', pre);
    dom.window.confirm = () => false;
    dom.window.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
    dom.window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    return dom;
  };

  let d = mk(null);
  check('沒有偏好時預設深色', d.window.document.documentElement.dataset.theme === 'dark',
        d.window.document.documentElement.dataset.theme);
  const btn = d.window.document.querySelector('#theme');
  check('切換鈕標示目標主題「淺色」', btn.textContent === '淺色', btn.textContent);
  btn.click();
  check('點一下切到淺色', d.window.document.documentElement.dataset.theme === 'light');
  check('選擇有存起來', d.window.localStorage.getItem('cc-theme') === 'light');
  d.window.close();

  d = mk('light');
  check('重新載入沿用存下的淺色', d.window.document.documentElement.dataset.theme === 'light');
  d.window.close();

  // dark must be the base palette, not a media query, or the page flashes light first
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const base = /:root, :root\[data-theme="dark"\] \{[\s\S]*?--paper: (#[0-9a-f]{6})/.exec(css);
  check(':root 基礎色票就是深色（不靠 JS，不會閃白）', base && base[1] === '#13171b', base?.[1]);
  check('不再用 prefers-color-scheme 決定主題',
        !/@media[^{]*prefers-color-scheme[^{]*\{[^}]*--paper/.test(css));
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);
