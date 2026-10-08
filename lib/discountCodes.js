/**
 * Resolve a typed discount code against STRIPE — one definition, used by the
 * pre-check AND by checkout.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────────────────
 * Until now a code was validated against the Airtable `Discount Codes` table
 * and then APPLIED by looking it up in Stripe. Two different sources of truth
 * for one question, which goes wrong in both directions. Measured 8 Oct 2026:
 *
 *   · Airtable held 35 rows. Stripe held 100 coupons + 81 promotion codes.
 *   · 119 live Stripe codes were REJECTED at /join with "Discount Code Not
 *     Valid" — including 100OFF2MONTHS, 100OFF3MONTHS, 25TWOMONTHS, 1TERM100EU
 *     and 50RAMSGATE1TERM.
 *   · 2 Airtable rows had no Stripe counterpart, so they VALIDATED and then
 *     silently applied nothing: 104TENORE, and CLARECHAMBERLAINONLINE — which
 *     exists in Stripe as CL*AI*RECHAMBERLAINONLINE. One letter, split across
 *     two systems, and whichever spelling was on her letter, one of the two
 *     steps failed.
 *
 * Stripe is where a discount actually lives, so Stripe is the authority. The
 * table was double entry, and double entry drifts.
 *
 * The deeper fix is that the pre-check and the application now call the SAME
 * function. They could previously disagree, and when they did the member sailed
 * through validation and was charged in full with nobody told.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THREE BUGS THIS ALSO CLOSES
 * ──────────────────────────────────────────────────────────────────────────
 * 1. ⚠️ DUPLICATE PROMOTION CODES. `promotionCodes.list({ code, limit: 1 })`
 *    took data[0] and only then checked `.active`. Stripe allows several
 *    promotion codes with the same `code` string, and the live account has
 *    them: 25OXFORDFIRSTTERM exists 3× (all inactive) and
 *    50GARRYWALTONCOUPON 2× (one active, one not). So a valid code could
 *    silently do nothing depending on which object Stripe happened to return
 *    first. We now fetch ALL matches and pick a usable one.
 *
 * 2. ⚠️ THE COUPON-ID BYPASS. The old order was `coupons.retrieve(code)` FIRST,
 *    promotion codes second. A coupon ID typed directly skips the promotion
 *    code's `max_redemptions` and `expires_at` entirely — and the live account
 *    has guessable coupon IDs worth 100% off FOREVER with unlimited
 *    redemptions (100FREECOUPON, used 5×; 100BURCOUPON). Promotion codes are
 *    now tried FIRST, so when both exist the restricted one wins.
 *
 * 3. ⚠️ NO LIMITS WERE ENFORCED AT ALL. Airtable tracked no redemption count,
 *    no expiry and no single-use flag, so a code handed to one person worked
 *    for anyone who heard it, forever (100OFF2026 went to five members and has
 *    been redeemed three times). Stripe tracks all three, and we now read them.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 * ──────────────────────────────────────────────────────────────────────────
 * It does not FAIL OPEN. If Stripe is unreachable we refuse the code rather
 * than let the signup through at full price — being told "try again in a
 * moment" is recoverable; being silently charged £29 you were promised free is
 * the exact failure this file exists to end.
 */

import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

/**
 * ⚠️ THE CUSTOMER-FACING CODE IS OFTEN NOT THE NAME OF ANYTHING IN STRIPE.
 *
 * Measured 8 Oct 2026: of 35 Airtable rows, 20 have a `{Discount Code}` that
 * differs from their `{Stripe Coupon ID}` — 104TENORE → ey3d4WSw,
 * 100OFF2026 → XJzLIRaw, CLARECHAMBERLAINONLINE → 9PAyt73z.
 *
 * Mostly that is harmless: for 18 of the 20 the customer-facing string ALSO
 * exists in Stripe as a promotion code whose coupon is that opaque id, which is
 * just how Stripe models it (a promotion code and its coupon are two objects
 * with two names). Those resolve directly.
 *
 * But TWO have no promotion code at all — `104TENORE` and
 * `CLARECHAMBERLAINONLINE` — so the typed string resolves nowhere in Stripe and
 * the ONLY thing that knows what they mean is this Airtable row. Dropping the
 * table entirely would have retired two live customer-facing codes.
 *
 * So Airtable stays as an ALIAS TABLE: it answers "what does this code mean",
 * never "is this code valid". Stripe keeps the final say on validity.
 */
const ALIAS_TABLE = 'Discount Codes';

/**
 * Every DEFINITIVE refusal ends with this.
 *
 * A code that doesn't work is nearly always a real person holding a real offer
 * — a gift someone bought them, a discount they were promised — and the thing
 * they need is a way to reach us, not a dead end. It is deliberately NOT added
 * to the transient "try again in a moment" message, where emailing us would be
 * the wrong advice.
 */
