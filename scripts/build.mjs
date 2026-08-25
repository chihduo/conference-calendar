#!/usr/bin/env node
/* Build: data/conferences/*.yml -> dist/
   The page inlines its own JSON so it opens straight from file:// with no
   server - fetch('data.json') would be blocked by CORS on a local file. */
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { ROOT, loadConferences, readReviewQueue, instantOf, kindLabel, byDateThenKind,
         auditEstimates, severityOf } from './lib.mjs';

const DIST = path.join(ROOT, 'dist');
const SITE = path.join(ROOT, 'site');

/* ---------- model ---------- */

function buildModel() {
  const confs = loadConferences();
  const out = confs.map((c) => ({
    id: c.id, name: c.name, full_name: c.full_name || '', areas: c.areas,
    dblp: c.dblp || null, note: c.note || null,
    rank: c.rank || { source: null, value: 'unranked' },
    editions: c.editions
      .slice()
      .sort((a, b) => b.year - a.year)
      .map((e) => ({
        year: e.year, id: e.id, link: e.link || null, place: e.place || null,
        dates: e.dates || null, start_date: e.start_date || null, end_date: e.end_date || null,
        status: e.status, timezone: e.timezone || 'AoE', note: e.note || null,
        needs_review: !!e.needs_review,
        milestones: e.milestones
          .slice()
          .sort(byDateThenKind)
          .map((m) => {
            const inst = instantOf(m, e);
            return {
              kind: m.kind, label: kindLabel(m.kind),
              date: m.date || null, time: m.time || (m.date ? '23:59:59' : null),
              tz: m.tz || e.timezone || 'AoE',
              iso: inst ? inst.toUTC().toISO() : null,
              confidence: m.confidence,
              derived_from: m.derived_from || null,
              locked: !!m.locked, needs_review: !!m.needs_review,
              note: m.note || null, source_url: m.source_url || null,
            };
          }),
      })),
  }));
  /* The estimate audit is local and free, so run it every build: the page then
     reflects estimate health as of now, not as of the last fetch. */
  const audit = confs.flatMap((c) =>
    auditEstimates(c).map((a) => ({
      conference: c.id, edition: a.edition, kind: a.kind, reason: a.reason,
      severity: severityOf(a.reason), detail: a.detail,
    })));
  const stored = readReviewQueue().filter((r) => !r.reason?.startsWith('estimate') && r.reason !== 'stale-base');
  return {
    generated_at: DateTime.utc().toISO(), conferences: out,
    review_queue: [...stored, ...audit],
  };
}

