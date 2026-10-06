# Some Voices Choir Signup Backend - Claude Context

## Project Overview
Next.js API backend for the Some Voices choir membership signup flow. Handles Airtable record creation, Stripe checkout/subscription creation, and webhook processing. The frontend is an HTML form embedded on the Squarespace site (somevoices.co.uk).

**Backend URL:** https://choir-signup-backend-atuj.vercel.app
**Website:** https://somevoices.co.uk
**Deployment:** Vercel (auto-deploys on push to main)

---

## Tech Stack
- **Framework:** Next.js (Pages Router, API routes only)
- **Database:** Airtable (via `airtable` npm package)
- **Payments:** Stripe (`stripe` npm package)
- **Frontend:** Static HTML form (`index.html`) embedded in Squarespace via code injection

---

## Signup Flow (Active)

The current active flow uses **subscription-first checkout** via `create-subscription-first.js`:

```
1. User enters email on Squarespace form
   → POST /api/lookup-email (checks Members table for existing member)

2. User fills form (name, choir, voice part, billing date, discount code)
   → POST /api/create-airtable-record-step1 (creates Signup Queue record)

3. Frontend calls POST /api/create-subscription-first
   → Reads Signup Queue record for pro-rata amount, price ID, currency
   → Creates/finds Stripe customer
   → Creates Stripe Checkout session (subscription mode) with:
     - Recurring subscription line item (price ID from Airtable)
     - One-time initial payment line item (pro-rata amount from Airtable)
     - trial_end set to billing anchor date (defers first subscription charge)
     - Discount/coupon if provided

4. User completes payment on Stripe Checkout
   → Redirected to somevoices.co.uk/success
```

### Legacy Flow (create-initial-checkout → create-success-subscription)
An older two-step flow exists but is **not called by the current frontend**:
- `create-initial-checkout.js` — payment-mode checkout for pro-rata only
- `create-success-subscription.js` — called on success URL redirect, creates subscription separately
- Both files still contain the `getBillingAnchorTimestamp` function and should be kept in sync

---

## Critical: Billing Anchor & Trial Period Logic

### How It Works

Two independent questions are answered at checkout:

**Question 1: How much does the customer pay today?** (initial payment — calculated by Airtable)

Some Voices runs three terms per year with fixed billing months:

| Term | Billing months | When week 1 can fall |
|---|---|---|
| Spring | Jan / Feb / Mar / Apr | Always in January |
| Summer | May / Jun / Jul / Aug | Late April OR early-mid May |
| Winter | Sep / Oct / Nov / Dec | Always in September |

April is the only month that can spill back (Summer rehearsals starting late April before May 1 billing). A full term costs £29 × 4 + £1 activation = £117. The customer pays one initial transaction today (membership portion + £1 activation), then £29 on each remaining anchor day for the rest of the term.

The multiplier formula is a **5-tier waterfall**:

```
{Billing Anchor Rehearsals Left Multiplier}

1. {week 1 date} blank?              → 0  (no choir linked — just £1 activation)
2. {Will Push to Next Month} = Yes?  → 1  (48-hr Stripe trial bump fires)
3. TODAY < first term anchor?        → 0  (term billing hasn't started yet —
                                            anchors will cover all rehearsals)
4. TODAY < {week 1 date}?            → 1  (term started, customer missed
                                            first anchor day, but no rehearsals
                                            yet missed — pay one full month)
5. Otherwise (post-week-1)           → SWITCH on Rehearsals to 1st/15th:
                                          0 → 0, 1 → 0.25, 2 → 0.5,
                                          3 → 0.75, 4+ → 1
        ↓
{Total Cost Initial Invoice}        ← (Monthly price × multiplier)
                                       + 100 pence (£1 activation, one-time)
                                       (minus discount if applicable)
```

**First term anchor** = 1st (or 15th, per `{Billing Anchor}`) of the first billing month of the term. Derived from `{week 1 date}`:

```
IF MONTH(week 1) = April → next month (May 1 or May 15)
Otherwise               → same month as week 1
```

This is hard-coded to the business rule: only Summer term spills back; Spring and Winter always start in their billing-anchor month.

**Why 5 tiers, not just the SWITCH:** Each tier guards against a specific failure mode the simpler "always pro-rata" model would hit. See the May 11 session log for the audit trail.

⚠️ **The taster credit is an adjustment to the REHEARSAL COUNT, never a sixth tier.** A branch
called "4.5 first month — taster deducted" sat between tiers 4 and 5 from some point after
May 11 until Oct 6 2026. Its purpose was right — people who attend a taster and then sign up
that same evening were being charged for the rehearsal they had just done — but as a tier it
could not work, for two independent reasons:

1. **It was below tier 4, so it never fired for its own use case.** `TODAY()` is midnight, so
   `TODAY() < {week 1 date}` (19:00) is true *all day* on week-1 day, including at 20:46 after
   the rehearsal. Tier 4 catches those signups first and charges a flat full month. Only 21 of
   244 tier-4.5 records had a taster that day; 72 people who did have one sat in tier 4.
2. **It had no taster input.** Its only references were `{week 1 date}`, `{Will Push}`,
   `{Billing Anchor}` and the two rehearsal counts, so it approximated a taster with
   `MAX(0, 1 - (FLOOR(days since week 1 / 7) + 1) / 4)` — weeks elapsed since week 1. That
   replaced the rehearsals-remaining basis wholesale and overcharged 192 members
   (£1,392.00 + €367.50). `{Link *Tasters}` is still an empty `singleLineText`: the input half
   of that work was started and never finished.

