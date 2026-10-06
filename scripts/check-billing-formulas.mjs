#!/usr/bin/env node
/**
 * Billing formula drift tripwire.
 *
 * The signup billing mechanism is split across two places: the code in this repo, and a set of
 * Airtable formula fields. The code half has a git history, review and a diff. The Airtable half
 * has none of that — which is how an undocumented "tier 4.5" was inserted into
 * {Billing Anchor Rehearsals Left Multiplier} some time after the May 11 2026 rewrite and
 * silently displaced the documented tier 5 for an entire term: 244 Winter-term signups priced on
 * weeks-elapsed-since-week-1 instead of rehearsals-remaining-before-the-anchor, 192 of them
 * overcharged (£1,392.00 + €367.50). Nothing could have caught it except someone noticing the money.
 *
 * This script closes that gap. It reads the live formulas via the Metadata API and compares them
 * to the approved snapshot committed next to it. Any edit that nobody re-approved fails the check.
 *
 *   npm run check:billing              compare live against the approved snapshot
 *   npm run check:billing -- --update  re-approve the live formulas (deliberate act;
 *                                      commit the resulting diff so it gets reviewed)
 *
 * Fails CLOSED on a confirmed drift — that is the whole point.
 * Fails OPEN when it cannot tell (no API key, Airtable unreachable, base/table/field missing):
 * a network blip must never block a deploy of unrelated code, and a false green here is
 * recoverable where a false red costs a release. Those cases print a warning.
 *
 * TWO BASES are guarded, because the pricing chain crosses one. {Rehearsals to 1st} on Signup
 * Queue is the tail of:
 *     Choirs base › Rehearsals.{Rehearsals to 1st}   (the real formula)
 *   → Choirs base › Choirs.{Rehearsals to 1st}       (lookup)
 *   → cross-base sync
 *   → SV Membership › Choirs MASTER.{Rehearsals to 1st}  (arrives as plain TEXT)
 *   → lookup on Signup Queue
 * Guarding only the Membership base would miss the formula that actually decides the number.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APPROVED = path.join(HERE, 'billing-formulas.approved.json');

/**
 * The billing-critical chain. Question 1 (how much today) and Question 2 (when does the first
 * subscription invoice land) both run through these, and the "golden rule" is that they agree —
 * so a change to any one of them can produce a free month or a double charge.
 */
const GUARDED = [
  {
    base: 'appgeAZX8ydvde5th', baseLabel: 'SV Membership Base',
    table: 'tblNHlZ2u3C65XuW7', tableLabel: 'Signup Queue',
    fields: [
      'Billing Anchor Rehearsals Left Multiplier',
      'Total Cost Initial Invoice',
      'Total Cost Initial Invoice 48 HOUR TRIAL CONSIDERED',
      'Tier (Current)',
      'Will Push to Next Month',
      'Skip Next Month',
      'Days Until Billing',
      'Next Billing Date (Before Push)',
      'Next Rehearsal Date',
    ],
  },
  {
    base: 'app5eEsU46HOwnLd2', baseLabel: 'Choirs',
    table: 'tbl8DgEG18XD7KVlS', tableLabel: 'Rehearsals',
    fields: [
      'Rehearsals to 1st',
      'Rehearsals to 15th',
      'Next Rehearsal Date',
    ],
  },
];

const keyFor = (g, field) => `${g.baseLabel} › ${g.tableLabel} › ${field}`;

/**
 * Shape invariants, checked independently of the snapshot. The snapshot catches "someone changed
 * it"; these catch "someone changed it AND re-approved without understanding what they broke".
 * Each encodes a specific failure this logic has actually had.
 *
 * `test` receives the formula with field ids resolved to field NAMES — the raw Metadata API text
 * refers to fields as {fldXXXXXXXXXXXXXX}, so a test looking for {Will Push to Next Month} finds
 * nothing in the raw form and misfires on a perfectly good formula.
 */
