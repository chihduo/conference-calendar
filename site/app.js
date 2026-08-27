const DATA = "__DATA__";
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const AREAS = ['FM', 'PL', 'AI', 'SE', 'LOGIC', 'SEC'];
const RANKS = ['A*', 'A', 'B', 'C'];
const rankCls = (v) => 'rank r-' + (v === 'A*' ? 'astar' : (v || 'unranked').toLowerCase().replace(/\W+/g, ''));

const state = {
  view: 'deadlines',
  areas: new Set(), ranks: new Set(), q: '',
  showPast: false, showEstimated: true, onlyMine: false,
};

/* ---------- flatten ---------- */
/* Editions with status "past" are estimation bases, not agenda items: they stay
   out of the timeline but remain visible on the conference cards. */
function events() {
  const out = [];
  for (const c of DATA.conferences)
    for (const e of c.editions) {
      if (e.status === 'past') continue;
      for (const m of e.milestones) if (m.iso) out.push({ c, e, m, t: new Date(m.iso) });
    }
  return out.sort((a, b) => a.t - b.t);
}

/* Bridge between the two layers. The timeline renders public conference facts;
   this is the only place personal state reaches into it. */
function submissionsByVenue() {
  const map = new Map();
  for (const s of loadSubs()) {
    if (!map.has(s.venue)) map.set(s.venue, []);
    map.get(s.venue).push(s);
  }
  return map;
}

/* The ONE milestone each tracked paper is next waiting on.
   Marking every milestone the current status waits for reversed three rows at
   once for a submitted TACAS paper (rebuttal opens, rebuttal ends,
   notification), which is a set, not an answer to "where am I". pending() is
   already relevant-and-future sorted soonest-first, so its head is the answer -
   and using it guarantees the timeline marks exactly what tops 我的投稿. */
function nextMilestoneFor(now) {
  const out = new Map();                 // submission id -> milestone kind
  for (const s of loadSubs()) {
    const p = pending(s, now);
    if (p.length) out.set(s.id, p[0].m.kind);
  }
  return out;
}

function passesFilter(c) {
  if (state.areas.size && !c.areas.some((a) => state.areas.has(a))) return false;
  if (state.ranks.size && !state.ranks.has(c.rank?.value)) return false;
  if (state.q) {
    const hay = `${c.name} ${c.full_name} ${c.areas.join(' ')}`.toLowerCase();
    if (!hay.includes(state.q.toLowerCase())) return false;
  }
  return true;
}

/* ---------- formatting ---------- */
const WD = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDate(m) {
  const d = new Date(m.date + 'T12:00:00Z');
  return `${m.date} <b>${WD[d.getUTCDay()]}</b>`;
}
/* Calendar-day difference in the VIEWER's timezone, not a count of elapsed
   24-hour periods. The duration form ticked over at whatever clock time the
   deadline instant happened to fall on locally - VMCAI's AoE deadline made the
   number drop at 7:59pm in Taipei - which nobody expects. Comparing local
   midnights instead makes it change at local midnight, everywhere.
   Math.round absorbs the 23- or 25-hour day at a DST transition. */
const localMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysUntilLocal = (t, now) => Math.round((localMidnight(t) - localMidnight(now)) / 86400000);

function countdown(t, now) {
  const days = daysUntilLocal(t, now);
  const ms = t - now;

  if (days < 0) return { txt: `${-days} 天前`, cls: '', days };
  if (days === 0) {
    /* On the final day a bare "today" is not actionable - two hours and twenty
       hours are different situations - so this is the one place an hour count
       earns its keep. */
    if (ms <= 0) return { txt: '今天稍早', cls: '', days };
    const hrs = Math.floor(ms / 3600000);
    if (hrs < 1) return { txt: `剩 ${Math.max(1, Math.floor(ms / 60000))} 分`, cls: 'cd urgent', days };
    return { txt: `今天 · 剩 ${hrs} 小時`, cls: 'cd urgent', days };
  }
  if (days === 1) return { txt: '明天', cls: 'cd urgent', days };
  if (days <= 14) return { txt: `${days} 天`, cls: 'cd near', days };
  return { txt: `${days} 天`, cls: 'cd', days };
}

const MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];
/* Group by the date the CFP states, not by the UTC instant: an AoE deadline on
   the 30th converts to the 1st of the next month in UTC, which would file it
   under a heading that contradicts the date printed on the row. */
const monthKeyOf = (m) => `${m.date.slice(0, 4)} 年 ${MONTHS[Number(m.date.slice(5, 7)) - 1]}`;

/* The viewer's own clock, for the "when is that for me" tooltip. */
const VIEWER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'local'; } })();
const localOf = (iso) => {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return new Date(iso).toString(); }
};
/* Local calendar date, for recording when YOU did something. toISOString would
   give the UTC date, which is yesterday for anyone east of Greenwich at night. */
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function badges(c) {
  const f = document.createDocumentFragment();
  const r = el('span', rankCls(c.rank?.value), c.rank?.value || '—');
  r.title = c.rank?.source || 'unranked';
  f.appendChild(r);
  for (const a of c.areas) f.appendChild(el('span', 'area', a));
  return f;
}