So the credit belongs **inside** `{Rehearsals to 1st}`/`{Rehearsals to 15th}` — subtract tonight's
rehearsal when a Taster row exists for this email, at this choir, dated today — and that same
condition disqualifies tier 4, because having done tonight's rehearsal is what makes someone
post-week-1 in substance. ⚠️ Key off the taster **booking date, never `{Attended}`**: it is blank
on all 2,419 Sign-Up Form rows because marking lags.

The `Tier at Signup` single-select keeps the "4.5" option because 244 historical records
reference it; nothing should write it again. `npm run check:billing` fails the build if the
weeks-elapsed shape returns.

**Question 2: When does the first subscription invoice land?** (trial_end — calculated by Airtable + code)

```
{Next Rehearsal Date (from Choir)}      ← Raw lookup: date or "Not yet booked"
        ↓
{Next Rehearsal Date}                   ← Parsed to YYYY-MM-DD (or "" if invalid)
        ↓
{Next Billing Date (Before Push)}       ← Next 1st or 15th based on billing anchor
        ↓
{Days Until Billing}                    ← DATETIME_DIFF to TODAY() in days
        ↓
{Will Push to Next Month}              ← < 3 days? → "Yes" (too close for Stripe)
        ↓
{Skip Next Month}                      ← Also "Yes" if date is blank/out of range
        ↓
getBillingAnchorTimestamp() [CODE]      ← Calculates the trial_end timestamp
                                          If Skip Next Month = Yes → +1 month
                                          If still < 48hrs → +1 more month
```

**The golden rule:** Both paths must agree. If the code pushes the first invoice further out, Airtable must charge enough in the initial payment to cover that period. The `< 3` day threshold in Airtable and the 48-hour check in code are aligned to ensure this.

### The 48-Hour Edge Case (Fixed April 2026)
**Stripe requires `trial_end` to be at least 48 hours in the future.**

When a customer signs up close to their billing anchor (e.g. April 30th with anchor = 1st), the trial would be < 48 hours and Stripe would reject the API call.

**Code fix** (`getBillingAnchorTimestamp` in both `create-subscription-first.js` and `create-success-subscription.js`):
```javascript
// After computing billingDate...
const minTrialEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);
if (billingDate < minTrialEnd) {
  billingDate = new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, dayOfMonth);
}
```

**Airtable alignment** — the `Will Push to Next Month` formula must use `< 3` (not `< 2`):
```
IF({Days Until Billing} < 3, "Yes", "No")
```
This is because `Days Until Billing` uses `DATETIME_DIFF(..., TODAY(), 'days')` where `TODAY()` is midnight — 2 calendar days could be as few as 24 actual hours depending on checkout time.

**Both systems must agree:** if the code bumps the anchor to next month, Airtable's pro-rata must also cover that extra period. The `< 3` threshold ensures Airtable always charges the extra month whenever the code might bump.

### Key Airtable Fields (Signup Queue table)
| Field | Purpose |
|-------|---------|
| `Billing Anchor` | "1" or "15" — user's chosen billing date |
| `Skip Next Month` | "Yes"/"No" — set by `Will Push to Next Month` formula |
| `Days Until Billing` | `DATETIME_DIFF({Next Billing Date (Before Push)}, TODAY(), 'days')` |
| `Will Push to Next Month` | `IF({Days Until Billing} < 3, "Yes", "No")` |
| `Billing Anchor Rehearsals Left Multiplier` | 0 / 0.25 / 0.5 / 0.75 / 1 — see "How It Works" for the 5-tier waterfall logic |
| `Total Cost Initial Invoice` | Pro-rata amount in pence (includes +100 for £1 activation fee) |
| `Stripe PRICE_ID` | Recurring subscription price ID (lookup from Choir) |
| `Stripe Customer ID` | Stripe customer ID (created or found during checkout) |
| `Initial Payment Description` | Description shown on Stripe invoice |

---

## API Routes

### Active (used by current frontend)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/lookup-email` | POST | Check if email exists in Members table, return existing details |
| `/api/get-choirs` | GET | Fetch choirs from `Choirs MASTER` table (view: `Choir CURRENT (SqSp Signup)`) |
| `/api/get-voice-parts` | GET | Fetch voice parts from `Voice Parts` table |
| `/api/check-discount-code` | POST | Validate discount code exists in `Discount Codes` table |
| `/api/create-airtable-record-step1` | POST | Create record in `Signup Queue` table (links discount code by record ID) |
| `/api/create-subscription-first` | POST | Create Stripe Checkout session (subscription mode with initial payment) |
| `/api/stripe-webhook` | POST | Handle `checkout.session.completed` and `invoice.created` events |

