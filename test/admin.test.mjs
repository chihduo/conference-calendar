#!/usr/bin/env node
/* Managing conferences from the site, driven through a real DOM against a
   stand-in for the conference-requests function. What the function itself
   decides is pinned in function.test.mjs; this suite pins what the page does
   with the answers - above all, that none of it appears for anyone but the
   owner, and that nothing is sent without a second tap.
     npm run test:admin
*/
import { JSDOM } from 'jsdom';
import { fixturePage, pinClock } from './page.mjs';

const HTML = fixturePage();
const CFG = { url: 'https://stub.supabase.co', anonKey: 'anon-key' };
const FN = '/functions/v1/conference-requests';

/** The function, as the page sees it. `status` other than 200 answers every call. */
function makeFunction({ status = 200, requests = [], onPost } = {}) {
  const calls = [];
  const issues = new Map(requests.map((r) => [r.issue, r]));
  const script = new Map();          // issue -> answers for successive polls
  let next = 200;
  const res = (s, b) => ({ ok: s < 400, status: s, json: async () => b, text: async () => JSON.stringify(b) });
  return {
    calls, issues, script,
    fetch: async (url, opts = {}) => {
      if (!url.includes(FN)) return res(200, []);            // PostgREST: no submissions
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, url, body, headers: opts.headers });
      if (status !== 200) return res(status, { error: { 403: '只有 chihduo 可以管理會議', 502: 'GitHub token 無效或已過期：到 Supabase 的 Edge Function Secrets 更新 CC_GITHUB_TOKEN。' }[status] || 'Requested function was not found' });
      const q = Number(new URL(url).searchParams.get('issue')) || 0;
      if (method === 'GET' && !q) return res(200, { owner: 'chihduo', requests: [...issues.values()].reverse() });
      if (method === 'GET') {
        const queue = script.get(q);
        const r = queue?.length ? queue.shift() : issues.get(q);
        issues.set(q, r);
        return res(200, r);
      }
      if (onPost) { const r = onPost(body); if (r) return r; }
      if (['add', 'remove', 'hide'].includes(body.action)) {
        const r = { issue: ++next, url: `https://github.com/i/${next}`, title: body.acronym, kind: body.action,
                    phase: 'waiting', created_at: new Date().toISOString(), message: '', choices: null };
        issues.set(r.issue, r);
        return res(201, r);
      }
      if (body.action === 'reply') { const r = { ...issues.get(body.issue), phase: 'waiting', message: '' }; issues.set(body.issue, r); return res(200, r); }
      if (body.action === 'dismiss') { issues.delete(body.issue); return res(200, { issue: body.issue, dismissed: true }); }
      return res(400, { error: 'unknown' });
    },
  };
}

async function boot({ fn, signedIn = true, wasOwner = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://chihduo.github.io/conference-calendar/' });
  const w = dom.window;
  pinClock(w);
  w.confirm = () => false;
  w.fetch = fn.fetch;
  if (signedIn) w.localStorage.setItem('cc-session',
    JSON.stringify({ access_token: 'tok', expires_at: Math.floor(w.Date.now() / 1000) + 3600 }));
  if (wasOwner) w.localStorage.setItem('cc-admin-owner', '1');
  w.document.body.innerHTML = HTML.replace(/<script>[\s\S]*<\/script>/, '');
  w.eval(HTML.match(/<script>([\s\S]*)<\/script>/)[1]
    .replace('window.__SYNC_CONFIG__ = null;', `window.__SYNC_CONFIG__ = ${JSON.stringify(CFG)};`)
    + '\nglobalThis.__t = { ADMIN, get ready() { return adminPending; } };');
  await w.__t.ready;
  w.__t.ADMIN._pollMs(15);
  tab(w, '依會議');
  return { dom, w, T: w.__t };
}
const tab = (w, name) => [...w.document.querySelectorAll('.tab')].find((t) => t.textContent.includes(name)).click();
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => [...w.document.querySelectorAll(s)];
const buttons = (w, root, t) => [...(root || w.document).querySelectorAll('button')].filter((b) => b.textContent.includes(t));
const cardOf = (w, name) => $$(w, '#main .card').find((c) => c.querySelector('h3 > span')?.textContent === name);
const rowOf = (w, text) => $$(w, '#main .req').find((r) => r.textContent.includes(text));
const until = async (cond, ms = 2000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
const posts = (fn) => fn.calls.filter((c) => c.method === 'POST').map((c) => c.body);

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };

console.log('=== 只有 owner 看得到 ===');
for (const [name, opts] of [['沒登入', { signedIn: false }], ['函式還沒部署（404）', { status: 404 }], ['登入的不是 owner（403）', { status: 403 }]]) {
  const fn = makeFunction({ status: opts.status ?? 200 });
  const { dom, w } = await boot({ fn, signedIn: opts.signedIn ?? true });
  check(`${name}：沒有管理卡，也沒有隱藏／移除按鈕`,
        !$(w, '#main .card.admin') && buttons(w, $(w, '#main'), '移除').length === 0);
  dom.window.close();
}
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn });
  check('owner：出現管理卡', !!$(w, '#main .card.admin'), $(w, '.admin-head .count')?.textContent);
  const cards = $$(w, '#main .card').filter((c) => !c.classList.contains('admin'));
  check('每張會議卡都有隱藏和移除', cards.length > 0 && cards.every((c) => buttons(w, c, '隱藏').length && buttons(w, c, '移除').length),
        `${cards.length} 張`);
  const call = fn.calls[0];
  check('帶著登入 token 問函式', call?.headers?.Authorization === 'Bearer tok' && call?.headers?.apikey === 'anon-key');
  tab(w, '截稿時間軸');
  check('截稿時間軸不放管理介面', !$(w, '#main .card.admin'));
  dom.window.close();
}

