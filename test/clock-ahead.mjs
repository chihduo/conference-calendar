/* Imported first by every fixture suite: the suite runs as if it were 400 days
   from now.

   The suites are meant not to depend on today's date - the pages pin their own
   clock (page.mjs), the function test runs on its stand-in's clock. Twice a
   test leaned on the real date anyway and only broke weeks later, each time as
   a failed deploy: ECAI 2027 on 2026-09-25, then the Edge Function's 14-day
   window on 2026-10-12. Running ahead makes such a test fail the day it is
   written. live.test.mjs reads today's data on purpose and does not import
   this. */
const skew = Number(process.env.CLOCK_AHEAD_DAYS ?? 400) * 86400e3;
const Real = Date;
globalThis.Date = class extends Real {
  constructor(...a) { if (a.length) super(...a); else super(Real.now() + skew); }
  static now() { return Real.now() + skew; }
};