### Supporting / Legacy
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/create-initial-checkout` | POST | Legacy: payment-mode checkout for pro-rata only |
| `/api/create-success-subscription` | GET | Legacy: creates subscription after initial payment success |
| `/api/initial-payment` | GET/POST | Legacy: charge initial payment after subscription creation |
| `/api/create-initial-invoice` | POST | Legacy: create invoice for initial payment |
| `/api/get-signup-record` | GET | Fetch Signup Queue record (used for polling readiness) |
| `/api/get-discount-id` | POST | Get Airtable record ID for a discount code |
| `/api/start-signup` | POST | Legacy: combined record creation + checkout |
| `/api/create-checkout-session` | POST | Legacy: unified checkout session |
| `/api/airtable-sqsp` | GET | Airtable proxy for Squarespace (uses separate API key `AIRTABLE_API_KEY_SQSP`) |

---

## Stripe Webhook (`stripe-webhook.js`)

Handles two event types:

### `checkout.session.completed` (payment mode only)
1. Updates Signup Queue with Stripe Customer ID and payment status
2. Creates subscription with `billing_cycle_anchor`
3. Updates/creates Customer Record in Airtable
4. Updates/creates Members record (links choir)
5. Writes webhook report to Signup Queue record

### `invoice.created`
1. Retrieves customer details from Stripe (name, phone, address)
2. Updates/creates Customer Record with contact details
3. Creates record in `Stripe Invoices` table
4. Updates/creates Members record

---

## Environment Variables
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
AIRTABLE_API_KEY=pat...           # Main API key for signup tables
AIRTABLE_API_KEY_SQSP=pat...      # Separate key for Squarespace proxy
AIRTABLE_BASE_ID=app...           # Main base ID
APP_URL=https://choir-signup-backend-atuj.vercel.app
```

---

## Airtable Tables Referenced
| Table | Base | Used By |
|-------|------|---------|
| `Signup Queue` | Main | Record creation, checkout, webhook |
| `Members` | Main | Email lookup, member creation/update |
| `Customer Record` | Main | Stripe customer tracking |
| `Stripe Invoices` | Main | Invoice logging |
| `Choirs MASTER` | Main | Choir list for signup form |
| `Voice Parts` | Main | Voice part options |
| `Discount Codes` | Main | Discount validation |

---

## Frontend (`index.html`)

Static HTML form embedded in Squarespace. Key features:
- Email check step (pre-fills returning member details)
- Searchable choir dropdown
- EUR/GBP currency support (shows iDEAL info for EUR)
- Discount code validation
- Terms & Conditions scroll-to-agree
- Loading overlay during API calls
- Calls `create-subscription-first` flow (not the legacy flow)

**Note:** The frontend in this repo (`index.html`) may differ from what's actually embedded in Squarespace. The Squarespace version includes the searchable choir dropdown; the repo version has the basic `<select>`.

---

## Multi-Currency Support
- **GBP:** Card payments only
- **EUR:** Card + iDEAL on Stripe Checkout; recurring payments forced to card
- Currency determined by choir selection (from `Stripe 'default_price_data[currency]'` field)

---

## Git Workflow
- **Main Branch:** `main`
- **Deployment:** Automatic via Vercel on push to main

---

## Never Do This
- **Edit any billing formula in Airtable without re-approving the snapshot.** The formulas are
  the only part of the billing mechanism with no git history, no diff and no review — which is
  exactly how tier 4.5 got in and overcharged 192 members for a whole term (see the Oct 6 2026
  log). Guarded by `npm run check:billing`, which runs on `prebuild`: it compares the live
  formulas to `scripts/billing-formulas.approved.json` and fails the build on any unapproved
  change. A deliberate change means audit the pricing first, then
  `npm run check:billing -- --update`, then commit the diff **and** update the waterfall above.
  `--update` refuses to bless a formula that breaks one of the invariants.
- **Express "don't charge them for rehearsal X" as a new tier.** It belongs in
  `{Rehearsals to 1st}` / `{Rehearsals to 15th}` — the count of what they are paying for — not as
  a branch in front of the pro-rata SWITCH. Every branch added ahead of tier 5 has disabled
  tier 5 for an entire cohort: Apr 7 2026 (new-term guard → £1 floor all May), May 11 2026
  (the `DAY > 1` boundary), Oct 6 2026 (tier 4.5). A tier answers *which rule applies*; a count
  answers *how much*. Conflating them is this formula's recurring failure.
- **Forget that `TODAY()` is midnight.** Every tier boundary that compares against a rehearsal
  datetime is therefore true for the whole of that day, evening rehearsals included. That is
  how tier 4 ends up charging a full month to someone who signed up at 20:46 after attending
  week 1, and why tier 4.5 never fired. The May 11 log listed this as an acceptable
  imperfection; it was the entire taster leak.
- Change `Will Push to Next Month` threshold without also checking the 48-hour code logic in `getBillingAnchorTimestamp`
- Change `getBillingAnchorTimestamp` without checking Airtable's pro-rata formula alignment
- Modify `stripe-webhook.js` body parser config (must be `bodyParser: false` for signature verification)
- Commit environment variables or API keys
- Delete legacy API routes without checking if other systems still call them

---

## Session Log: April 1, 2026

### What We Fixed

**Stripe 48-Hour Trial Minimum Edge Case:**
- Customers signing up within 48 hours of their billing anchor (e.g. April 30th with anchor = 1st) were getting Stripe errors because `trial_end` was too close
- Added 48-hour safety check to `getBillingAnchorTimestamp()` in both `create-subscription-first.js` and `create-success-subscription.js`
- When computed anchor is < 48 hours away, bumps to next month's anchor date
- Aligned Airtable `Will Push to Next Month` formula from `< 2` to `< 3` days to match (because `Days Until Billing` uses `TODAY()` which is midnight, so 2 calendar days could be < 48 actual hours)