/* ---------- views ---------- */
function renderDeadlines(root, now) {
  const subs = submissionsByVenue();
  if (!subs.size) state.onlyMine = false;   // the toggle is hidden with nothing tracked
  const nextFor = nextMilestoneFor(now);
  const all = events()
    .filter((x) => passesFilter(x.c))
    .filter((x) => !state.onlyMine || subs.has(x.e.id));
  const shown = all.filter((x) => {
    if (!state.showPast && x.t < now) return false;
    if (!state.showEstimated && x.m.confidence === 'estimated') return false;
    return true;
  });
  const pastCount = all.filter((x) => x.t < now).length;

  if (pastCount && !state.showPast) {
    const n = el('div', 'notice');
    n.innerHTML = `<b>${pastCount}</b> 個截稿日已經過去 — 2027 年 1–2 月的會議（POPL、CSL、AAAI…）在 2026 年年中就截稿了。`;
    const b = el('button', 'chip', '顯示已過期');
    b.style.marginLeft = '8px';
    b.onclick = () => { state.showPast = true; render(); };
    n.appendChild(b);
    root.appendChild(n);
  }

  root.appendChild(Object.assign(el('div', 'count'), { textContent: `${shown.length} 個里程碑` }));
  if (!shown.length) { root.appendChild(el('div', 'empty', '沒有符合條件的截稿日。')); return; }

  let lastMonth = null;
  for (const { c, e, m, t } of shown) {
    const mk = monthKeyOf(m);
    if (mk !== lastMonth) { root.appendChild(el('div', 'month', mk)); lastMonth = mk; }

    const isPast = t < now;              // "past" stays absolute: 2 hours ago is past
    const cd = countdown(t, now);
    const days = cd.days;
    const sev = isPast ? ' past' : days <= 1 ? ' urgent' : days <= 14 ? ' soon' : '';
    /* Two independent channels: the left stripe carries urgency, the background
       carries ownership. Overloading one would make them unreadable together. */
    const mine = subs.get(e.id) || [];

    /* A notification or rebuttal date only means something if you might be in
       it. Once the call has closed and you are not tracking a paper here, the
       row is someone else's schedule - greyed rather than hidden, because
       knowing when a venue announces is still worth a glance. Rows for a venue
       still accepting submissions stay bright: you could yet be in it. */
    const moot = !isPast && !mine.length && !callOpen(e, now) && !CALL_KINDS.has(baseKind(m.kind));

    const row = el('div', 'row' + sev + (mine.length ? ' mine' : '') + (moot ? ' moot' : ''));
    if (moot) row.title = '投稿已截止，而你沒有追蹤這個會議的論文';

    const dt = el('div', 'dt');
    dt.innerHTML = fmtDate(m);
    dt.title = `${m.date} ${m.time} ${m.tz}\n你的時間（${VIEWER_TZ}）：${localOf(m.iso)}`;
    row.appendChild(dt);
    row.appendChild(Object.assign(el('div', cd.cls || 'cd'), { textContent: cd.txt }));

    const what = el('div', 'what');
    const name = el('span', 'cname');
    if (e.link) { const a = el('a', null, `${c.name} ${e.year}`); a.href = e.link; a.target = '_blank'; a.rel = 'noopener'; name.appendChild(a); }
    else name.textContent = `${c.name} ${e.year}`;
    what.appendChild(name);
    what.appendChild(el('span', 'mkind', m.label));
    if (m.confidence === 'estimated') {
      /* An estimate far out is fine; one about to arrive unconfirmed is a risk,
         so it says so rather than looking like any other date. */
      const soonish = days <= 90;
      const est = el('span', 'est-mark' + (soonish ? ' est-warn' : ''), soonish ? '推估・未確認' : '推估');
      est.title = `由 ${m.derived_from} 推算（+364 天，保留星期幾）` +
        (soonish ? '\n這個日期快到了但還沒經官方確認，投稿前請查 CFP。' : '');
      what.appendChild(est);
    }
    if (m.note) { const nt = el('span', 'mkind', `· ${m.note}`); what.appendChild(nt); }

    for (const sub of mine) {
      const live = !isPast && nextFor.get(sub.id) === m.kind;
      const chip = el('span', 'mine-chip' + (live ? ' live' : ''));
      chip.textContent = `${live ? '▸ ' : ''}${sub.paper}`;
      // Only what the chip cannot show: the title is truncated and the status is absent.
      chip.title = `${sub.paper}\n狀態：${statusLabel(sub.status)}`;
      what.appendChild(chip);
    }
    row.appendChild(what);

    const meta = el('div', 'meta');
    const dot = el('span', 'conf-dot conf-' + m.confidence);
    dot.title = `信心：${m.confidence}｜時區 ${m.tz}`;
    meta.appendChild(dot);
    meta.appendChild(badges(c));
    row.appendChild(meta);
    root.appendChild(row);
  }
}