const INVARIANTS = [
  {
    key: 'SV Membership Base › Signup Queue › Billing Anchor Rehearsals Left Multiplier',
    name: 'tier 5 pro-rata SWITCH is present',
    test: (f) => /SWITCH\(/.test(f) && /3,\s*0\.75/.test(f) && /1,\s*0\.25/.test(f),
    why: 'The pro-rata SWITCH on {Rehearsals to 1st}/{Rehearsals to 15th} is the only correct '
       + 'basis for a mid-term first charge. If it is gone, every post-week-1 signup is being '
       + 'priced on something else.',
  },
  {
    key: 'SV Membership Base › Signup Queue › Billing Anchor Rehearsals Left Multiplier',
    name: 'no weeks-elapsed decay (the tier-4.5 regression)',
    test: (f) => !(/FLOOR\s*\(/.test(f) && /\/\s*7\s*\)/.test(f)),
    why: 'Pricing on weeks elapsed since {week 1 date} ignores where the billing anchor falls and '
       + 'how many rehearsals the choir actually has left in the month. This is the exact shape of '
       + 'the tier-4.5 bug that overcharged 192 Winter 2026 members.',
  },
  {
    key: 'SV Membership Base › Signup Queue › Billing Anchor Rehearsals Left Multiplier',
    name: 'Will Push override still sits above the pro-rata tiers',
    test: (f) => {
      const push = f.indexOf('Will Push'), sw = f.indexOf('SWITCH(');
      return push !== -1 && sw !== -1 && push < sw;
    },
    why: 'Tier 2 must be reached before any pro-rata branch. If the code bumps trial_end past the '
       + 'anchor and the multiplier has already returned a fraction, the customer gets a part-paid '
       + 'free month (the April 7 2026 bug).',
  },
  {
    key: 'SV Membership Base › Signup Queue › Will Push to Next Month',
    name: 'threshold is < 3 days, not < 2',
    test: (f) => /<\s*3/.test(f),
    why: '{Days Until Billing} measures from midnight, so 2 calendar days can be as little as 24 '
       + 'real hours — below Stripe\'s 48-hour trial_end minimum. < 3 is what keeps Airtable\'s '
       + 'charge aligned with getBillingAnchorTimestamp()\'s bump.',
  },
  // The rehearsal counts: the N that the pro-rata SWITCHes on.
  ...['Rehearsals to 1st', 'Rehearsals to 15th'].flatMap((field) => {
    const key = `Choirs › Rehearsals › ${field}`;
    return [
      {
        key,
        name: 'counts from NOW(), not from midnight',
        test: (f) => /\{[^}]+\}\s*>=\s*NOW\(\)/.test(f) && !/\{[^}]+\}\s*>=\s*TODAY\(\)/.test(f),
        why: 'TODAY() is midnight, so `{week N date} >= TODAY()` keeps a 19:00 rehearsal in the '
           + 'count until 23:59 — charging the member who sang it as a taster and signed up at '
           + '20:46. That hit 114 members in September 2026. Only the slot COMPARISONS use NOW(); '
           + 'the anchor-boundary TODAY() calls are correct and must stay.',
      },
      {
        key,
        name: 'half-term IS counted',
        test: (f) => /\{half-term date\}/.test(f),
        why: 'Half-term is a PAYABLE unit by policy (decided 6 Oct 2026): Some Voices often runs '
           + 'other membership activity that week, which justifies charging for it. Dropping it '
           + 'reduces every count by one for the 49 of 72 choirs that have a half-term, which '
           + 'under-charges them — worth about GBP 1,641 + EUR 193 across the rest of the Winter '
           + 'term. NB this is the OPPOSITE of the main app, where {half-term date} means "no '
           + 'rehearsal" unless a leader is named. This invariant was briefly inverted earlier the '
           + 'same day on a reading that half-term was not billable; that was revised. It encodes '
           + 'policy, so if policy moves again, change it deliberately and record why.',
      },
      {
        key,
        name: 'all 12 slots are counted',
        test: (f) => (f.match(/>=\s*NOW\(\)/g) || []).length === 12,
        why: 'The formula must test {week 1 date} through {week 11 date} plus {half-term date} — '
           + 'twelve slots. A missing one is invisible in the output (the count is simply lower) '
           + 'and under-charges every member at a choir whose rehearsal falls in that slot. Week 11 '
           + 'is populated for only one choir of 72 but is kept deliberately: if a date is there it '
           + 'is a real rehearsal.',
      },
    ];
  }),
];