### Key Decision
| Decision | Reason |
|----------|--------|
| Fix in code, not Airtable | The 48-hour limit is a Stripe API constraint checked at checkout time; Airtable doesn't know what time the customer checks out |
| `< 3` in Airtable (not `< 2`) | `DATETIME_DIFF(..., TODAY(), 'days')` rounds to whole days from midnight; 2 days could be only 24 hours if checkout is late evening |
| Both systems must agree | Code bumps anchor → Airtable must charge extra month in pro-rata to prevent free month |

### Files Modified
- `pages/api/create-subscription-first.js` — Added 48-hour check to `getBillingAnchorTimestamp`
- `pages/api/create-success-subscription.js` — Same fix (duplicate function)

### Airtable Change (Manual)
- `Will Push to Next Month` formula: `IF({Days Until Billing} < 3, "Yes", "No")`

---

## Session Log: April 3, 2026

### What We Fixed

**500 Errors on Certain Choirs — Airtable `#ERROR!` Cascading to Stripe:**
- Some choirs caused `create-subscription-first` to return 500: `Invalid string: {:error=>"#ERROR!"}`
- Root cause: Airtable formula fields returned `#ERROR!` when `{Next Rehearsal Date (from Choir)}` was "Not yet booked" or blank, and that error string was passed directly to Stripe
- Fixed multiple formula fields to handle blank/invalid dates gracefully:

**1. `{Next Rehearsal Date}` formula:**
- Was: `DATETIME_FORMAT(DATETIME_PARSE(...), "YYYY-MM-DD")` — errored on "Not yet booked"
- Fix: Wrapped in `IF()` that checks for empty and "Not yet booked", returns `""` instead

**2. `{Skip Next Month}` formula:**
- Was: Used `DATETIME_FORMAT({Next Rehearsal Date}, ...)` directly — errored when date was blank
- Fix: Airtable evaluates both branches of `OR()` even if first is true, so moved the blank check into a separate outer `IF()` — date functions only run when field has a value

**3. `{Billing Anchor Rehearsals Left Multiplier}` — New Term Pro-Rata Fix:**
- **Problem:** Members signing up at the start of a new term (Jan/May/Sep) were double-charged — pro-rata for rehearsals before the anchor PLUS the full monthly payment on the anchor date
- Example: Sign up Jan 2nd, anchor = 15th → paid £7.25 pro-rata + £29 on Jan 15th = £36.25 (should be max £29)
- **Additional complexity:** Summer term rehearsals sometimes start in late April, but first full payment should be May
- **Fix:** Added `{week 1 date}` lookup check — if today is before the first billing anchor on/after the term's first rehearsal, multiplier = 0 (just £1 activation fee, first full payment on anchor)
- Logic: parse `{week 1 date}`, find the 1st/15th of that month (or next month if week 1 falls after the anchor day), compare against TODAY()

### Key Decisions

| Decision | Reason |
|----------|--------|
| Nested `IF()` instead of `OR()` for blank checks | Airtable evaluates all branches of `OR()` — `DATETIME_FORMAT` on blank still errors even if first condition is true |
| `{week 1 date}` for term boundary detection | Available as lookup on Signup Queue; more reliable than hardcoding months since summer term can start in April |
| Multiplier = 0 for new term signups (not "skip" flag) | The 4 monthly payments from the anchor already cover the full term; pro-rata is only for mid-term joins |
| Empty `{week 1 date}` → multiplier 0 | No term data = no rehearsals to charge for; just take £1 activation |

### Issues Encountered / Workarounds

**Airtable `OR()` eagerly evaluates all branches:**
- First attempt at `{Skip Next Month}` fix used `OR({Next Rehearsal Date} = "", NOT(DATETIME_FORMAT(...)))` — still errored because Airtable evaluates the `DATETIME_FORMAT` branch even when the first condition is true
- Fix: Nested `IF()` so date functions are only reached when the field has a value

**`#ERROR!` cascade:**
- One broken formula field (`{Next Rehearsal Date}`) cascaded errors into `{Skip Next Month}`, `{Days Until Billing}`, `{Billing Anchor Rehearsals Left Multiplier}`, and `{Total Cost Initial Invoice}` — all of which feed into the Stripe checkout call
- All downstream formulas now handle blank inputs gracefully

### Airtable Formula Changes (Manual)

**`{Next Rehearsal Date}`:**
```
IF(
  AND(
    {Next Rehearsal Date (from Choir)} != "",
    {Next Rehearsal Date (from Choir)} != "Not yet booked"
  ),
  DATETIME_FORMAT(
    DATETIME_PARSE(ARRAYJOIN({Next Rehearsal Date (from Choir)}, "")),
    "YYYY-MM-DD"
  ),
  ""
)
```

**`{Skip Next Month}`:**
```
IF(
  OR(
    {Next Rehearsal Date} = "",
    {Next Rehearsal Date} = BLANK()
  ),
  "Yes",
  IF(
    NOT(
      OR(
        DATETIME_FORMAT({Next Rehearsal Date}, 'YYYY-MM') = DATETIME_FORMAT(TODAY(), 'YYYY-MM'),
        DATETIME_FORMAT({Next Rehearsal Date}, 'YYYY-MM') = DATETIME_FORMAT(DATEADD(TODAY(), 1, 'month'), 'YYYY-MM')
      )
    ),
    "Yes",
    "No"
  )
)
```

**`{Billing Anchor Rehearsals Left Multiplier}`:**
- Added `{week 1 date}` blank check at top (returns 0)
- Added new-term check: if today < first billing anchor on/after `{week 1 date}`, returns 0
- Otherwise falls through to existing rehearsal-count SWITCH logic