function renderConferences(root, now) {
  const list = DATA.conferences.filter(passesFilter);
  root.appendChild(Object.assign(el('div', 'count'), { textContent: `${list.length} 個會議` }));
  if (!list.length) { root.appendChild(el('div', 'empty', '沒有符合條件的會議。')); return; }

  for (const c of list) {
    const card = el('div', 'card');
    const h = el('h3');
    h.appendChild(el('span', null, c.name));
    h.appendChild(badges(c));
    card.appendChild(h);
    if (c.full_name) card.appendChild(el('div', 'fname', c.full_name));
    if (c.note) card.appendChild(el('div', 'note', c.note));

    for (const e of c.editions) {
      const ed = el('div', 'ed');
      const head = el('div', 'ed-head');
      head.appendChild(el('span', 'ed-year', String(e.year)));
      head.appendChild(el('span', 'status s-' + e.status, e.status));
      if (e.dates) head.appendChild(el('span', 'mkind', e.dates));
      if (e.place) head.appendChild(el('span', 'mkind', e.place));
      if (e.link) { const a = el('a', null, '網站'); a.href = e.link; a.target = '_blank'; a.rel = 'noopener';
        a.style.cssText = 'font-size:12px;color:var(--accent);text-decoration:none'; head.appendChild(a); }
      ed.appendChild(head);

      const tb = el('table', 'ms-table');
      for (const m of e.milestones) {
        const tr = el('tr', m.iso ? '' : 'tbd');
        const td1 = el('td'); 
        td1.appendChild(el('span', 'conf-dot conf-' + m.confidence));
        td1.appendChild(document.createTextNode(' ' + m.label));
        tr.appendChild(td1);
        const td2 = el('td', null, m.date ? `${m.date}` : '待公布');
        tr.appendChild(td2);
        const td3 = el('td', 'mkind');
        const bits = [];
        if (m.iso) { const cdv = countdown(new Date(m.iso), now); bits.push(cdv.txt); }
        if (m.confidence === 'estimated') bits.push(`推估自 ${m.derived_from}`);
        else if (m.confidence === 'announced') bits.push('社群來源');
        if (m.note) bits.push(m.note);
        td3.textContent = bits.join('　·　');
        tr.appendChild(td3);
        tb.appendChild(tr);
      }
      const tw = el('div', 'ms-wrap'); tw.appendChild(tb); ed.appendChild(tw);
      if (e.note) ed.appendChild(el('div', 'note', e.note));
      card.appendChild(ed);
    }
    root.appendChild(card);
  }
}

/* Anything the fetcher refused to write shows up here rather than dying in a
   log file: a guard that silently drops data is indistinguishable from a bug. */
function renderReviewQueue(root) {
  const items = (DATA.review_queue || []).filter((r) => r.severity === 'action');
  if (!items.length) return;
  const box = el('div', 'notice');
  const head = el('div');
  head.appendChild(el('span', 'lbl', `${items.length} 筆自動抓取待確認`));
  head.appendChild(el('span', 'count', '看過之後用 npm run ack 確認，就不會再提示'));
  box.appendChild(head);
  const more = el('button', 'chip', '展開');
  const list = el('div');
  list.style.display = 'none';
  for (const r of items) {
    const line = el('div', 'count');
    line.style.margin = '4px 0 0';
    line.textContent = `[${r.reason}] ${r.conference}${r.edition ? '/' + r.edition : ''} — ${r.detail}`;
    list.appendChild(line);
  }
  more.onclick = () => {
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : 'block';
    more.textContent = open ? '展開' : '收合';
  };
  head.appendChild(more);
  box.appendChild(list);
  root.appendChild(box);
}

function renderSubscribe(root) {
  root.appendChild(Object.assign(el('h2', 'sec'), { textContent: '訂閱行事曆' }));
  const p = el('div', 'count', '把 .ics 網址加進 Google / Apple Calendar 的「訂閱」功能，之後自動同步。所有時間已換算成 UTC，AoE 截稿日不會差一天。');
  root.appendChild(p);
  const box = el('div', 'subs');
  for (const [f, label] of [['all.ics', '全部'], ['fm.ics', 'FM'], ['pl.ics', 'PL'], ['ai.ics', 'AI'],
                            ['se.ics', 'SE'], ['logic.ics', 'Logic'], ['sec.ics', 'Security'],
                            ['rank-a.ics', '只要 A*/A']]) {
    const a = el('a', null, label);
    a.href = DATA.feeds?.[f] || f; a.download = f;
    a.title = `下載 ${f}（部署後也可用 ./${f} 這個網址訂閱）`;
    box.appendChild(a);
  }
  root.appendChild(box);
}

/* ---------- summary strip ---------- */
/* Two facts, because they are usually different events: the very next thing on
   the calendar, and the next deadline you actually have to write towards. */
const SUBMIT_KINDS = new Set(['abstract', 'submission']);

function renderNextUp(root, now) {
  const upcoming = events().filter((x) => passesFilter(x.c) && x.t > now);
  if (!upcoming.length) return;
  const next = upcoming[0];
  const nextSubmit = upcoming.find((x) => SUBMIT_KINDS.has(x.m.kind));

  const line = (label, ev) => {
    const box = el('div', 'nextup');
    box.appendChild(el('span', 'lbl', label));
    box.appendChild(el('span', 'big', `${ev.c.name} ${ev.e.year} — ${ev.m.label}`));
    box.appendChild(Object.assign(el('span', 'dt'), { textContent: ev.m.date }));
    const cd = countdown(ev.t, now);
    box.appendChild(Object.assign(el('span', cd.cls || 'cd'), { textContent: cd.txt }));
    if (ev.m.confidence === 'estimated') box.appendChild(el('span', 'est-mark', '推估'));
    return box;
  };

  root.appendChild(line('下一個里程碑', next));
  if (nextSubmit && nextSubmit !== next) root.appendChild(line('下一個投稿截止', nextSubmit));
}


