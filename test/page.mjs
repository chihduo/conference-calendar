/* What the UI suites run against: a page built from test/fixtures/data, seen
   through a clock pinned to FIXTURE_NOW.

   Both halves are needed. The nightly refresh rewrites data/, and a test that
   reads it asserts about the world rather than the code: ECAI 2027 was the
   "dates not announced yet" example until the morning ccfddl listed its
   deadline, and every deploy after that failed. Freezing the data alone is not
   enough - under a real clock VMCAI 2027 drops off the timeline after November
   2026, and POPL 2028 closes in July 2027.

   The fixture is data/conferences as of bd32c2c (2026-09-24), the last state
   the suites passed against, cut down to the venues they name. It has no
   sync-config.json, so the page starts in local-only mode unless a suite
   injects a config. Live data gets checked too, by live.test.mjs, for the one
   thing that stays true of it: it renders. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Noon UTC is 24 September in every zone from AoE to UTC+11, so "today" is not a matter of TZ.
export const FIXTURE_NOW = '2026-09-24T12:00:00Z';

let html = null;
/** Built once per process, into a scratch dir: suites may run side by side, and dist/ is the real site. */
export function fixturePage() {
  if (html) return html;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fixture-'));
  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: ROOT, stdio: 'pipe',
      env: { ...process.env, CC_DATA_DIR: path.join(ROOT, 'test/fixtures/data'), CC_DIST_DIR: out },
    });
    html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  return html;
}

/* Runs in the page's own realm, before the app script, so every `new Date()` and
   `Date.now()` the app makes starts from the pinned instant. The clock still
   moves on from there, so timeouts and Date.now()-based ids behave as live. */
export function pinClock(window, iso = FIXTURE_NOW) {
  window.eval(`(() => {
    const Real = Date, skew = Real.parse(${JSON.stringify(iso)}) - Real.now();
    globalThis.Date = class extends Real {
      constructor(...a) { if (a.length) super(...a); else super(Real.now() + skew); }
      static now() { return Real.now() + skew; }
    };
  })();`);
}