### What's Next / Where We Left Off

- All `#ERROR!` formula cascades fixed — choirs with "Not yet booked" or blank rehearsal dates can now sign up
- New term pro-rata fix deployed — members joining at term start pay £1 activation only, first full payment on anchor
- One choir currently showing "push to next month" — likely correct behaviour due to blank `{Next Rehearsal Date}`, needs verification
- May need to verify `{Rehearsals to 1st}` and `{Rehearsals to 15th}` also handle blank dates gracefully

---

## Session Log: April 7, 2026

### What We Fixed

**New-Term Signup + 48-Hour Bump = Free Month:**
- A customer signed up April 30th with anchor = 1st
- New-term multiplier returned 0 (just £1 activation) — correct for new term
- Code bumped trial_end from May 1st to June 1st (< 48 hours) — correct for Stripe
- **Result:** Customer paid £1, first subscription invoice June 1st — May was free

**Root cause:** The new-term multiplier (0) and the 48-hour bump (push to next month) are independent systems that weren't talking to each other. When both fire, the multiplier needs to be 1, not 0, so the initial payment includes the first month's charge.

### Fix Applied

**`{Billing Anchor Rehearsals Left Multiplier}` — Airtable formula update:**
- Changed the new-term return value from `0` to `IF({Will Push to Next Month} = "Yes", 1, 0)`
- Both anchor branches (1st and 15th) updated

**Logic:**
- New term + anchor far enough away → multiplier = 0 (£1 activation, first payment on anchor) ✓
- New term + anchor too close (will be bumped) → multiplier = 1 (£29 + £1 today, subscription starts month after) ✓
- Mid-term → existing rehearsal-count logic unchanged ✓

**Verification (April 30th, anchor = 1st):**
- Multiplier = 1 → initial charge = £29 + £1 = £30
- Code bumps trial_end to June 1st
- Subscription: Jun 1 (£29), Jul 1 (£29), Aug 1 (£29)
- Total: £30 + £87 = £117 = £116 term + £1 activation ✓

### Key Decisions

| Decision | Reason |
|----------|--------|
| Fix in Airtable formula (not code) | The multiplier controls the charge amount; code only controls timing. When timing shifts, the charge must compensate |
| `IF({Will Push to Next Month} = "Yes", 1, 0)` not just `1` | Most new-term signups (> 3 days before anchor) should still pay £1 only — the bump case is the exception |

### What's Next / Where We Left Off

- All edge cases now covered: new-term, mid-term, close-to-anchor, and new-term-close-to-anchor
- No code changes this session — fix was entirely in Airtable formula
- The "golden rule" still holds: if the code pushes the invoice further, Airtable charges more upfront to compensate

---

## Session Log: May 11, 2026

### What We Fixed

**Saturday Soho member undercharged ~£21:**
- Member signed up 2026-05-03 12:23pm (Sat Soho, billing anchor 1st, week 1 date = May 2 13:00)
- Charged £1 today (activation only) — should have been £22.75 (£21.75 pro-rata for 3 remaining May rehearsals + £1 activation)
- They missed week 1 (May 2) but `{Billing Anchor Rehearsals Left Multiplier}` returned 0, so the partial May was effectively free — paying ~£89 total for the term instead of ~£109.75

### Root Cause — Doctrine + Boundary Bug

The April 7 fix added an outer `IF(TODAY() < anchor_threshold, ...)` guard to the multiplier formula. The `anchor_threshold` was derived with `IF(DAY(week 1) > 1, add 1 month, add 0)` — meaning **any week 1 not on the literal 1st of the month** had its threshold pushed forward by a month.

For Sat Soho (week 1 = May 2): `anchor_threshold` became May 1 + 1 month = **June 1**. TODAY (May 3) < June 1 → guard fired → multiplier 0 → £1 floor. The pro-rata SWITCH was never reached for any signup in May before June 1.

The April 7 narrative framed this as "no pro-rata for new-term signups" — but the formula didn't actually distinguish "new term" from "post-week-1 mid-month join." Both cases hit the same `0` branch. The bug was invisible while testing because the canonical April 30 + May 1 anchor case triggered the `Will Push` override and returned 1 anyway, masking the broken pre-anchor path for everyone else.

### The Real Model

Three terms with fixed billing months:

- **Spring** — Jan / Feb / Mar / Apr (always starts in January)
- **Summer** — May / Jun / Jul / Aug (week 1 can be late April OR early-mid May)
- **Winter** — Sep / Oct / Nov / Dec (always starts in September)

April is the **only** month that can spill back into the previous month. A full-term member pays £29 × 4 + £1 activation = £117. The £1 activation is one-time on the initial transaction only — subsequent monthly Stripe anchor charges are £29 flat.

The right multiplier rule is a **5-tier waterfall**:

| Tier | Condition | Multiplier | Why |
|---|---|---|---|
| 1 | `{week 1 date}` blank | 0 | No choir linked — just £1 activation |
| 2 | `{Will Push to Next Month} = "Yes"` | 1 | 48-hr Stripe trial bump fires — initial must cover the bumped month |
| 3 | `TODAY()` < first term anchor | 0 | Term billing hasn't started — anchors will cover all rehearsals |
| 4 | `TODAY()` < `{week 1 date}` | 1 | Term billing has started, customer missed first anchor day, but no rehearsals yet missed — pay one full month upfront |
| 5 | `TODAY()` ≥ `{week 1 date}` | SWITCH on rehearsals | Customer has missed at least week 1 — pro-rata for remaining rehearsals |

