#!/usr/bin/env node
/* Sync layer, driven against a stubbed Supabase.
   The live project cannot be exercised from here, so everything that does not
   need real credentials is pinned down instead: session handling, the read-only
   cache, the refusal to write while offline, and compare-and-set on a stale tab.
     npm run test:sync
*/
import { JSDOM } from 'jsdom';
import { fixturePage, pinClock } from './page.mjs';

const HTML = fixturePage();
/* boot() swaps CFG in for the literal `null`. Against a page built with a real
   config that swap matched nothing, and the suite quietly ran on the real one. */
if (!HTML.includes('window.__SYNC_CONFIG__ = null;')) throw new Error('fixture page should be built without a sync config');
const CFG = { url: 'https://stub.supabase.co', anonKey: 'anon-key' };

/** An in-memory stand-in for PostgREST + the save_submission RPC. */
function makeBackend(rows = []) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = [];
  let clock = 1000;
  const backend = {
    db, calls,
    expire: false,          // flip to make the next call return 401
    refreshOk: true,        // GoTrue accepts the refresh token
    refreshes: [],          // refresh tokens presented, in order
    dead: null,             // an access token PostgREST now rejects
    fetch: async (url, opts = {}) => {
      // no Edge Function in this project: conference management stays off here
      if (url.includes('/functions/v1/')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        backend.refreshes.push(JSON.parse(opts.body).refresh_token);
        return backend.refreshOk
          ? { ok: true, status: 200, json: async () => ({ access_token: 'tok2', refresh_token: 'r2', expires_in: 3600 }) }
          : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => 'invalid_grant' };
      }
      calls.push({ url, method: opts.method || 'GET', auth: opts.headers?.Authorization });
      if (backend.expire) return { ok: false, status: 401, text: async () => 'JWT expired' };
      if (backend.dead && opts.headers?.Authorization === `Bearer ${backend.dead}`) return { ok: false, status: 401, text: async () => 'JWT expired' };
      const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

      if (url.includes('/rpc/save_submission')) {
        const b = JSON.parse(opts.body);
        const cur = db.get(b.p_id);
        if (cur && b.p_expected !== cur.updated_at) {
          return { ok: false, status: 400, text: async () => '{"message":"stale_write"}' };
        }
        const row = { id: b.p_id, paper: b.p_paper, venue: b.p_venue, status: b.p_status,
                      history: b.p_history, notes: b.p_notes, updated_at: `t${++clock}` };
        db.set(b.p_id, row);
        return res(200, row);
      }
      if (opts.method === 'DELETE') {
        db.delete(decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]));
        return { ok: true, status: 204, json: async () => null, text: async () => '' };
      }
      return res(200, [...db.values()]);
    },
  };
  return backend;
}

function boot({ backend, signedIn = true, session = null, online = true, cache = null, legacy = null, hash = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/site/' + hash });
  const w = dom.window;
  pinClock(w);
  w.confirm = () => false;
  if (backend) w.fetch = backend.fetch;
  Object.defineProperty(w.navigator, 'onLine', { value: online, configurable: true });
  if (signedIn) w.localStorage.setItem('cc-session',
    JSON.stringify(session || { access_token: 'tok', expires_at: Math.floor(w.Date.now() / 1000) + 3600 }));
  if (cache) w.localStorage.setItem('cc-subs-cache', JSON.stringify(cache));
  if (legacy) w.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: legacy }));

  const script = HTML.match(/<script>([\s\S]*)<\/script>/)[1]
    .replace('window.__SYNC_CONFIG__ = null;', `window.__SYNC_CONFIG__ = ${JSON.stringify(CFG)};`);
  w.document.body.innerHTML = HTML.replace(/<script>[\s\S]*<\/script>/, '');
  w.eval(script + '\nglobalThis.__t = { SYNC, loadSubs, saveSubs, render, get pending() { return syncPending; } };');
  [...w.document.querySelectorAll('.tab')].find((t) => t.textContent.includes('我的投稿')).click();
  return { dom, w, T: w.__t };
}

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };
const txt = (w, sel) => (w.document.querySelector(sel)?.textContent || '').trim();
/* .card is also the add form; a submission card is the one carrying a title. */
const cardSelect = (w) => [...w.document.querySelectorAll('#main .card')]
  .find((c) => c.querySelector('h3'))?.querySelector('select');
