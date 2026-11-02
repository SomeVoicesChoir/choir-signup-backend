#!/usr/bin/env node
/**
 * Proves lib/firstCharge.js does what it says, across every case rather than a handful.
 *
 *   npm run check:firstcharge
 *
 * Run under TZ=UTC because that is Vercel's clock (the npm script sets it). Exits 1 on any
 * failure, printing the first few counter-examples.
 *
 * WHAT IS ASSERTED, AND WHY
 *  A. legacyFirstCharge() is IDENTICAL to the function it replaced (a frozen copy lives below),
 *     every 3 hours for two years, both billing days, skip Yes and No. The refactor moved code;
 *     it must not have changed any answer.
 *  B. With no {First Term Anchor}, or one not later than the legacy date, firstChargeFor() returns
 *     the legacy date to the second. i.e. NOTHING changes for a choir that is already rehearsing.
 *  C. ⚠️ NEVER LATER THAN DUE. A deferred date is EXACTLY the term's first billing date — never a
 *     month past it — and only ever when that date is later than the legacy one. Policy, 2 Nov
 *     2026: a charge due this month must never move into next month.
 *  D. Never earlier than the term's first billing date, and always ≥ 48h away (Stripe's minimum).
 *  E. THE GOLDEN RULE — the up-front charge and the first monthly charge must agree. A mirror of
 *     the live Airtable formulas decides which tier the initial invoice used; a deferral may only
 *     follow tier 3 (activation fee only) or tier 2 (a full month up front). Never tier 4/5: those
 *     mean the term is already billing, and deferring there would under-charge.
 *
 *     ⚠️ Tier 2 + deferral is a KNOWN PRE-EXISTING over-charge, reported in the summary line: a
 *     signup within 2 days of a 1st/15th, at a choir whose term starts billing a month or more
 *     later, pays a full month up front because {Will Push} sits above tier 3 in the formula. The
 *     legacy code then charged them AGAIN the following month; the deferral removes that second
 *     month, it does not create the first. Fixing the first is an Airtable formula change.
 */

import { legacyFirstCharge, firstChargeFor, parseTermAnchor, monthsBetween } from '../lib/firstCharge.js';

if (new Date(2026, 0, 1).getTimezoneOffset() !== 0) {
  console.error('Run under TZ=UTC (Vercel\'s clock): `TZ=UTC node scripts/check-first-charge.mjs`');
  process.exit(1);
}

// ── A frozen copy of getBillingAnchorTimestamp() as it stood in create-subscription-first.js
//    before Nov 2026. Do not edit: it is the reference the refactor is judged against.
function ORIGINAL(billing_date, skipNextMonth, now) {
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();
  const dayOfMonth = parseInt(billing_date.replace(/\D/g, ''));
  let billingDate;
  if (currentDay > dayOfMonth || currentDay === dayOfMonth || skipNextMonth === 'Yes') {
      billingDate = new Date(currentYear, currentMonth + 1, dayOfMonth);
  } else {
      billingDate = new Date(currentYear, currentMonth, dayOfMonth);
  }
  const minTrialEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  if (billingDate < minTrialEnd) {
    billingDate = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, dayOfMonth);
  }
  return Math.floor(billingDate.getTime() / 1000);
}

// ── Mirror of the live Signup Queue formulas (read 2 Nov 2026), for assertion E only.
const ymd = (d) => d.toISOString().slice(0, 10);
const midnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** {First Term Anchor}: the 1st/15th of week 1's month, +1 month when week 1 is in April. */
function ftaFor(week1, day) {
  const m = week1.getUTCMonth();
  return ymd(new Date(Date.UTC(week1.getUTCFullYear(), m + (m === 3 ? 1 : 0), day)));
}
/** Which tier {Billing Anchor Rehearsals Left Multiplier} lands on, given the NEXT rehearsal. */
function airtableTier({ now, week1, nextRehearsal, day }) {
  const today = midnight(now);
  const sameOrNext = (d) => {
    const diff = (d.getUTCFullYear() - today.getUTCFullYear()) * 12 + d.getUTCMonth() - today.getUTCMonth();
    return diff === 0 || diff === 1;
  };
  const skip = nextRehearsal && !sameOrNext(nextRehearsal) ? 'Yes' : 'No';
  // {Next Billing Date (Before Push)} — month overflow (13, 14) modelled as rolling into next year.
  const m = today.getUTCMonth() + (skip === 'Yes' ? 2 : (today.getUTCDate() >= day ? 1 : 0));
  const nextBilling = new Date(Date.UTC(today.getUTCFullYear(), m, day));
  const days = Math.round((nextBilling - today) / 86400000);
  const willPush = days < 3;
  let tier;
  if (!week1) tier = 1;
  else if (willPush) tier = 2;
  else if (ymd(today) < ftaFor(week1, day)) tier = 3;
  else if (today < week1) tier = 4;
  else tier = 5;
  return { tier, skip };
}

const failures = {};
let checks = 0;
// Counts every failure but keeps only a few examples — a badly broken function fails millions of
// cases, and storing them all runs Node out of memory instead of reporting.
function fail(name, detail) {
  const f = (failures[name] = failures[name] || { count: 0, examples: [] });
  f.count++;
  if (f.examples.length < 4) f.examples.push(detail);
}
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 16);

const START = Date.UTC(2026, 0, 1), END = Date.UTC(2028, 0, 1);
const STEP = 3 * 3600 * 1000;
let deferrals = 0, tier2WithDeferral = 0;