console.log('\n=== 沒登入時提醒 owner，只提醒 owner ===');
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn, signedIn: false, wasOwner: true });
  const hint = $(w, '#main .admin-hint');
  check('這台瀏覽器當過 owner、現在沒登入：提醒登入', /登入後可以在這裡新增或移除會議/.test(hint?.textContent || '') &&
        buttons(w, hint, '用 GitHub 登入').length === 1, hint?.textContent);
  check('提醒不等於管理介面', !$(w, '#main .card.admin'));
  dom.window.close();
}
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn, signedIn: false });
  check('沒當過 owner 的瀏覽器（其他訪客）：什麼都不提', !$(w, '#main .admin-hint'));
  dom.window.close();
}
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn });
  check('確認是 owner 之後，這台瀏覽器記住了', w.localStorage.getItem('cc-admin-owner') === '1');
  dom.window.close();
}
{
  const fn = makeFunction({ status: 403 });
  const { dom, w } = await boot({ fn, wasOwner: true });
  check('換了別的帳號登入（403）：忘掉，也不再提醒', !w.localStorage.getItem('cc-admin-owner') && !$(w, '#main .admin-hint'));
  dom.window.close();
}
for (const [who, wasOwner] of [['owner 的瀏覽器', true], ['其他瀏覽器', false]]) {
  const fn = makeFunction({ status: 502 });
  const { dom, w } = await boot({ fn, wasOwner });
  const hint = $(w, '#main .admin-hint');
  if (wasOwner) check('函式出錯（502）：owner 看得到原因，而不是卡片默默消失', /管理會議暫時無法使用/.test(hint?.textContent || ''), hint?.textContent);
  else check('函式出錯（502）：其他瀏覽器照舊什麼都不顯示', !hint);
  dom.window.close();
}

