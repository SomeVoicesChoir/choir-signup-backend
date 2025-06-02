// pages/api/stripe-webhook.js
import Stripe from 'stripe';
import Airtable from 'airtable';

// Disable Vercel's default body parsing for this API route!
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Helper: Read raw body for signature verification
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: Get next billing anchor date
function getNextAnchorDate(anchorDay) {
  const now = new Date();
  let next;
  if (anchorDay === 15) {
    next = now.getDate() >= 15
      ? new Date(now.getFullYear(), now.getMonth() + 1, 15)
      : new Date(now.getFullYear(), now.getMonth(), 15);
  } else {
    next = now.getDate() >= 1
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return Math.floor(next.getTime() / 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const recordId = session.metadata?.recordId;
    const customerId = session.customer;
    const customerEmail = session.customer_email || session.customer_details?.email;
    const firstName = session.metadata?.firstName || '';
    const surname = session.metadata?.surname || '';
    const choir = session.metadata?.choir || '';

    if (!customerId || !customerEmail) {
      console.warn('Missing customer ID or email');
      return res.status(200).send('No customer ID or email');
    }

    try {
      // 1️⃣ Create or update Customer Record
      const customerRecords = await base('Customer Record').select({
        filterByFormula: `OR({Stripe Customer ID} = '${customerId}', {Email} = '${customerEmail}')`,
        maxRecords: 1
      }).firstPage();

      if (customerRecords.length > 0) {
        // Update existing
        const existing = customerRecords[0];
        await base('Customer Record').update(existing.id, {
          'Stripe Customer ID': customerId,
          'First Name': firstName,
          'Surname': surname,
          'Email': customerEmail,
          'Choir': choir
        });
        console.log(`Updated Customer Record: ${existing.id}`);
      } else {
        // Create new
        const created = await base('Customer Record').create({
          'Stripe Customer ID': customerId,
          'First Name': firstName,
          'Surname': surname,
          'Email': customerEmail,
          'Choir': choir
        });
        console.log(`Created Customer Record: ${created.id}`);
      }

      // 2️⃣ Update Signup Queue record
      if (recordId) {
        await base('Signup Queue').update(recordId, {
          'Initial Payment Status': 'Success',
          'Stripe Customer ID': customerId
        });
        console.log(`Updated Signup Queue: ${recordId}`);
      }

      // 3️⃣ Optional: Create subscription if needed
      const record = recordId ? await base('Signup Queue').find(recordId) : null;
      if (record) {
        const priceId = record.fields['Stripe PRICE_ID'];
        const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
        const billingAnchor = Number(record.fields['Billing Anchor']) || 1;

        if (priceId) {
          const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            coupon: couponId,
            billing_cycle_anchor: getNextAnchorDate(billingAnchor),
            metadata: {
              recordId,
              choir,
              firstName,
              surname
            }
          });

          await base('Signup Queue').update(recordId, {
            'Stripe Subscription ID': subscription.id,
            'Subscription Status': 'Active'
          });
          console.log(`Subscription created: ${subscription.id}`);
        }
      }

      // 4️⃣ Optional: Log invoice (this webhook doesn't create an invoice – separate webhook recommended)
      // If you want to capture invoices, listen for invoice.paid or invoice.created events.

      res.status(200).send('Handled checkout.session.completed');
    } catch (err) {
      console.error('Error handling event:', err);
      res.status(500).send('Internal Error');
    }
  } else {
    res.status(200).send('Event received');
  }
}