/* ---------- personal layer ----------
   Never leaves the browser: the repo is public, and which papers you have under
   review (or had rejected) is not something a public git history should carry.
   Export/import moves it between machines. */
const SUB_KEY = 'cc-submissions';
const STATUSES = [
  ['planned',          '打算投'],
  ['submitted',        '已投稿'],
  ['under_review',     '審稿中'],
  ['rebuttal',         'Rebuttal'],
  ['accepted',         '已錄取'],
  ['camera_ready_done','已交 camera-ready'],
  ['registered',       '已註冊'],
  ['rejected',         '被拒'],
  ['withdrawn',        '已撤回'],
];
const statusLabel = (s) => (STATUSES.find((x) => x[0] === s) || [s, s])[1];

/* Which of the venue's milestones matter to you depends on where the paper is.
   This is the whole point of the two layers: the dates already exist on the
   conference, the status decides which ones surface. */
const RELEVANT = {
  planned:           ['abstract', 'submission'],
  submitted:         ['rebuttal_start', 'rebuttal_end', 'notification', 'final_notification'],
  under_review:      ['rebuttal_start', 'rebuttal_end', 'notification', 'final_notification'],
  rebuttal:          ['rebuttal_end', 'notification', 'final_notification'],
  accepted:          ['revision', 'camera_ready', 'early_registration', 'registration'],
  camera_ready_done: ['early_registration', 'registration'],
  registered:        [],
  rejected:          [],
  withdrawn:         [],
};

/* Rendering is synchronous, so the database cannot be read inline. Memory is
   the render source; sync runs behind it and re-renders when it lands. */
let subsMem = [];
let syncBusy = false;
let syncNote = null;

const localLoad = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(SUB_KEY) || '{}');
    return Array.isArray(raw.submissions) ? raw.submissions : [];
  } catch { return []; }
};
const localSave = (list) => localStorage.setItem(SUB_KEY, JSON.stringify({ schema: 1, submissions: list }));

/* Hand back a copy. Callers mutate what they get and pass it to saveSubs, a
   habit from when this read localStorage fresh each time; returning the live
   array made prev and next the same objects, so the diff found no change and
   silently issued no write at all. */
function loadSubs() { return subsMem.map((s) => ({ ...s, history: [...(s.history || [])] })); }

function saveSubs(list) {
  if (SYNC.status() === 'off') { subsMem = list; localSave(list); return; }
  if (SYNC.status() !== 'live') {
    // Refusing the write is the whole point: a local edit made offline is
    // exactly the divergence this design exists to prevent.
    syncNote = { kind: 'error', text: '目前離線，無法修改。連上網路後再試。' };
    render();
    return;
  }
  const prev = subsMem;
  subsMem = list;
  pushChanges(prev, list);
}

const sameRecord = (a, b) => ['paper', 'venue', 'status', 'notes'].every((k) => a[k] === b[k])
  && JSON.stringify(a.history || []) === JSON.stringify(b.history || []);

let syncPending = Promise.resolve();
async function pushChanges(prev, next) {
  syncPending = (async () => {
  syncBusy = true; syncNote = null; render();
  try {
    const before = new Map(prev.map((s) => [s.id, s]));
    for (const s of next) {
      const old = before.get(s.id);
      if (!old || !sameRecord(old, s)) await SYNC.save({ ...s, updated_at: old?.updated_at ?? s.updated_at });
      before.delete(s.id);
    }
    for (const gone of before.values()) await SYNC.remove(gone.id);
    subsMem = await SYNC.pull();
  } catch (e) {
    syncNote = e.stale
      ? { kind: 'error', text: '這筆在別的裝置上已經改過了，畫面已重新載入，請確認後再改一次。' }
      : { kind: 'error', text: '同步失敗：' + e.message };
    try { subsMem = await SYNC.pull(); } catch { subsMem = prev; }
  }
  syncBusy = false;
  render();
  })();
  return syncPending;
}

async function initSync() {
  syncPending = (async () => {
  SYNC.init();
  if (SYNC.status() === 'off') { subsMem = localLoad(); return; }
  subsMem = SYNC.readCache();          // instant, possibly stale, never written back
  render();
  if (SYNC.status() === 'live') {
    try { subsMem = await SYNC.pull(); }
    catch (e) { syncNote = { kind: 'error', text: '讀取失敗，顯示的是上次同步的內容：' + e.message }; }
    render();
  }
  })();
  return syncPending;
}
function editionsIndex() {
  const idx = new Map();
  for (const c of DATA.conferences) for (const e of c.editions) idx.set(e.id, { c, e });
  return idx;
}

/* Rolling-deadline venues express rounds as `<kind>_cycleN`; the relevance map
   is written in base kinds so it does not need a row per cycle. */
const baseKind = (k) => /^(.+)_cycle\d+$/.exec(k)?.[1] ?? k;

/** Milestones that matter for this submission right now, soonest first.
    Only the nearest future one of each kind: with three cycles running, every
    remaining round's notification would otherwise pile up as "your" next date. */
function pending(sub, now) {
  const hit = editionsIndex().get(sub.venue);
  if (!hit) return [];
  const kinds = RELEVANT[sub.status] || [];
  const future = hit.e.milestones
    .filter((m) => kinds.includes(baseKind(m.kind)) && m.iso)
    .map((m) => ({ ...hit, m, t: new Date(m.iso) }))
    .filter((x) => x.t > now)
    .sort((a, b) => a.t - b.t);
  const seen = new Set();
  return future.filter((x) => !seen.has(baseKind(x.m.kind)) && seen.add(baseKind(x.m.kind)));
}

