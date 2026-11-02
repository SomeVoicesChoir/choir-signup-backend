/**
 * When does a new member's first MONTHLY charge land? — one definition.
 *
 * The answer is Stripe's `trial_end` on the subscription. (The "trial" is only
 * Stripe's mechanism for delaying the first invoice; nothing is free.)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ──────────────────────────────────────────────────────────────────────────
 * The first charge is the LATER of:
 *
 *   1. `legacyFirstCharge()` — the next 1st/15th, exactly as the code has
 *      always computed it (copied unchanged from create-subscription-first,
 *      Nov 2026). For every signup into a choir that is already rehearsing
 *      this is the answer, to the second.
 *   2. `{First Term Anchor}` on the Signup Queue row — the term's first billing
 *      date (the 1st/15th of week 1's month; May for an April week 1).
 *
 * (2) only wins when the choir has not started its term yet: a brand-new choir
 * opened for sale ahead of its launch, or a joiner between terms. Until Nov
 * 2026 those members were charged a month (sometimes two) before the choir
 * had a rehearsal — 14 people in the 12 months to Oct 2026.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ⚠️ THE ONE DIRECTION THIS MUST NEVER GO
 * ──────────────────────────────────────────────────────────────────────────
 * A charge that is due THIS month must never move into NEXT month. Policy,
 * stated 2 Nov 2026: "It's better to refund people, than ask for money later
 * that should have been taken." So the deferral lands ON the term's first
 * billing date and never past it, and whenever that date is not later than
 * the legacy answer, the legacy answer is returned untouched.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY {First Term Anchor} COMES FROM AIRTABLE, NOT FROM A JS PARSE
 * ──────────────────────────────────────────────────────────────────────────
 * The initial charge (tier 3 of {Billing Anchor Rehearsals Left Multiplier})
 * decides "today < first term anchor → charge only the activation fee". The
 * deferral here must use the SAME date, or the two halves disagree and a
 * member gets a free month or pays twice. {First Term Anchor} is a verbatim
 * copy of tier 3's DATEADD, evaluated by Airtable's own parser, and
 * `npm run check:billing` fails the build if the copies ever differ.
 *
 * ⚠️ Fails to the LEGACY answer, never to a later one: a blank, malformed or
 * unreadable anchor means "no deferral". An unexpected later charge date
 * is exactly the failure the policy above forbids.
 */

/**
 * The pre-Nov-2026 calculation, UNCHANGED — including its use of the server's
 * local time (UTC on Vercel). Do not "tidy" it: `scripts/check-first-charge.mjs`
 * proves it identical to the original for every hour of two years.
 *
 * @param {string|number} billingDate  "1", "15", "1st", "15th"
 * @param {'Yes'|'No'|string} skipNextMonth
 * @param {Date} [now]
 * @returns {number} unix seconds
 */
export function legacyFirstCharge(billingDate, skipNextMonth, now = new Date()) {
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();

  const dayOfMonth = parseInt(String(billingDate).replace(/\D/g, ''));
  let chargeDate;
  if (currentDay > dayOfMonth || currentDay === dayOfMonth || skipNextMonth === 'Yes') {
    chargeDate = new Date(currentYear, currentMonth + 1, dayOfMonth);
  } else {
    chargeDate = new Date(currentYear, currentMonth, dayOfMonth);
  }
  // Stripe requires trial_end to be at least 48 hours in the future.
  const minTrialEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  if (chargeDate < minTrialEnd) {
    chargeDate = new Date(chargeDate.getFullYear(), chargeDate.getMonth() + 1, dayOfMonth);
  }
  return Math.floor(chargeDate.getTime() / 1000);
}

/**
 * `{First Term Anchor}` ("YYYY-MM-DD") → unix seconds at local midnight, the
 * same clock `legacyFirstCharge` builds its dates on, so the two compare
 * like for like. Anything else → null (= no deferral).
 */
export function parseTermAnchor(value) {
  const text = Array.isArray(value) ? value[0] : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  // Reject a date JS silently rolled over (e.g. 2027-02-30).
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return Math.floor(date.getTime() / 1000);
}

/**
 * Whole calendar months from one charge date to another (both on the same
 * day of the month by construction). Used to extend a repeating discount by
 * exactly as long as its first charge was deferred.
 */
export function monthsBetween(fromSeconds, toSeconds) {
  const a = new Date(fromSeconds * 1000), b = new Date(toSeconds * 1000);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/**
 * @param {object} p
 * @param {string|number} p.billingDate      "1" / "15"
 * @param {string} p.skipNextMonth           {Skip Next Month}
 * @param {string|string[]} [p.firstTermAnchor] {First Term Anchor}
 * @param {Date} [p.now]
 * @returns {{ trialEnd: number, legacy: number, deferredMonths: number }}
 */
export function firstChargeFor({ billingDate, skipNextMonth, firstTermAnchor, now = new Date() }) {
  const legacy = legacyFirstCharge(billingDate, skipNextMonth, now);
  const anchor = parseTermAnchor(firstTermAnchor);

  // Only ever LATER, and only ever TO the anchor — see the header.
  if (anchor === null || anchor <= legacy) return { trialEnd: legacy, legacy, deferredMonths: 0 };

  // The anchor is on the member's own billing day by construction ({First
  // Term Anchor} uses {Billing Anchor}). If it ever isn't, something upstream
  // is wrong — don't guess, charge on the legacy date.
  const day = parseInt(String(billingDate).replace(/\D/g, ''));
  if (new Date(anchor * 1000).getDate() !== day) return { trialEnd: legacy, legacy, deferredMonths: 0 };

  return { trialEnd: anchor, legacy, deferredMonths: monthsBetween(legacy, anchor) };
}