/* ---------- iCalendar ---------- */

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stampUTC  = (iso) => DateTime.fromISO(iso, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'");
const stampDate = (d)   => DateTime.fromISO(d, { zone: 'utc' }).toFormat('yyyyLLdd');

/* RFC 5545 caps a content line at 75 octets; continuations start with a space. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = Buffer.alloc(0);
  for (const ch of [...line]) {
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > (parts.length ? 74 : 75)) { parts.push(cur.toString('utf8')); cur = Buffer.alloc(0); }
    cur = Buffer.concat([cur, b]);
  }
  if (cur.length) parts.push(cur.toString('utf8'));
  return parts.map((p, i) => (i ? ' ' + p : p)).join('\r\n');
}

const CONF_KEY = { abstract: 1, submission: 1 };

function toICS(model, { filter = () => true, name = 'Conference deadlines' } = {}) {
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//conference-calendar//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`, 'X-WR-TIMEZONE:UTC',
  ];
  const now = stampUTC(model.generated_at);
  for (const c of model.conferences) {
    for (const e of c.editions) {
      if (e.status === 'past') continue;
      if (!filter(c, e)) continue;
      const rank = c.rank?.value && c.rank.value !== 'unranked' ? ` [${c.rank.value}]` : '';

      for (const m of e.milestones) {
        if (!m.iso) continue;
        const end = DateTime.fromISO(m.iso, { zone: 'utc' });
        const start = end.minus({ hours: 1 });
        const marks = { confirmed: '', announced: ' (announced)', estimated: ' (ESTIMATED)' }[m.confidence] ?? '';
        L.push('BEGIN:VEVENT',
          `UID:${e.id}-${m.kind}@conference-calendar`,
          `DTSTAMP:${now}`,
          `DTSTART:${stampUTC(start.toISO())}`,
          `DTEND:${stampUTC(end.toISO())}`,
          fold(`SUMMARY:${icsEscape(`${c.name} ${e.year}${rank} - ${m.label}${marks}`)}`),
          fold(`DESCRIPTION:${icsEscape(
            [`${c.full_name || c.name}`,
             `${m.label}: ${m.date} ${m.time} ${m.tz}`,
             `Confidence: ${m.confidence}${m.derived_from ? ` (from ${m.derived_from})` : ''}`,
             e.place ? `Conference: ${e.dates || ''} ${e.place}` : '',
             e.link || ''].filter(Boolean).join('\n'))}`));
        if (e.link) L.push(fold(`URL:${e.link}`));
        // A week's notice, but only on the deadlines you actually act on.
        if (CONF_KEY[m.kind]) {
          L.push('BEGIN:VALARM', 'ACTION:DISPLAY',
            fold(`DESCRIPTION:${icsEscape(`${c.name} ${e.year} ${m.label} in 7 days`)}`),
            'TRIGGER:-P7D', 'END:VALARM');
        }
        L.push('END:VEVENT');
      }

      if (e.start_date) {
        const endEx = DateTime.fromISO(e.end_date || e.start_date, { zone: 'utc' }).plus({ days: 1 }).toISODate();
        L.push('BEGIN:VEVENT',
          `UID:${e.id}-conference@conference-calendar`,
          `DTSTAMP:${now}`,
          `DTSTART;VALUE=DATE:${stampDate(e.start_date)}`,
          `DTEND;VALUE=DATE:${stampDate(endEx)}`,
          fold(`SUMMARY:${icsEscape(`${c.name} ${e.year}${rank}${e.status === 'estimated' ? ' (ESTIMATED)' : ''}`)}`),
          fold(`LOCATION:${icsEscape(e.place || 'TBD')}`),
          'END:VEVENT');
      }
    }
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/* ---------- emit ---------- */

const model = buildModel();
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const feeds = {
  'all.ics':    { name: 'Conference deadlines (all)', filter: () => true },
  'fm.ics':     { name: 'FM deadlines',    filter: (c) => c.areas.includes('FM') },
  'pl.ics':     { name: 'PL deadlines',    filter: (c) => c.areas.includes('PL') },
  'ai.ics':     { name: 'AI deadlines',    filter: (c) => c.areas.includes('AI') },
  'se.ics':     { name: 'SE deadlines',    filter: (c) => c.areas.includes('SE') },
  'logic.ics':  { name: 'Logic deadlines', filter: (c) => c.areas.includes('LOGIC') },
  'sec.ics':    { name: 'Security deadlines', filter: (c) => c.areas.includes('SEC') },
  'rank-a.ics': { name: 'A*/A deadlines',  filter: (c) => ['A*', 'A'].includes(c.rank?.value) },
};

/* Written to disk for calendar subscription, and inlined as data: URIs so the
   download buttons also work from file:// and from a preview host. */
const feedUris = {};
for (const [file, cfg] of Object.entries(feeds)) {
  const body = toICS(model, cfg);
  fs.writeFileSync(path.join(DIST, file), body);
  feedUris[file] = 'data:text/calendar;charset=utf-8;base64,' + Buffer.from(body, 'utf8').toString('base64');
}
model.feeds = feedUris;

const css = fs.readFileSync(path.join(SITE, 'style.css'), 'utf8');
/* Sync config is optional. With no file the whole feature reports status 'off'
   and the page behaves exactly as it did before any of this existed - which is
   also what keeps it working inside the artifact preview, where a strict CSP
   blocks every external host. */
const cfgPath = path.join(ROOT, 'data', 'sync-config.json');
const syncCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8').trim() : 'null';
const js  = `window.__SYNC_CONFIG__ = ${syncCfg};\n`
          + fs.readFileSync(path.join(SITE, 'sync.js'), 'utf8') + '\n'
          + fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js)
  .replace('"__DATA__"', () => JSON.stringify(model));
fs.writeFileSync(path.join(DIST, 'index.html'), html);
fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(model, null, 2));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const nEd = model.conferences.reduce((n, c) => n + c.editions.length, 0);
const nMs = model.conferences.reduce((n, c) => n + c.editions.reduce((m, e) => m + e.milestones.filter((x) => x.iso).length, 0), 0);
console.log(`Built dist/: ${model.conferences.length} conferences, ${nEd} editions, ${nMs} dated milestones, ${Object.keys(feeds).length} ICS feeds.`);