/* Kinds that mean "the call is open". */
const CALL_KINDS = new Set(['abstract', 'submission']);

/* pending() coming back empty has three different causes and they need three
   different sentences. Telling someone POPL 2027 "has not published its dates"
   is simply false - they are published, confirmed, and gone. */
function pendingReason(sub, now) {
  const hit = editionsIndex().get(sub.venue);
  if (!hit) return { kind: 'unknown-venue' };
  const kinds = RELEVANT[sub.status] || [];
  if (!kinds.length) return { kind: 'done' };
  const dated = hit.e.milestones
    .filter((m) => kinds.includes(baseKind(m.kind)) && m.iso)
    .sort((a, b) => new Date(b.iso) - new Date(a.iso));
  if (!dated.length) return { kind: 'unpublished' };
  if (new Date(dated[0].iso) <= now) return { kind: 'passed', last: dated[0] };
  return { kind: 'none' };
}

/** Is this edition still accepting submissions? */
const callOpen = (ed, now) =>
  ed.milestones.some((m) => m.iso && CALL_KINDS.has(baseKind(m.kind)) && new Date(m.iso) > now);

/** The nearest edition of the same conference whose call is still open. */
function nextOpenEdition(confId, now) {
  const conf = DATA.conferences.find((c) => c.id === confId);
  return conf?.editions.filter((e) => e.status !== 'past' && callOpen(e, now))
    .sort((a, b) => a.year - b.year)[0] || null;
}

function renderSyncBar(root) {
  const st = SYNC.status();
  if (st === 'off') return true;            // not configured: behave exactly as before

  const bar = el('div', 'notice sync-bar');
  const lbl = el('span', 'lbl');
  if (syncBusy) lbl.textContent = '同步中…';
  else lbl.textContent = { 'signed-out': '未登入', live: '已同步', offline: '離線' }[st];
  bar.appendChild(lbl);

  if (st === 'signed-out') {
    bar.appendChild(el('span', 'count', '登入後投稿紀錄會存在你的帳號下，換裝置自動跟著走。'));
    const b = el('button', 'chip on', '用 GitHub 登入');
    b.onclick = () => SYNC.signIn();
    bar.appendChild(b);
    const local = localLoad();
    if (local.length) bar.appendChild(el('span', 'count', `（本機還有 ${local.length} 筆舊紀錄，登入後可以上傳）`));
  } else if (st === 'offline') {
    bar.appendChild(el('span', 'count', '顯示的是上次同步的內容，唯讀。連上網路才能修改。'));
  } else {
    const out = el('button', 'chip', '登出');
    out.onclick = () => { SYNC.signOut(); subsMem = SYNC.readCache(); render(); };
    bar.appendChild(out);
    const local = localLoad();
    if (local.length) {
      const up = el('button', 'chip on', `上傳本機的 ${local.length} 筆`);
      up.onclick = () => { const merged = [...subsMem]; const have = new Set(merged.map((x) => x.id));
        for (const r of local) if (!have.has(r.id)) merged.push(r);
        localStorage.removeItem(SUB_KEY); saveSubs(merged); };
      bar.appendChild(up);
    }
  }
  if (syncNote) {
    const n = el('div', 'count');
    n.style.color = 'var(--rust)';
    n.style.width = '100%';
    n.textContent = syncNote.text;
    bar.appendChild(n);
  }
  root.appendChild(bar);
  return st === 'live';
}