console.log('\n=== 新增 ===');
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn });
  const input = () => $(w, '#admin-acronym');
  const submit = (v) => { input().value = v; input().dispatchEvent(new w.Event('input')); $(w, '.card.admin form').dispatchEvent(new w.Event('submit', { cancelable: true })); };

  submit('USENIX Security');
  check('不像縮寫的直接在頁面上擋下', /不像會議縮寫/.test($(w, '.admin-err')?.textContent) && posts(fn).length === 0, $(w, '.admin-err')?.textContent);
  submit('POPL');
  check('已經在清單裡的也不送', /已經在清單裡/.test($(w, '.admin-err')?.textContent) && posts(fn).length === 0, $(w, '.admin-err')?.textContent);

  fn.script.set(201, [
    { issue: 201, url: 'u', title: 'S&P', kind: 'add', phase: 'waiting', created_at: new Date().toISOString(), message: '' },
    { issue: 201, url: 'u', title: 'S&P', kind: 'add', phase: 'done', created_at: new Date().toISOString(),
      message: '已新增 S&P → data/conferences/sp.yml\n\n完整輸出略' },
  ]);
  submit('S&P');
  await until(() => posts(fn).length === 1);
  check('送出 {action: add, acronym: S&P}', JSON.stringify(posts(fn)[0]) === '{"action":"add","acronym":"S&P"}');
  await until(() => rowOf(w, '新增 S&P'));
  check('馬上出現一列「處理中」，輸入框清空', /處理中/.test(rowOf(w, '新增 S&P')?.textContent || '') && input().value === '');
  await until(() => /完成/.test(rowOf(w, '新增 S&P')?.querySelector('.req-state')?.textContent || ''));
  const done = rowOf(w, '新增 S&P');
  check('bot 回覆後自動變成完成，顯示第一段', /完成/.test(done?.textContent) && /已新增 S&P → data\/conferences\/sp\.yml/.test(done?.textContent) && !/完整輸出略/.test(done?.textContent));
  check('完成後提示網站稍後更新，給重新整理', buttons(w, done, '重新整理').length === 1);
  dom.window.close();
}
{
  // a poll that lands while you are typing must not take the field away
  const fn = makeFunction();
  const { dom, w, T } = await boot({ fn });
  const input = $(w, '#admin-acronym');
  input.focus();
  input.value = 'EuroS';
  input.dispatchEvent(new w.Event('input'));
  fn.script.set(201, [{ issue: 201, url: 'u', title: 'X', kind: 'add', phase: 'done', created_at: new Date().toISOString(), message: 'ok' }]);
  fn.issues.set(201, { issue: 201, url: 'u', title: 'X', kind: 'add', phase: 'waiting', created_at: new Date().toISOString(), message: '' });
  await T.ADMIN.probe();                             // picks up #201 and starts watching it
  await until(() => /完成/.test(rowOf(w, '新增 X')?.textContent || ''));
  const again = $(w, '#admin-acronym');
  check('輪詢重畫後，打到一半的字和游標都還在', again?.value === 'EuroS' && w.document.activeElement === again, again?.value);
  dom.window.close();
}
{
  const fn = makeFunction({ onPost: (b) => b.action === 'add'
    ? { ok: false, status: 502, json: async () => ({ error: 'GitHub token 無效或已過期：到 Supabase 的 Edge Function Secrets 更新 CC_GITHUB_TOKEN。' }) }
    : null });
  const { dom, w } = await boot({ fn });
  $(w, '#admin-acronym').value = 'CCS';
  $(w, '.card.admin form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await until(() => $(w, '.admin-err'));
  check('函式失敗時把原因顯示出來', /CC_GITHUB_TOKEN/.test($(w, '.admin-err')?.textContent || ''), $(w, '.admin-err')?.textContent);
  dom.window.close();
}

console.log('\n=== 選擇題與卡住的請求 ===');
{
  const now = new Date().toISOString();
  const fn = makeFunction({ requests: [
    { issue: 150, url: 'u', title: 'FSE', kind: 'add', phase: 'needs-choice', created_at: now,
      message: '已建立 data/conferences/fse.yml，但有一處需要你決定。\n\nICORE 裡有 2 筆…',
      choices: [{ field: 'icore_id', question: 'ICORE 裡有 2 筆叫 FSE 的會議，是哪一個？',
                  options: [{ value: '1', label: 'A* — ACM FSE' }, { value: '2', label: 'B — Fast Software Encryption' }] }] },
    { issue: 151, url: 'u', title: 'ZZQ', kind: 'add', phase: 'stuck', created_at: now,
      message: '沒有新增 ZZQ：沒有寫出任何檔案。\n\n需要你處理 1 件事：\n- 1. 沒有任何來源有日期。' },
  ] });
  const { dom, w } = await boot({ fn });
  const q = rowOf(w, '新增 FSE');
  check('選擇題：題目和選項按鈕', /是哪一個/.test(q?.textContent) && buttons(w, q, 'A* — ACM FSE').length === 1);
  buttons(w, q, '1. A* — ACM FSE')[0].click();
  await until(() => posts(fn).length === 1);
  check('按選項 = 在 issue 回覆編號', JSON.stringify(posts(fn)[0]) === '{"action":"reply","issue":150,"text":"1"}');
  await until(() => /處理中/.test(rowOf(w, '新增 FSE')?.textContent || ''));
  check('回覆後回到處理中', /處理中/.test(rowOf(w, '新增 FSE')?.textContent || ''));

  const stuck = rowOf(w, '新增 ZZQ');
  check('卡住的：原因整段都在', /沒有任何來源有日期/.test(stuck?.textContent));
  buttons(w, stuck, '關掉這筆')[0].click();
  await until(() => !rowOf(w, '新增 ZZQ'));
  check('關掉之後從清單消失', !rowOf(w, '新增 ZZQ') && posts(fn).some((b) => b.action === 'dismiss' && b.issue === 151));
  dom.window.close();
}

console.log('\n=== 隱藏與移除要按兩次 ===');
{
  const fn = makeFunction();
  const { dom, w } = await boot({ fn });
  let rm = buttons(w, cardOf(w, 'POPL'), '移除')[0];
  rm.click();
  rm = buttons(w, cardOf(w, 'POPL'), '移除')[0];
  check('第一次只是待確認', rm.textContent === '再按一次：移除' && posts(fn).length === 0, rm.textContent);
  rm.click();
  await until(() => posts(fn).length === 1);
  check('第二次才送出 {action: remove, acronym: POPL}', JSON.stringify(posts(fn)[0]) === '{"action":"remove","acronym":"POPL"}');
  await until(() => /移除處理中/.test(cardOf(w, 'POPL')?.textContent || ''));
  check('那張卡改成顯示處理中，按鈕收起來', /移除處理中/.test(cardOf(w, 'POPL')?.textContent) && !buttons(w, cardOf(w, 'POPL'), '移除').length);

  let hd = buttons(w, cardOf(w, 'CSF'), '隱藏')[0];
  hd.click();
  buttons(w, cardOf(w, 'CSF'), '隱藏')[0].click();
  await until(() => posts(fn).length === 2);
  check('隱藏送的是 hide', JSON.stringify(posts(fn)[1]) === '{"action":"hide","acronym":"CSF"}');
  check('兩個待確認互不干擾（另一張卡沒被武裝）', buttons(w, cardOf(w, 'VMCAI'), '移除')[0]?.textContent === '移除');
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);