const CONTACT = "Email sing@somevoices.co.uk if you think that's wrong and we'll sort it out.";

/**
 * Resolve a customer-facing code to a Stripe id via the Airtable alias row.
 *
 * Returns `{ stripeId }`, `null` when there is no usable row, or
 * `{ unavailable: true }` when Airtable could not be reached — which the caller
 * must NOT treat as "no such code", because it isn't an answer.
 *
 * ⚠️ Honours `{Current / Retired}`. For a DIRECT Stripe match, Stripe's own
 * active/valid flags govern and this table is never consulted. But an alias
 * exists only by virtue of its row, so a row marked Retired retires the alias —
 * even if the underlying coupon is still live in Stripe.
 */
async function resolveAlias(code) {
  try {
    const safe = code.replace(/'/g, "\\'");
    const records = await base(ALIAS_TABLE)
      .select({
        filterByFormula: `LOWER(TRIM({Discount Code})) = '${safe.toLowerCase()}'`,
        maxRecords: 2,
      })
      .firstPage();

    if (!records.length) return null;

    const row = records.find((r) => String(r.fields['Current / Retired'] || '') !== 'Retired') || records[0];
    if (String(row.fields['Current / Retired'] || '') === 'Retired') {
      return { retired: true };
    }

    const stripeId = String(row.fields['Stripe Coupon ID'] || '').trim();
    return stripeId ? { stripeId } : null;
  } catch (err) {
    console.error('[discount] alias lookup failed:', err.message);
    return { unavailable: true };
  }
}

/** Is this promotion code usable right now? */
function promotionCodeUsable(p) {
  if (!p?.active) return false;
  if (p.coupon?.valid === false) return false;
  if (p.expires_at && p.expires_at * 1000 < Date.now()) return false;
  if (p.max_redemptions != null && p.times_redeemed >= p.max_redemptions) return false;
  return true;
}

/** …and the same question for a bare coupon. */
function couponUsable(c) {
  if (!c) return false;
  // `valid` already folds in redeem_by and max_redemptions, but they are
  // checked explicitly too: `valid` is computed by Stripe and a future change
  // to what it covers should not quietly widen what we accept.
  if (c.valid === false) return false;
  if (c.redeem_by && c.redeem_by * 1000 < Date.now()) return false;
  if (c.max_redemptions != null && c.times_redeemed >= c.max_redemptions) return false;
  return true;
}

function describe(coupon) {
  const amount = coupon.percent_off != null
    ? `${coupon.percent_off}% off`
    : `${((coupon.amount_off || 0) / 100).toFixed(2)} ${String(coupon.currency || '').toUpperCase()} off`;
  const span = coupon.duration === 'repeating'
    ? `for ${coupon.duration_in_months} month${coupon.duration_in_months === 1 ? '' : 's'}`
    : coupon.duration;
  return `${amount} ${span}`;
}

/**
 * Try a literal string against Stripe: promotion codes first, then coupons.
 *
 * Promotion codes first is deliberate — a promotion code carries the limits
 * (single use, expiry, redemption cap) and its underlying coupon does not, so
 * looking up the coupon first let someone bypass all of them by typing the
 * coupon's id.
 *
 * Returns a success shape, or `{ ok: false, reason, message }` where reason
 * `not_found` means "nothing in Stripe is called this" — which is the caller's
 * cue to try the alias table.
 */
async function resolveStripeString(code, { via = null } = {}) {
  let promoMatches = [];
  try {
    // No `limit: 1` — duplicates exist (25OXFORDFIRSTTERM three times,
    // 50GARRYWALTONCOUPON twice), so take every match and choose a usable one
    // rather than letting Stripe's ordering decide whether a code works.
    const list = await stripe.promotionCodes.list({ code, limit: 100 });
    promoMatches = list.data || [];
  } catch (err) {
    console.error('[discount] promotionCodes.list failed:', err.message);
    return { ok: false, reason: 'stripe_error', message: "We couldn't check that code just now. Please try again in a moment." };
  }

  if (promoMatches.length) {
    const usable = promoMatches.find(promotionCodeUsable);
    if (usable) {
      return {
        ok: true,
        kind: 'promotion_code',
        discount: { promotion_code: usable.id },
        code: usable.code,
        couponId: usable.coupon.id,
        via,
        describe: describe(usable.coupon),
        percentOff: usable.coupon.percent_off ?? null,
        amountOff: usable.coupon.amount_off ?? null,
        currency: usable.coupon.currency || null,
        duration: usable.coupon.duration,
        durationInMonths: usable.coupon.duration_in_months ?? null,
      };
    }
    // Matches exist but none usable — say WHY, because "not valid" sends
    // somebody hunting for a typo in a code they typed correctly.
    const anyUsedUp = promoMatches.some((p) => p.max_redemptions != null && p.times_redeemed >= p.max_redemptions);
    const anyExpired = promoMatches.some((p) => p.expires_at && p.expires_at * 1000 < Date.now());
    if (anyUsedUp) return { ok: false, reason: 'used_up', message: `That code has already been used. ${CONTACT}` };
    if (anyExpired) return { ok: false, reason: 'expired', message: `That code has expired. ${CONTACT}` };
    return { ok: false, reason: 'inactive', message: `That code is no longer active. ${CONTACT}` };
  }

  let coupon;
  try {
    coupon = await stripe.coupons.retrieve(code);
  } catch (err) {
    if (err?.statusCode === 404 || err?.raw?.code === 'resource_missing') {
      return { ok: false, reason: 'not_found', message: `We can't find that code. ${CONTACT}` };
    }
    console.error('[discount] coupons.retrieve failed:', err.message);
    return { ok: false, reason: 'stripe_error', message: "We couldn't check that code just now. Please try again in a moment." };
  }

  if (!couponUsable(coupon)) {
    const usedUp = coupon.max_redemptions != null && coupon.times_redeemed >= coupon.max_redemptions;
    const expired = coupon.redeem_by && coupon.redeem_by * 1000 < Date.now();
    return {
      ok: false,
      reason: usedUp ? 'used_up' : expired ? 'expired' : 'inactive',
      message: usedUp
        ? `That code has already been used. ${CONTACT}`
        : expired ? `That code has expired. ${CONTACT}` : `That code is no longer active. ${CONTACT}`,
    };
  }

  return {
    ok: true,
    kind: 'coupon',
    discount: { coupon: coupon.id },
    code: coupon.id,
    couponId: coupon.id,
    via,
    describe: describe(coupon),
    percentOff: coupon.percent_off ?? null,
    amountOff: coupon.amount_off ?? null,
    currency: coupon.currency || null,
    duration: coupon.duration,
    durationInMonths: coupon.duration_in_months ?? null,
  };
}

/**
 * Resolve a code the member typed into something Checkout can apply.
 *
 * Three steps, in this order:
 *   1. the typed string as a Stripe PROMOTION CODE   (covers 33 of 35 live codes)
 *   2. the typed string as a Stripe COUPON id
 *   3. the typed string as an ALIAS in Airtable → its {Stripe Coupon ID} → Stripe
 *      (covers 104TENORE and CLARECHAMBERLAINONLINE, which exist nowhere in
 *      Stripe under the name the customer was given)
 *
 * Stripe always has the final say on whether the thing it resolves to is
 * usable. Airtable only ever answers "what does this code mean".
 *
 * Returns on success:
 *   { ok: true, kind, discount, code, couponId, via, describe, percentOff,
 *     amountOff, currency, duration, durationInMonths }
 * where `discount` drops straight into a Checkout Session's `discounts` array
 * and `via` names the alias row when one was used (for logging).
 *
 * On failure: `{ ok: false, reason, message }`, reason one of
 * `empty` · `not_found` · `inactive` · `expired` · `used_up` · `stripe_error`.
 * `message` is member-facing copy.
 */
export async function resolveDiscountCode(rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return { ok: false, reason: 'empty', message: 'No code given.' };

  const direct = await resolveStripeString(code);

  // Anything other than "Stripe has never heard of this string" is a real
  // answer — don't go looking for an alias to contradict it.
  if (direct.ok || direct.reason !== 'not_found') return direct;

  const alias = await resolveAlias(code);

  if (alias?.unavailable) {
    // We know the typed string isn't in Stripe and we couldn't read the alias
    // table, so we genuinely don't know. FAIL CLOSED with a retry rather than
    // telling somebody their valid code doesn't exist.
    return { ok: false, reason: 'stripe_error', message: "We couldn't check that code just now. Please try again in a moment." };
  }
  if (alias?.retired) {
    return { ok: false, reason: 'inactive', message: `That code is no longer active. ${CONTACT}` };
  }
  if (!alias?.stripeId) return direct; // genuinely unknown

  const viaAlias = await resolveStripeString(alias.stripeId, { via: code });

  // If the alias points at something Stripe doesn't have either, the row is
  // stale (25WINMOLLYN100 → an6WTcIP is in exactly this state). Report it as
  // unrecognised to the member, but log it loudly — it is a data problem.
  if (!viaAlias.ok && viaAlias.reason === 'not_found') {
    console.error(`[discount] alias "${code}" points at "${alias.stripeId}", which is not in Stripe — stale Airtable row`);
  }
  return viaAlias;
}