function renderSubmissions(root, now) {
  const writable = renderSyncBar(root);
  const subs = loadSubs();
  const idx = editionsIndex();

  /* add form */
  const form = el('form', 'card subform');
  const title = el('input'); title.type = 'text'; title.placeholder = '論文標題'; title.required = true;
  title.className = 'f-grow';
  const venue = el('select');
  venue.appendChild(Object.assign(el('option'), { value: '', textContent: '選擇會議…' }));
  [...idx.entries()]
    .filter(([, v]) => v.e.status !== 'past')
    .sort((a, b) => (a[1].c.name + a[1].e.year).localeCompare(b[1].c.name + b[1].e.year))
    .forEach(([id, v]) => venue.appendChild(Object.assign(el('option'), {
      value: id,
      textContent: `${v.c.name} ${v.e.year}` +
        (!callOpen(v.e, now) ? '（投稿已截止）' : v.e.status === 'estimated' ? '（推估）' : ''),
    })));
  const st = el('select');
  STATUSES.forEach(([v, l]) => st.appendChild(Object.assign(el('option'), { value: v, textContent: l })));
  st.value = 'planned';
  const add = el('button', 'chip on', '新增');
  add.type = 'submit';
  if (!writable) { add.disabled = true; title.disabled = true; venue.disabled = true; st.disabled = true; }
  form.append(title, venue, st, add);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    if (!title.value.trim() || !venue.value) return;
    const list = loadSubs();
    list.push({
      id: 'p' + Date.now().toString(36), paper: title.value.trim(), venue: venue.value,
      status: st.value, history: [{ status: st.value, on: todayLocal() }], notes: '',
    });
    saveSubs(list); render();
  };
  root.appendChild(form);

  if (!subs.length) {
    root.appendChild(el('div', 'empty',
      '還沒有投稿紀錄。新增一筆之後，這裡只會顯示對你有意義的日期 — 投稿後看 notification，錄取後看 camera-ready 和註冊。'));
  }

  /* one card per paper, ordered by how soon the next thing is due */
  const decorated = subs.map((s) => ({ s, p: pending(s, now) }))
    .sort((a, b) => (a.p[0]?.t ?? Infinity) - (b.p[0]?.t ?? Infinity));

  for (const { s, p } of decorated) {
    const hit = idx.get(s.venue);
    const card = el('div', 'card');
    const h = el('h3');
    const titleText = el('span', null, s.paper);
    h.appendChild(titleText);
    card.appendChild(h);

    /* Edited in place rather than through prompt(): a modal call is ignored
       outright in the sandboxed iframe the published page runs in, exactly as
       confirm() was. Nothing here calls render() until the edit settles, or the
       rebuild would wipe the field mid-typing. */
    const beginEdit = () => {
      const input = el('input');
      input.type = 'text';
      input.className = 'title-edit';
      input.value = s.paper;
      const save = el('button', 'chip on', '儲存');
      const cancel = el('button', 'chip', '取消');
      const abort = () => h.replaceChildren(titleText);
      const commit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }   // a card with no title cannot be told apart
        if (v === s.paper) return abort();
        const list = loadSubs();
        list.find((x) => x.id === s.id).paper = v;
        saveSubs(list);
        render();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); abort(); }
      };
      save.onclick = commit;
      cancel.onclick = abort;
      h.replaceChildren(input, save, cancel);
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not focusable in tests */ }
    };

    const line = el('div', 'ed-head');
    line.appendChild(el('span', 'mkind', hit ? `${hit.c.name} ${hit.e.year}` : s.venue));
    if (hit) line.appendChild(el('span', rankCls(hit.c.rank?.value), hit.c.rank?.value || '—'));
    const sel = el('select');
    STATUSES.forEach(([v, l]) => sel.appendChild(Object.assign(el('option'), { value: v, textContent: l })));
    sel.value = s.status;
    sel.disabled = !writable;
    sel.onchange = () => {
      const list = loadSubs(); const t = list.find((x) => x.id === s.id);
      t.status = sel.value;
      (t.history ||= []).push({ status: sel.value, on: todayLocal() });
      saveSubs(list); render();
    };
    line.appendChild(sel);
    const edit = el('button', 'chip', '改標題');
    edit.title = '投出去之前標題常常還會動';
    edit.disabled = !writable;
    edit.onclick = beginEdit;
    line.appendChild(edit);
    /* Confirm inline instead of through window.confirm: the published page runs
       in a sandboxed iframe, where a modal call is ignored and returns false -
       so the button did nothing at all, with no dialog and no error. A two-step
       button needs no modal API and behaves the same from file://. */
    const del = el('button', 'chip', '刪除');
    del.disabled = !writable;
    let armed = false, armTimer = null;
    const disarm = () => { armed = false; del.textContent = '刪除'; del.className = 'chip'; };
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = '再按一次確認';
        del.className = 'chip danger';
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(armTimer);
      saveSubs(loadSubs().filter((x) => x.id !== s.id));
      render();
    };
    line.appendChild(del);
    card.appendChild(line);

    if (!p.length) {
      const r = pendingReason(s, now);
      const note = el('div', 'note');
      if (r.kind === 'done') {
        note.textContent = s.status === 'registered' ? '都辦完了，等著去開會。' : '沒有待辦日期。';
      } else if (r.kind === 'passed') {
        note.textContent = `${r.last.label} 已於 ${r.last.date} 截止。`;
        const nxt = hit && nextOpenEdition(hit.c.id, now);
        if (nxt) {
          const call = nxt.milestones
            .filter((m) => m.iso && CALL_KINDS.has(baseKind(m.kind)) && new Date(m.iso) > now)
            .sort((a, b) => new Date(a.iso) - new Date(b.iso))[0];
          const b = el('button', 'chip', `改投 ${hit.c.name} ${nxt.year}`);
          b.title = `${call.label} ${call.date}${call.confidence === 'estimated' ? '（推估）' : ''}`;
          b.onclick = () => {
            const list = loadSubs();
            const t = list.find((x) => x.id === s.id);
            t.venue = nxt.id;
            (t.history ||= []).push({ status: t.status, on: todayLocal(), note: `venue -> ${nxt.id}` });
            saveSubs(list); render();
          };
          note.appendChild(document.createTextNode(' '));
          note.appendChild(b);
        }
      } else {
        note.textContent = '這個會議還沒公布相關日期。';
      }
      card.appendChild(note);
    } else {
      const tb = el('table', 'ms-table');
      for (const x of p) {
        const tr = el('tr');
        const td1 = el('td');
        td1.appendChild(el('span', 'conf-dot conf-' + x.m.confidence));
        td1.appendChild(document.createTextNode(' ' + x.m.label));
        tr.appendChild(td1);
        tr.appendChild(el('td', null, x.m.date));
        const cd = countdown(x.t, now);
        const td3 = el('td', cd.cls || 'cd');
        td3.style.textAlign = 'left';
        td3.textContent = cd.txt + (x.m.confidence === 'estimated' ? '（推估）' : '');
        tr.appendChild(td3);
        tb.appendChild(tr);
      }
      const tw = el('div', 'ms-wrap'); tw.appendChild(tb); card.appendChild(tw);
    }
    root.appendChild(card);
  }

  /* backup + personal feed */
  root.appendChild(Object.assign(el('h2', 'sec'), { textContent: '備份與匯出' }));
  /* Where the records actually live depends on whether sync is on, and saying
     "only in this browser, never uploaded" once sync is configured is simply
     false - and false in the direction that matters, since someone may be
     deciding what to write down on the strength of it. */
  const WHERE = {
    off: '這些紀錄只存在這個瀏覽器裡，不會上傳，也不在 repo 中。換裝置或清快取前請先匯出。',
    'signed-out': '目前未登入，這些紀錄只存在這個瀏覽器裡。登入之後會存到你的帳號下，並在裝置之間同步。',
    live: '這些紀錄存在你帳號底下的資料庫，裝置之間會同步；不會進入這個公開 repo。匯出是為了留一份離線備份。',
    offline: '目前離線，顯示的是上次同步的內容。這些紀錄存在你帳號底下的資料庫，不會進入這個公開 repo。',
  };
  root.appendChild(el('div', 'count', WHERE[SYNC.status()] || WHERE.off));
  const box = el('div', 'subs');

  const exp = el('a', null, '匯出 JSON');
  exp.href = 'data:application/json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify({ schema: 1, submissions: loadSubs() }, null, 2));
  exp.download = 'my-submissions.json';
  box.appendChild(exp);

  const status = el('div', 'count');
  status.style.margin = '6px 0 0';

  const impLabel = el('label', null, '匯入 JSON');
  impLabel.style.cssText = 'font:500 12px var(--ui);color:var(--petrol);border:1px solid var(--line);border-radius:3px;padding:4px 10px;background:var(--surface);cursor:pointer';
  const imp = el('input'); imp.type = 'file'; imp.accept = 'application/json'; imp.style.display = 'none';
  imp.onchange = async () => {
    const f = imp.files?.[0]; if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (!Array.isArray(parsed.submissions)) throw new Error('缺少 submissions 陣列');
      const byId = new Map(loadSubs().map((x) => [x.id, x]));
      for (const s of parsed.submissions) byId.set(s.id, s);
      saveSubs([...byId.values()]);
      render();
    } catch (e) {
      // alert() is blocked in the sandboxed iframe too; report in the page.
      status.textContent = `匯入失敗：${e.message}`;
      status.style.color = 'var(--rust)';
    }
  };
  impLabel.appendChild(imp);
  box.appendChild(impLabel);

  const ics = el('a', null, '下載我的 .ics');
  ics.href = personalICS(subs, idx);
  ics.download = 'my-deadlines.ics';
  box.appendChild(ics);
  root.appendChild(box);
  root.appendChild(status);
}