const btn = (w, t) => [...w.document.querySelectorAll('#main button')].find((b) => b.textContent.includes(t));

console.log('=== 未登入 ===');
{
  const { dom, w } = boot({ backend: makeBackend(), signedIn: false });
  check('顯示登入按鈕', !!btn(w, '用 GitHub 登入'));
  check('狀態列標示未登入', txt(w, '.sync-bar .lbl') === '未登入', txt(w, '.sync-bar .lbl'));
  check('新增表單被停用（沒有可以寫入的帳號）',
        w.document.querySelector('#main .subform button').disabled === true);
  check('狀態列說明登入後會怎樣', /登入後.*帳號/.test(txt(w, '.sync-bar')), '');
  check('不謊稱資料只留在瀏覽器且永不上傳',
        /登入之後會存到你的帳號下/.test(w.document.querySelector('#main').textContent));
  dom.window.close();
}

console.log('\n=== 已登入、線上 ===');
{
  const be = makeBackend([{ id: 'r1', paper: '雲端那筆', venue: 'vmcai-2027', status: 'submitted', history: [], notes: '', updated_at: 't1' }]);
  const { dom, w, T } = boot({ backend: be });
  await T.pending;
  check('從資料庫拉到資料', T.loadSubs().length === 1 && T.loadSubs()[0].paper === '雲端那筆', T.loadSubs()[0]?.paper);
  check('狀態列標示已同步', txt(w, '.sync-bar .lbl') === '已同步', txt(w, '.sync-bar .lbl'));
  check('控制項可用', cardSelect(w).disabled === false);
  /* This line said "only in this browser, never uploaded" long after sync
     started uploading. Someone decides what to write down on the strength of
     it, so it has to track the actual state. */
  check('已登入時說明資料在帳號底下的資料庫',
        /存在你帳號底下的資料庫/.test(w.document.querySelector('#main').textContent) &&
        !/不會上傳/.test(w.document.querySelector('#main').textContent));

  // change status -> must reach the database, not just memory
  const sel = cardSelect(w);
  sel.value = 'accepted'; sel.onchange();
  await T.pending;
  check('改狀態寫進資料庫', be.db.get('r1').status === 'accepted', be.db.get('r1').status);
  check('寫入後重新拉取', T.loadSubs()[0].status === 'accepted');
  dom.window.close();
}

console.log('\n=== 離線:唯讀 ===');
{
  const cached = [{ id: 'r1', paper: '快取那筆', venue: 'vmcai-2027', status: 'submitted', history: [], notes: '', updated_at: 't1' }];
  const { dom, w, T } = boot({ backend: makeBackend(), online: false, cache: cached });
  await T.pending;
  check('離線仍看得到上次同步的內容', T.loadSubs().length === 1, T.loadSubs()[0]?.paper);
  check('狀態列標示離線', txt(w, '.sync-bar .lbl') === '離線', txt(w, '.sync-bar .lbl'));
  check('控制項全部停用', cardSelect(w).disabled === true);
  // even if something calls saveSubs directly, the write must be refused
  T.saveSubs([{ ...cached[0], status: 'accepted' }]);
  check('離線寫入被拒絕(分歧從結構上不會產生)', T.loadSubs()[0].status === 'submitted', T.loadSubs()[0].status);
  check('並且說明原因', /離線/.test(txt(w, '.sync-bar')), '');
  dom.window.close();
}