const normalise = (s) => String(s).replace(/\s+/g, ' ').trim();
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function warnAndPass(message, detail) {
  console.log('\n⚠️  Billing formula check SKIPPED — ' + message);
  if (detail) console.log('   ' + detail);
  console.log('   Failing open: this check never blocks a build on something it cannot read.\n');
  process.exit(0);
}

function readApiKey() {
  if (process.env.AIRTABLE_API_KEY) return process.env.AIRTABLE_API_KEY;
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^AIRTABLE_API_KEY=(.+)$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

async function fetchTables(baseId, key) {
  const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Metadata API returned ${res.status} for base ${baseId}. ${body.slice(0, 160)}`);
  }
  return (await res.json()).tables;
}

/** Field ids survive renames; names do not. Compare on ids, display with names. */
function snapshotOf(groups) {
  const snapshot = {}, nameOf = {}, missing = [];
  for (const { group, tables } of groups) {
    const table = tables.find((t) => t.id === group.table);
    if (!table) { missing.push(`${group.baseLabel} › ${group.tableLabel} (table not found)`); continue; }
    const names = Object.fromEntries(table.fields.map((f) => [f.id, f.name]));
    for (const field of group.fields) {
      const k = keyFor(group, field);
      nameOf[k] = names;
      const f = table.fields.find((x) => x.name === field);
      if (!f) { missing.push(k); continue; }
      const formula = f.options?.formula ?? null;
      snapshot[k] = {
        base: group.base, table: group.table, id: f.id, type: f.type,
        formula: formula === null ? null : normalise(formula),
        sha: formula === null ? null : digest(normalise(formula)),
      };
    }
  }
  return { snapshot, nameOf, missing };
}

const withNames = (formula, names) =>
  String(formula).replace(/\{(fld[A-Za-z0-9]+)\}/g, (_, id) => `{${(names || {})[id] || id}}`);

/** First point of divergence, so a 2,000-char formula reports as a readable window. */
function firstDifference(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return i;
}

async function main() {
  const update = process.argv.includes('--update');

  const key = readApiKey();
  if (!key) {
    warnAndPass('no AIRTABLE_API_KEY available.',
      'Set it in the environment or in .env.local at the project root.');
  }

  // One metadata call per distinct base, not per group.
  const byBase = new Map();
  try {
    for (const baseId of [...new Set(GUARDED.map((g) => g.base))]) {
      byBase.set(baseId, await fetchTables(baseId, key));
    }
  } catch (err) {
    warnAndPass('could not read an Airtable schema.', err.message);
  }
  const groups = GUARDED.map((group) => ({ group, tables: byBase.get(group.base) }));

  const { snapshot, nameOf, missing } = snapshotOf(groups);

  const brokenInvariants = (snap) => INVARIANTS.filter((inv) => {
    const f = snap[inv.key]?.formula;
    return f ? !inv.test(withNames(f, nameOf[inv.key])) : false;
  });

  if (update) {
    const broken = brokenInvariants(snapshot);
    if (broken.length) {
      console.error('\n❌ REFUSING to approve — the live formulas break invariants that encode');
      console.error('   failures this billing logic has already had in production:\n');
      for (const inv of broken) {
        console.error(`── ${inv.key}\n   ${inv.name}`);
        console.error(`   ${inv.why}\n`);
      }
      console.error('Fix the formula in Airtable first, then re-run with --update.\n');
      process.exit(1);
    }
    fs.writeFileSync(APPROVED, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`\n✅ Approved snapshot rewritten from live Airtable: ${path.relative(ROOT, APPROVED)}`);
    console.log(`   ${Object.keys(snapshot).length} field(s) across ${byBase.size} base(s), ${INVARIANTS.length} invariants satisfied.`);
    console.log('   Commit the diff so the change gets reviewed like code.\n');
    return;
  }

  if (!fs.existsSync(APPROVED)) {
    warnAndPass('no approved snapshot on disk.',
      'Run `npm run check:billing -- --update` once to record the current formulas.');
  }

  const approved = JSON.parse(fs.readFileSync(APPROVED, 'utf8'));
  const problems = [];
  const expected = GUARDED.flatMap((g) => g.fields.map((f) => keyFor(g, f)));

  for (const k of expected) {
    const want = approved[k], got = snapshot[k];
    if (!want) {
      console.log(`   note: ${k} is guarded but absent from the approved snapshot — re-approve to include it.`);
      continue;
    }
    if (!got) {
      problems.push({ key: k, kind: 'missing', detail: 'Field not found. It was renamed or deleted.' });
      continue;
    }
    if (want.type !== got.type) {
      problems.push({ key: k, kind: 'type', detail: `type changed: ${want.type} → ${got.type}` });
    }
    if (want.sha !== got.sha) problems.push({ key: k, kind: 'formula', want, got });
  }

  for (const inv of brokenInvariants(snapshot)) {
    problems.push({ key: inv.key, kind: 'invariant', name: inv.name, why: inv.why });
  }

  // If the committed snapshot itself breaks an invariant, say so separately — that is a problem
  // with this check's own baseline, not with whoever is running the build.
  for (const inv of brokenInvariants(approved)) {
    console.error(`\n⚠️  The APPROVED snapshot itself violates "${inv.name}" on ${inv.key}.`);
    console.error('   Re-approve from a formula that satisfies it.');
  }

  if (missing.length) console.log('\n   note: not found on the live schema: ' + missing.join(', '));

  if (!problems.length) {
    console.log(`\n✅ Billing formulas match the approved snapshot (${expected.length - missing.length} field(s) across ${byBase.size} base(s), ${INVARIANTS.length} invariants).\n`);
    return;
  }

  console.error('\n❌ BILLING FORMULA DRIFT — the Airtable formulas no longer match the approved snapshot.');
  console.error('   These fields decide what every new member is charged at signup. Do not ignore this.\n');

  for (const p of problems) {
    if (p.kind === 'invariant') {
      console.error(`── ${p.key}\n   INVARIANT BROKEN: ${p.name}`);
      console.error(`   ${p.why}\n`);
      continue;
    }
    if (p.kind === 'formula') {
      const names = nameOf[p.key];
      const a = withNames(p.want.formula, names), b = withNames(p.got.formula, names);
      const at = firstDifference(a, b);
      console.error(`── ${p.key}`);
      console.error(`   formula changed (${p.want.sha} → ${p.got.sha}, ${p.want.formula.length} → ${p.got.formula.length} chars)`);
      console.error(`   identical up to char ${at}, then:`);
      console.error(`   APPROVED: …${a.slice(at, at + 220)}`);
      console.error(`   LIVE:     …${b.slice(at, at + 220)}\n`);
      continue;
    }
    console.error(`── ${p.key}\n   ${p.detail}\n`);
  }

  console.error('What to do:');
  console.error('  • If the change was NOT intended, restore the approved formula in Airtable.');
  console.error('    Approved text: ' + path.relative(ROOT, APPROVED) + ', or the paste-ready');
  console.error('    .txt files in ~/Documents/Vercel/airtable-formulas.');
  console.error('  • If it WAS intended, re-audit the pricing it produces before approving it:');
  console.error('    run the audit-signup-queue skill against the Signup Queue, then');
  console.error('    `npm run check:billing -- --update` and commit the diff.');
  console.error('  • Update the 5-tier waterfall in CLAUDE.md in the same change, so the');
  console.error('    doctrine and the formula cannot disagree again.\n');
  process.exit(1);
}

main().catch((err) => {
  // An unexpected crash in the tripwire itself must not block a deploy.
  warnAndPass('the check crashed unexpectedly.', err?.stack || String(err));
});