/* Built in the browser rather than at build time, because the source data
   never reaches the build. */
function personalICS(subs, idx) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const z = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}T${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//conference-calendar//personal//EN',
             'CALSCALE:GREGORIAN', 'X-WR-CALNAME:My submissions'];
  const now = new Date();
  for (const s of subs) {
    const hit = idx.get(s.venue); if (!hit) continue;
    for (const m of hit.e.milestones) {
      if (!m.iso || !(RELEVANT[s.status] || []).includes(baseKind(m.kind))) continue;
      const end = new Date(m.iso), start = new Date(end.getTime() - 3600000);
      L.push('BEGIN:VEVENT', `UID:${s.id}-${m.kind}@conference-calendar`, `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
        `SUMMARY:${esc(`${hit.c.name} ${hit.e.year} ${m.label} — ${s.paper}`)}`,
        `DESCRIPTION:${esc(`狀態：${statusLabel(s.status)}\n信心：${m.confidence}`)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${hit.c.name} ${m.label}`)}`,
        'TRIGGER:-P3D', 'END:VALARM', 'END:VEVENT');
    }
  }
  L.push('END:VCALENDAR');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(L.join('\r\n') + '\r\n');
}

/* ---------- chrome ---------- */
function renderFilters(root) {
  const bar = el('div', 'filters');
  const mk = (label, set, val) => {
    const c = el('span', 'chip' + (set.has(val) ? ' on' : ''), label);
    c.onclick = () => { set.has(val) ? set.delete(val) : set.add(val); render(); };
    return c;
  };
  const a = el('div', 'chipset'); AREAS.forEach((x) => a.appendChild(mk(x, state.areas, x))); bar.appendChild(a);
  const r = el('div', 'chipset'); RANKS.forEach((x) => r.appendChild(mk(x, state.ranks, x))); bar.appendChild(r);

  const q = el('input'); q.type = 'search'; q.placeholder = '搜尋會議…'; q.value = state.q;
  q.oninput = (ev) => { state.q = ev.target.value; render({ keepFocus: 'search' }); };
  bar.appendChild(q);

  const toggles = [['showPast', '顯示已過期'], ['showEstimated', '顯示推估']];
  if (loadSubs().length) toggles.unshift(['onlyMine', '只看我的投稿']);
  else state.onlyMine = false;
  for (const [key, label] of toggles) {
    const lab = el('label', 'toggle');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = state[key];
    cb.onchange = () => { state[key] = cb.checked; render(); };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(label));
    bar.appendChild(lab);
  }
  root.appendChild(bar);
}

const VIEWS = [['deadlines', '截稿時間軸'], ['conferences', '依會議'], ['submissions', '我的投稿']];