**First term anchor** = 1st (or 15th, per `{Billing Anchor}`) of the first billing month of the term:

```
IF MONTH(week 1) = April → next month (May 1 or May 15)
Otherwise               → same month as week 1
```

`MONTH(week 1) = 4` is the hard-coded business rule: only Summer can spill back.

### Fix Applied

**`{Billing Anchor Rehearsals Left Multiplier}` — full rewrite as 5-tier waterfall:**

Three structural changes vs the April 7 formula:

1. **Replaced** `DAY > 1` with `MONTH = April` in the first-term-anchor derivation — fixes Sat Soho (week 1 = May 2) and any future May/early-month week 1.
2. **Added tier 4** ("between first term anchor and week 1 → multiplier 1") — fixes the Winter Sep 5 scenario where customer signs up between the Sep 1 anchor and Sep 17 week 1.
3. **Moved Will Push override to the top** — fixes the latent "mid-term + 48-hr bump + 0 rehearsals to anchor" bug where the old SWITCH path would return 0 (free month) even when Will Push was firing.

The full formula is committed in Airtable.

### Verification

All cash totals shown include the £1 activation fee on the initial transaction (one-time).

| # | Scenario | Multiplier | Today (£) | Future anchors | Term total |
|---|---|---|---|---|---|
| 1 | Sat Soho failing case (May 3 signup, week 1 = May 2) | 0.75 | £22.75 | 3 × £29 | £109.75 |
| 2 | Canonical Apr 30 signup + Will Push (week 1 = May 2) | 1 (tier 2) | £30 | 3 × £29 | £117 |
| 3 | Pre-term signup Apr 15, anchor May 1 | 0 (tier 3) | £1 | 4 × £29 | £117 |
| 4 | Mid-term signup Jun 15 | 0.5 (tier 5) | £15.50 | 3 × £29 | £102.50 |
| 5 | Same-day-AM May 2 signup, week 1 = May 2 13:00 | 1 (tier 4) | £30 | 3 × £29 | £117 |
| 6 | Summer term spillback, week 1 = Apr 25, signup Apr 20 | 0 (tier 3) | £1 | 4 × £29 | £117 |
| 7 | Winter signup Aug 25, week 1 = Sep 17 | 0 (tier 3) | £1 | 4 × £29 | £117 |
| 8 | Winter signup Sep 5, week 1 = Sep 17 (anchor 1st) | 1 (tier 4) | £30 | 3 × £29 | £117 |
| 9 | Winter signup Sep 16, week 1 = Sep 17 (anchor 15th) | 1 (tier 4) | £30 | 3 × £29 | £117 |
| 10 | Winter signup Sep 18 post-week-1 | SWITCH (0.5/0.75) | £15.50 / £22.75 | 3 × £29 | £102.50 / £109.75 |

### Key Decisions

| Decision | Reason |
|---|---|
| 5-tier waterfall with explicit tier-4 "between first anchor and week 1 → 1" | The 4-tier alternative (SWITCH for everything after tier 3) would have undercharged the Winter Sep 5 case (customer missed Sep 1 anchor without paying anything for September) |
| `MONTH(week 1) = 4` (April) as the spillback check | Hard-coded to actual business rule: only Summer spills back. Earlier proposals (`DAY > 15`, `DAY > 21`) over-generalised and would mis-handle Winter Sep 22 / Spring Dec 28 edge cases that don't exist in practice |
| Will Push override at TOP of the waterfall | Otherwise the mid-term + 48-hr bump combo (e.g., May 30 signup with anchor June 1 and no Sat rehearsal between then) would hit SWITCH(0) → £1 → free June. Will Push at top fixes this latent bug too |
| Activation fee is one-time only (initial transaction) | Reaffirmed during this session — `Total Cost Initial Invoice` adds +100 pence to the pro-rata amount, but subsequent monthly Stripe anchor charges are £29 flat |
| No back-billing of affected members this session | Audit of who's affected since April 7 + retroactive correction policy is a separate decision |

### Known Imperfections (Both Deferred)

1. **Rehearsals = 1 + Will Push fires** — formula returns 1; fully accurate would be 1.25 (~£7.25 undercharge). Requires customer to sign up just before an evening rehearsal that's within 48 hours of their anchor. Very narrow window.
2. **Same-day evening signup** — Airtable `TODAY()` is midnight, so a 9pm signup on a rehearsal day still counts the (already-happened) rehearsal as attendable. Customer pays for a rehearsal they missed by hours. Acceptable.

### Forward Risk

The `MONTH(week 1) = 4` check is rigid. **If you ever add a fourth term or shift a term-start month** (e.g., Spring starting late December), the formula will silently mis-classify that term's first anchor. Sanity-check the multiplier on the first few signups of any new term cycle to confirm.

### Files Modified

- **Airtable** (manual): `{Billing Anchor Rehearsals Left Multiplier}` formula on Signup Queue table — full rewrite as 5-tier waterfall
- `CLAUDE.md` — Revised "How It Works" section to describe the 5-tier model with Spring/Summer/Winter term context, updated field description, added this session log

### What's Next / Where We Left Off

