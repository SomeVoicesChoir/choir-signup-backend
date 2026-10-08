/**
 * Validate a discount code. Called from the signup form as the member types.
 *
 * ⚠️ NOW QUERIES STRIPE, NOT THE AIRTABLE `Discount Codes` TABLE.
 *
 * It used to be a bare existence check against Airtable — no redemption count,
 * no expiry, no single-use — while CHECKOUT looked the same string up in
 * Stripe. Two sources of truth for one question, and they had drifted: 119 live
 * Stripe codes were rejected here, and 2 Airtable rows validated here then
 * applied nothing at checkout. See lib/discountCodes.js for the measurements.
 *
 * Both steps now call `resolveDiscountCode()`, so a code that passes here is a
 * code that WILL apply. That is the whole point of the change — the old failure
 * mode was a member sailing through validation and being charged in full.
 *
 * Returns `{ valid, describe, reason, message }`. `describe` is a human summary
 * ("100% off for 2 months") the form can show back, so somebody can see what
 * they are about to get rather than just a green tick.
 */

import { resolveDiscountCode } from '../../lib/discountCodes.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight support
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    const result = await resolveDiscountCode(code);

    if (!result.ok) {
      // 200 with valid:false, as before — an unrecognised code is an answer,
      // not a server error, and the form already reads it that way.
      return res.status(200).json({
        valid: false,
        reason: result.reason,
        message: result.message,
      });
    }

    return res.status(200).json({
      valid: true,
      code: result.code,
      describe: result.describe,
      percentOff: result.percentOff,
      amountOff: result.amountOff,
      currency: result.currency,
      duration: result.duration,
      durationInMonths: result.durationInMonths,
    });
  } catch (error) {
    console.error('Discount lookup error:', error);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