console.log('\n=== 過期分頁覆寫(CAS)===');
{
  const be = makeBackend([{ id: 'r1', paper: 'P', venue: 'vmcai-2027', status: 'submitted', history: [], notes: '', updated_at: 't1' }]);
  const { dom, w, T } = boot({ backend: be });
  await T.pending;
  // another device moves the row on
  be.db.set('r1', { ...be.db.get('r1'), status: 'accepted', updated_at: 't999' });
  const sel = cardSelect(w);
  sel.value = 'rejected'; sel.onchange();
  await T.pending;
  check('過期的寫入被擋下', be.db.get('r1').status === 'accepted', be.db.get('r1').status);
  check('畫面換成資料庫的現況', T.loadSubs()[0].status === 'accepted', T.loadSubs()[0].status);
  check('明確告知而不是默默吞掉', /別的裝置/.test(txt(w, '.sync-bar')), '');
  dom.window.close();
}

console.log('\n=== session 過期 ===');
{
  const be = makeBackend();
  be.expire = true;
  const { dom, w, T } = boot({ backend: be });
  await T.pending;
  check('401 之後回到未登入', w.__t.SYNC.status() === 'signed-out', w.__t.SYNC.status());
  dom.window.close();
}

console.log('\n=== 登入不會一小時就失效 ===');
{
  /* The access token lasts an hour. This page used to treat the first expired
     one as signed out, so a visit the next day found you logged out - and on
     依會議 the management card was simply missing. */
  const be = makeBackend([{ id: 'r1', paper: 'P', venue: 'vmcai-2027', status: 'submitted', history: [], notes: '', updated_at: 't1' }]);
  const past = Math.floor(Date.parse('2026-09-20T00:00:00Z') / 1000);
  const { dom, w, T } = boot({ backend: be, session: { access_token: 'tok', refresh_token: 'r1', expires_at: past } });
  await T.pending;
  check('過期的 access token 用 refresh token 續期，仍是已同步', txt(w, '.sync-bar .lbl') === '已同步' && T.loadSubs().length === 1, txt(w, '.sync-bar .lbl'));
  check('之後的請求帶的是新 token', be.calls.length > 0 && be.calls.every((c) => c.auth === 'Bearer tok2'), be.calls.map((c) => c.auth).join());
  const s = JSON.parse(w.localStorage.getItem('cc-session'));
  check('新的 refresh token 存下來（舊的只能用一次）', s.access_token === 'tok2' && s.refresh_token === 'r2');
  check('兩個請求同時要 token，只續期一次', be.refreshes.length === 1, be.refreshes.join());
  dom.window.close();
}
{
  const be = makeBackend();
  be.refreshOk = false;
  const past = Math.floor(Date.parse('2026-09-20T00:00:00Z') / 1000);
  const { dom, w, T } = boot({ backend: be, session: { access_token: 'tok', refresh_token: 'r1', expires_at: past } });
  await T.pending;
  check('refresh token 被撤銷：回到未登入', txt(w, '.sync-bar .lbl') === '未登入' && !w.localStorage.getItem('cc-session'), txt(w, '.sync-bar .lbl'));
  dom.window.close();
}
{
  // a token can die before its stated expiry (signed out elsewhere, key rotated)
  const be = makeBackend([{ id: 'r1', paper: 'P', venue: 'vmcai-2027', status: 'submitted', history: [], notes: '', updated_at: 't1' }]);
  be.dead = 'tok';
  const future = Math.floor(Date.parse('2026-09-24T12:00:00Z') / 1000) + 3600;
  const { dom, w, T } = boot({ backend: be, session: { access_token: 'tok', refresh_token: 'r1', expires_at: future } });
  await T.pending;
  check('提前失效的 token：續期一次、重試成功', T.loadSubs().length === 1 && be.refreshes.length === 1 && txt(w, '.sync-bar .lbl') === '已同步',
        `${be.refreshes.length} 次續期`);
  dom.window.close();
}

console.log('\n=== 登入導回:token 不留在網址列 ===');
{
  const { dom, w } = boot({ backend: makeBackend(), signedIn: false,
    hash: '#access_token=abc&refresh_token=r&expires_in=3600' });
  check('token 收進 session', !!JSON.parse(w.localStorage.getItem('cc-session') || 'null')?.access_token);
  check('網址列的 fragment 已清掉', !w.location.hash.includes('access_token'), w.location.hash || '(空)');
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);