- New formula deployed; user testing in progress
- Should monitor the next several signups across all 5 tiers to confirm multiplier matches expectations
- **Open question:** Members signed up between April 7 (when the buggy formula went live) and May 11 may have been undercharged. Suggested audit query: Signup Queue records where `Created Time` is in that window AND `TODAY()` at signup was after `{week 1 date}` AND `{Will Push to Next Month} = "No"` AND `{Total Cost Initial Invoice} = 100`. These are the post-week-1 cases that hit the £1 floor instead of pro-rata

---

## Session Log: October 6, 2026

### What We Found

Reported as *"sign-up pro-rata seems to have been calculating too highly for members signing up
at the end of September — people with one rehearsal left paid nearly full price, then full price
again on 1 October."* True, and the cause was a branch called **"4.5 first month — taster
deducted"** sitting between tiers 4 and 5 of `{Billing Anchor Rehearsals Left Multiplier}`:

```
IF( AND({week 1 date} >= <this month's anchor>, {week 1 date} < <anchor + 1 month>),
    IF(<rehearsals left> = 0, 0,
       MAX(0, 1 - (FLOOR(DATETIME_DIFF(TODAY(), {week 1 date}, 'days') / 7) + 1) / 4)),
    <tier 5 SWITCH> )
```

**Its purpose was legitimate** — a member who attends a taster and signs up that same evening was
being charged for the rehearsal they had just done, because `{Rehearsals to 1st/15th}` counts from
`TODAY()` at midnight and so still includes that evening. That is a real leak and it is the
dominant signup moment: **124 of the 131** September signups made after their rehearsal had
started that evening have a Taster booking for that exact day.

**But it could not do the job, for two independent reasons** — see the ⚠️ under "Why 5 tiers" for
the full statement. In short: it sat *below* tier 4, which catches week-1-evening signups first
(`TODAY()` midnight `< {week 1 date}` 19:00 is true all day), so it never fired for its own use
case; and it had no taster input, so it approximated one with weeks-elapsed-since-week-1, which
replaced the rehearsals-remaining basis for every post-week-1 signup whose week 1 fell in the
current billing month — the whole of September for a Winter term. It caught **244 of 521**
September signups; only 22 ever reached tier 5.

Net effect: it deducted from **214** people with no taster to deduct, and failed to deduct for
the **72** who had one.

### Impact (two separate figures, kept apart)

**The bug reported** — tier 4.5 displacing tier 5:

| | GBP | EUR |
|---|---|---|
| Overcharged | 161 members, £1,392.00 | 31 members, €367.50 |
| Undercharged | 16 members, £116.00 | 2 members, €17.50 |
| Correct by coincidence | 19 | 6 |

One or two notches of £7.25 / €8.75 each; 140 of the 192 then paid a full month again on 1 Oct.
Worst shape: 89 members had exactly **one** rehearsal left and were charged 0.75 or 0.5 instead
of 0.25 — Thursday Wimborne, joined 18 Sept, one rehearsal left (24 Sept), paid £23.25 where the
waterfall says £8.75, then £29.00 on 1 Oct.

**The leak tier 4.5 was built to fix, still open** — tier 4 charging a flat full month over a
same-day taster: 59 GBP members £1,036.75 + 9 EUR members €183.75.

Not broken, and worth knowing: the 48-hour / Will Push path was fine. All 31 tier-2 records
pushed `trial_end` to 1 Nov and took no October charge — the double billing was not the bump.

### Method (reusable — this is how to audit a past charge)

`{Rehearsals to 1st}`, `{Rehearsals to 15th}`, `{week 1 date}`, the live multiplier and
`{Initial Payment Description}` are all **live** values that drift after the sale. Only
`{Multiplier at Signup}`, `{Tier at Signup}` (frozen by `66af367`) and `{Initial Charge Paid}`
(written by the webhook from `invoice.amount_paid`) are historical truth. Recompute
rehearsals-left from the choir's `week N date` fields as of each record's `Created` date,
converted to Europe/London.

**Half-term IS a payable slot** — policy, 6 Oct 2026: Some Voices often runs other membership
activity during half-term week, which justifies charging for it. 49 of 72 choirs have one. This is
the opposite of the main app's rule, where `{half-term date}` means "no rehearsal" unless a leader
is named.

⚠️ **Do not justify that with the 22/22.** Including `{half-term date}` makes an independent
recompute agree with Airtable's own lookup on 22/22 of the records that reached tier 5 (excluding
it, 15/22) — and that is agreement with the **formula**, which was the thing under audit. It is
not evidence about policy. Counting half-term was briefly removed on 6 Oct on a misreading of
this, then restored on the policy above. Counting it is also **weakly revenue-positive always**:
adding to the count can only raise the multiplier or leave it, since the SWITCH caps at 4+ → 1.
Worth ~£1,641 + €193 across the remainder of a term, plus £195.75 + €43.75 in September credits.

### Fix — four formulas across two bases, all live 6 Oct 2026

**1 & 2 — remove tier 4.5** from `{Billing Anchor Rehearsals Left Multiplier}` **and** from
`{Tier (Current)}`. The diagnostic twin carried the same branch, and leaving it would make the
tier label disagree with the charge *and* freeze a wrong `{Tier at Signup}` onto every new record.
Derived two independent ways that produced identical text: surgically removing the branch from the
live formula, and taking the base's own `Test: Multiplier (Bundle Logic)` with its
`{Test: Will Push (Bundle Logic)}` reference swapped for the real `{Will Push to Next Month}`.