for (let t = START; t < END; t += STEP) {
  const now = new Date(t);
  for (const day of [1, 15]) {
    for (const skip of ['Yes', 'No']) {
      const legacy = legacyFirstCharge(String(day), skip, now);
      const orig = ORIGINAL(String(day), skip, now);
      checks++;
      if (legacy !== orig) fail('A legacy == original', { now: now.toISOString(), day, skip, legacy: iso(legacy), orig: iso(orig) });
      const none = firstChargeFor({ billingDate: String(day), skipNextMonth: skip, firstTermAnchor: undefined, now });
      checks++;
      if (none.trialEnd !== orig || none.deferredMonths !== 0) fail('B no anchor ⇒ unchanged', { now: now.toISOString(), day, skip });
    }

    // Week 1 anywhere from 9 months ago to 9 months ahead, one day at a time. Skip is derived
    // the way Airtable derives it, so every combination the live system can produce is covered.
    for (let k = -270; k <= 270; k++) {
      const week1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k, 18));
      // Mid-term the next rehearsal is next week; before the term it is week 1 itself.
      const nextRehearsal = week1 > now ? week1 : new Date(t + 7 * 86400000);
      const { tier, skip } = airtableTier({ now, week1, nextRehearsal, day });
      const fta = ftaFor(week1, day);
      const anchor = parseTermAnchor(fta);
      const orig = ORIGINAL(String(day), skip, now);
      const r = firstChargeFor({ billingDate: String(day), skipNextMonth: skip, firstTermAnchor: fta, now });
      const ctx = () => ({ now: now.toISOString(), day, week1: ymd(week1), fta, skip, tier, legacy: iso(orig), got: iso(r.trialEnd) });
      checks += 6;

      if (r.legacy !== orig) fail('A legacy == original (with anchor)', ctx());
      if (anchor <= orig && r.trialEnd !== orig) fail('B anchor not later ⇒ unchanged', ctx());
      if (r.trialEnd !== orig && r.trialEnd !== anchor) fail('C deferral lands exactly ON the term anchor', ctx());
      if (r.trialEnd < orig) fail('C never earlier than legacy', ctx());
      if (r.trialEnd < anchor) fail('D never before the term anchor', ctx());
      if (r.trialEnd * 1000 < t + 48 * 3600 * 1000) fail('D at least 48h away', ctx());
      if (r.deferredMonths !== (r.trialEnd === orig ? 0 : monthsBetween(orig, r.trialEnd))) fail('deferredMonths consistent', ctx());

      if (r.trialEnd !== orig) {
        deferrals++;
        checks++;
        // Tier 3 = activation fee only: the deferral is exactly what tier 3 promised.
        // Tier 2 = a FULL month up front (Will Push sits above tier 3 in the formula). That
        // member still pays from the term anchor on, so nothing is under-charged — they are
        // one month OVER, which is pre-existing (the legacy code charged them a further month
        // on top) and reduced, not caused, by deferring. Counted and reported, not failed.
        // Tiers 4/5 would mean the term is already billing — a deferral there is the bug.
        if (tier === 2) tier2WithDeferral++;
        else if (tier !== 3) fail('E deferral only ever follows tier 3 (or tier 2\'s full month)', ctx());
      }
      // The converse: tier 3 promises "the monthly charges cover everything" — so the first
      // monthly charge must not fall before the term starts billing. This is the bug being fixed.
      if (tier === 3) {
        checks++;
        if (r.trialEnd < anchor) fail('E tier 3 ⇒ first charge not before the term anchor', ctx());
      }
      // In-term (billing has started): absolutely no change.
      if (ymd(midnight(now)) >= fta) {
        checks++;
        if (r.trialEnd !== orig) fail('C term already billing ⇒ unchanged', ctx());
      }
    }
  }
}

// parseTermAnchor guards
for (const [input, ok] of [['2027-01-01', true], [['2027-01-15'], true], ['', false], [undefined, false],
  ['2027-02-30', false], ['01/01/2027', false], [{ error: '#ERROR!' }, false], ['2027-1-1', false]]) {
  checks++;
  if ((parseTermAnchor(input) !== null) !== ok) fail('parseTermAnchor', { input });
}
// An anchor not on the member's billing day is refused (falls back to legacy).
{
  const now = new Date(Date.UTC(2026, 10, 2, 12));
  const r = firstChargeFor({ billingDate: '1', skipNextMonth: 'Yes', firstTermAnchor: '2027-01-15', now });
  checks++;
  if (r.deferredMonths !== 0) fail('mismatched billing day ⇒ legacy', { got: iso(r.trialEnd) });
}
// The case that started this: Thursday Amsterdam, signup today, week 1 in January.
{
  const now = new Date(Date.UTC(2026, 10, 2, 12));
  for (const day of [1, 15]) {
    const r = firstChargeFor({ billingDate: String(day), skipNextMonth: 'Yes', firstTermAnchor: `2027-01-${day === 1 ? '01' : '15'}`, now });
    console.log(`  Amsterdam, signup 2 Nov 2026, billing day ${day}: legacy ${iso(r.legacy).slice(0, 10)} → now ${iso(r.trialEnd).slice(0, 10)} (deferred ${r.deferredMonths})`);
  }
}

const names = Object.keys(failures);
console.log(`\n${checks.toLocaleString()} checks · ${deferrals.toLocaleString()} deferred cases · tier 2 alongside a deferral: ${tier2WithDeferral}`);
if (!names.length) {
  console.log('✅ first-charge: every assertion holds.\n');
  process.exit(0);
}
console.error('\n❌ first-charge FAILED:');
for (const n of names) {
  console.error(`── ${n}: ${failures[n].count.toLocaleString()} case(s)`);
  for (const d of failures[n].examples) console.error('   ', JSON.stringify(d));
}
process.exit(1);
