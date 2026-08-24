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
    const row = el('div', 'row' + sev + (mine.length ? ' mine' : ''));

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
      /* A milestone is "live" for this paper when its current status is waiting
         on it - the same rule that drives the 我的投稿 view. */
      const live = (RELEVANT[sub.status] || []).includes(baseKind(m.kind)) && !isPast;
      const chip = el('span', 'mine-chip' + (live ? ' live' : ''));
      chip.textContent = `${live ? '▸ ' : ''}${sub.paper}`;
      chip.title = `你的投稿・${statusLabel(sub.status)}` +
        (live ? '\n這是你目前在等的日期。' : '');
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

function loadSubs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SUB_KEY) || '{}');
    return Array.isArray(raw.submissions) ? raw.submissions : [];
  } catch { return []; }
}
function saveSubs(list) {
  localStorage.setItem(SUB_KEY, JSON.stringify({ schema: 1, submissions: list }));
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

function renderSubmissions(root, now) {
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
      value: id, textContent: `${v.c.name} ${v.e.year}${v.e.status === 'estimated' ? '（推估）' : ''}`,
    })));
  const st = el('select');
  STATUSES.forEach(([v, l]) => st.appendChild(Object.assign(el('option'), { value: v, textContent: l })));
  st.value = 'planned';
  const add = el('button', 'chip on', '新增');
  add.type = 'submit';
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
    h.appendChild(el('span', null, s.paper));
    card.appendChild(h);

    const line = el('div', 'ed-head');
    line.appendChild(el('span', 'mkind', hit ? `${hit.c.name} ${hit.e.year}` : s.venue));
    if (hit) line.appendChild(el('span', rankCls(hit.c.rank?.value), hit.c.rank?.value || '—'));
    const sel = el('select');
    STATUSES.forEach(([v, l]) => sel.appendChild(Object.assign(el('option'), { value: v, textContent: l })));
    sel.value = s.status;
    sel.onchange = () => {
      const list = loadSubs(); const t = list.find((x) => x.id === s.id);
      t.status = sel.value;
      (t.history ||= []).push({ status: sel.value, on: todayLocal() });
      saveSubs(list); render();
    };
    line.appendChild(sel);
    const del = el('button', 'chip', '刪除');
    del.onclick = () => { if (confirm(`刪除「${s.paper}」的紀錄？`)) { saveSubs(loadSubs().filter((x) => x.id !== s.id)); render(); } };
    line.appendChild(del);
    card.appendChild(line);

    if (!p.length) {
      card.appendChild(el('div', 'note',
        ['rejected', 'withdrawn'].includes(s.status) ? '沒有待辦日期。'
          : s.status === 'registered' ? '都辦完了，等著去開會。'
          : '這個會議還沒公布相關日期。'));
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
  root.appendChild(el('div', 'count',
    '這些紀錄只存在這個瀏覽器裡，不會上傳，也不在 repo 中。換裝置或清快取前請先匯出。'));
  const box = el('div', 'subs');

  const exp = el('a', null, '匯出 JSON');
  exp.href = 'data:application/json;charset=utf-8,' +
    encodeURIComponent(JSON.stringify({ schema: 1, submissions: loadSubs() }, null, 2));
  exp.download = 'my-submissions.json';
  box.appendChild(exp);

  const impLabel = el('label', null, '匯入 JSON');
  impLabel.style.cssText = 'font:500 12px var(--ui);color:var(--petrol);border:1px solid var(--line);border-radius:3px;padding:4px 10px;background:var(--surface);cursor:pointer';
  const imp = el('input'); imp.type = 'file'; imp.accept = 'application/json'; imp.style.display = 'none';
  imp.onchange = async () => {
    const f = imp.files?.[0]; if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (!Array.isArray(parsed.submissions)) throw new Error('缺少 submissions 陣列');
      const cur = loadSubs();
      const byId = new Map(cur.map((x) => [x.id, x]));
      for (const s of parsed.submissions) byId.set(s.id, s);
      saveSubs([...byId.values()]);
      render();
    } catch (e) { alert('匯入失敗：' + e.message); }
  };
  impLabel.appendChild(imp);
  box.appendChild(impLabel);

  const ics = el('a', null, '下載我的 .ics');
  ics.href = personalICS(subs, idx);
  ics.download = 'my-deadlines.ics';
  box.appendChild(ics);
  root.appendChild(box);
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

/* theme */
function initTheme() {
  const saved = localStorage.getItem('cc-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').onclick = () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cc-theme', next);
  };
}

$('#gen').textContent = DATA.generated_at.slice(0, 10);
$('#count').textContent = String(DATA.conferences.length);
initTheme();
render();
setInterval(() => { if (state.view === 'deadlines') render(); }, 60000);