Verified across all 521 September signups: 219 of 244 tier-4.5 multipliers change; tiers 1–4 are
*structurally* untouched (the two formulas share a byte-identical 479-char prefix). Golden rule
holds — no record newly takes mult 0 with a bumped `trial_end`, so no free month.

**3 & 4 — `>= TODAY()` → `>= NOW()`** on all twelve slots of
`Choirs base › Rehearsals › {Rehearsals to 1st}` and `{Rehearsals to 15th}`
(`app5eEsU46HOwnLd2` / `tbl8DgEG18XD7KVlS`). **This is what actually fixed the taster problem, and
it needed no taster data at all.** `TODAY()` is midnight, so a 19:00 rehearsal stayed in the count
until 23:59 and the member who had just sung it was charged for it. Change only the slot
comparisons; the other `TODAY()` calls are anchor-boundary calendar maths and must stay (12 of
them survive in the 1st, 36 in the 15th).

⚠️ **There are three fields called `{Rehearsals to 1st}`** and only one is editable: the formula
on Choirs base › Rehearsals. Choirs base › Choirs holds a lookup; SV Membership › Choirs MASTER
holds a cross-base synced copy which arrives as plain `singleLineText` — which is why it looks
unmaintained there, and why it is tempting to conclude wrongly that nothing owns it.

Measured on the day: the source → lookup → cross-base sync → Choirs MASTER → Signup Queue chain
propagates in **minutes** (57/57 agreement within minutes of each paste), so the evening
correction does reach a 20:46 checkout.

**Deliberately excluded:** `Test: Will Push (Bundle Logic)` is *not* a like-for-like — it adds
`rehearsals left == 0 → push`, charging those members a full month up front and moving the
subscription on a month. Same term total, different timing; a policy call, not a bug fix.

### Guard

`scripts/check-billing-formulas.mjs` + `scripts/billing-formulas.approved.json`, wired to
`prebuild` as `npm run check:billing`. Reads **12 billing-critical formulas across 2 bases** via
the Metadata API and fails the build on any change nobody approved. It must cover both bases: the
rehearsal count the pro-rata SWITCHes on is a formula in the **Choirs** base, so guarding only
SV Membership would miss the field that actually decides the number.

Compares on **field ids**, so a rename is not a false positive; displays field **names**, so the
diff is readable. **10 shape invariants** encode failures this logic has actually had — tier-5
SWITCH present, no weeks-elapsed decay, Will Push above the pro-rata tiers, `< 3` not `< 2`, and
per rehearsal count: counts from `NOW()` not midnight, half-term IS counted, all 12 slots present.
`--update` refuses to approve a formula that breaks one. Fails **closed** on confirmed drift,
**open** on a missing key or unreachable Airtable, so a blip never blocks an unrelated deploy.

The last three invariants encode **policy**, not arithmetic — the half-term one was inverted twice
in a single day as the policy was clarified. If policy moves again, change the invariant
deliberately and record why in the HISTORY file, rather than treating the failure as drift.

Paste-ready formula text and full per-field histories live in
`~/Documents/Vercel/airtable-formulas/`, named `<Base> - <Table> - <Field>`, with an
`_export-formulas.mjs` that re-dumps any base. That folder is the diff these formulas never had.

### What's Next / Where We Left Off

- **All four formulas are live and verified** (6 Oct 2026). `npm run check:billing` is green;
  the live rehearsal counts agree with an independent recount 57/57.
- **Credits not yet applied. Remediation decision: no refunds — credit each member's NEXT
  invoice.** 296 members, £2,928.63 + €647.50. Export, applier and full method in
  `~/Documents/Vercel/signup-overcharge-sept-2026/` (outside version control — member PII).
  Stripe **customer credit balance** is the mechanism: a negative balance applies automatically to
  the next invoice. `apply-credits.mjs` is dry-run by default and idempotent across runs via a
  `sv_credit_batch` metadata tag. Two to decide first: one `canceled` subscription (a credit would
  sit unused — needs a refund or nothing) and one `past_due` (a credit hits the next invoice
  raised, not the open one).
- A confidence check worth repeating if these numbers are ever re-derived: two independent bases
  converged to within one member — deducting a same-day taster from a midnight count gave 295 /
  £2,921.38, measuring from the signup instant gave 296 / £2,928.63.
- **Still open, deliberately:** ~5 members a term who book a taster for tonight and sign up
  *before* it starts. The rehearsal legitimately hasn't happened, so only real taster data would
  catch them. `{Link *Tasters}` is a `singleLineText` stub, not a link — a real fix needs a link
  field, a lookup and something to populate it (Airtable cannot match on email + choir + date by
  itself). Not worth it for five people; if ever built, key it off the taster **booking date,
  never `{Attended}`**, which is blank on all 2,419 Sign-Up Form rows because marking lags.
- `{Skip Next Month}` has drifted from its April 2026 documented form — it returns `"No"` for a
  blank `{Next Rehearsal Date}` where the April 3 log specifies `"Yes"`. Unrelated to this
  overcharge, but it feeds `{Next Billing Date (Before Push)}`, so worth a separate look. It is
  in the approved snapshot as-is, not as the doctrine describes it.
- A known, deliberate imperfection: 6 records hit tier 2 *with* a same-day taster. They cannot
  take the phase-2 credit without breaking the golden rule, since their up-front charge is
  covering a bumped future month. They keep paying 1.