function render(opts = {}) {
  const now = new Date();
  $('#tabs').replaceChildren(...VIEWS.map(([id, label]) => {
    const b = el('button', 'tab' + (state.view === id ? ' on' : ''), label);
    b.onclick = () => { state.view = id; render(); };
    return b;
  }));
  const root = $('#main'); root.replaceChildren();
  if (state.view !== 'submissions') { renderNextUp(root, now); renderFilters(root); }
  if (state.view === 'submissions') { renderSubmissions(root, now); return; }
  renderReviewQueue(root);
  if (state.view === 'deadlines') renderDeadlines(root, now);
  else renderConferences(root, now);
  renderSubscribe(root);

  if (opts.keepFocus === 'search') {
    const s = $('input[type=search]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
}

/* ---------- AoE clock ----------
   Every deadline in this calendar is quoted in AoE, so the question behind
   "how long have I got" is really "what time is it in AoE right now".

   The digits are drawn as seven-segment polygons rather than set in a monospace
   face, because the thing that makes an LCD read as an LCD is the ghost
   segments - all seven faintly visible whether lit or not. Without them this
   would just be numerals in a green box. */
const SEG_T = 2.3;
const hseg = (y, x1, x2) => { const h = SEG_T / 2;
  return `${x1},${y} ${x1 + h},${y - h} ${x2 - h},${y - h} ${x2},${y} ${x2 - h},${y + h} ${x1 + h},${y + h}`; };
const vseg = (x, y1, y2) => { const h = SEG_T / 2;
  return `${x},${y1} ${x + h},${y1 + h} ${x + h},${y2 - h} ${x},${y2} ${x - h},${y2 - h} ${x - h},${y1 + h}`; };
const SEG_PATH = {
  a: hseg(2.4, 2.4, 10.6), g: hseg(11.5, 2.4, 10.6), d: hseg(20.6, 2.4, 10.6),
  f: vseg(2.4, 2.4, 11.5),  b: vseg(10.6, 2.4, 11.5),
  e: vseg(2.4, 11.5, 20.6), c: vseg(10.6, 11.5, 20.6),
};
const SEG_ON = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
                 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

const digitSVG = (ch) => {
  const lit = SEG_ON[ch] ?? '';
  const segs = Object.entries(SEG_PATH)
    .map(([k, pts]) => `<polygon class="seg${lit.includes(k) ? ' on' : ''}" points="${pts}"/>`)
    .join('');
  return `<svg class="lcd-digit" viewBox="0 0 13 23" aria-hidden="true">${segs}</svg>`;
};

const WD_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function clockHTML(now) {
  const aoe = new Date(now.getTime() - 12 * 3600 * 1000);   // AoE is a fixed UTC-12
  const p = (n) => String(n).padStart(2, '0');
  const [MM, DD] = [aoe.getUTCMonth() + 1, aoe.getUTCDate()].map(p);
  const [hh, mm] = [aoe.getUTCHours(), aoe.getUTCMinutes()].map(p);
  /* The date gets the same size as the time, because it is the operative half:
     a deadline reads "2026-09-16 23:59:59 AoE", so what you check is whether it
     is still the 16th. Seconds are dropped for the same reason - they never
     change the answer. The year and weekday stay as small labels; nobody is
     unsure which year it is. */
  const dig = (str) => [...str].map(digitSVG).join('');
  // With no seconds on show, the blinking colon is the only sign it is live.
  const colon = `<span class="lcd-colon${aoe.getUTCSeconds() % 2 ? ' dim' : ''}"><i></i><i></i></span>`;
  return `<div class="lcd-top"><span class="lcd-tag">AoE</span>` +
         `<span class="lcd-year">${aoe.getUTCFullYear()}</span>` +
         `<span class="lcd-wd">${WD_EN[aoe.getUTCDay()]}</span></div>` +
         `<div class="lcd-readout">` +
           `<span class="lcd-field lcd-date">${dig(MM)}<span class="lcd-dash"></span>${dig(DD)}</span>` +
           `<span class="lcd-field lcd-time">${dig(hh)}${colon}${dig(mm)}</span>` +
         `</div>`;
}

function initClock() {
  const box = $('#clock');
  if (!box) return;
  /* Lives in the header, outside #main, so render() replacing the view never
     resets it - the seconds keep running while you filter and switch tabs. */
  box.title = 'Anywhere on Earth (UTC−12)：所有截稿日的基準時區';
  const tick = () => { box.innerHTML = clockHTML(new Date()); };
  tick();
  setInterval(tick, 1000);
}

/* theme */
/* Dark unless the reader has chosen otherwise. The CSS already paints dark with
   no data-theme set, so this only records the choice explicitly. */
function initTheme() {
  const root = document.documentElement;
  root.dataset.theme = localStorage.getItem('cc-theme') || 'dark';
  const btn = $('#theme');
  const label = () => { btn.textContent = root.dataset.theme === 'dark' ? '淺色' : '深色'; };
  label();
  btn.onclick = () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('cc-theme', root.dataset.theme);
    label();
  };
}

$('#gen').textContent = DATA.generated_at.slice(0, 10);
$('#count').textContent = String(DATA.conferences.length);
initTheme();
initClock();
initSync();
render();
setInterval(() => { if (state.view === 'deadlines') render(); }, 60000);
