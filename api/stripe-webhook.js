// /api/stripe-webhook.js
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

// Helper: Read raw body for signature validation
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: Get next 1st or 15th
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
  return next;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.mode === 'payment') {
      const recordId = session.metadata?.recordId;
      if (!recordId) return res.status(200).send('No recordId');

      try {
        const record = await base('Signup Queue').find(recordId);

        const priceId = record.fields['Stripe PRICE_ID'];
        const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
        const billingAnchor = Number(record.fields['Billing Anchor']) || 1;
        const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
        const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';

        const anchorDate = getNextAnchorDate(billingAnchor);
        const anchorUnix = Math.floor(anchorDate.getTime() / 1000);

        const subscription = await stripe.subscriptions.create({
          customer: session.customer,
          items: [{ price: Array.isArray(priceId) ? priceId[0] : priceId }],
          billing_cycle_anchor: anchorUnix,
          coupon: couponId,
          metadata: {
            airtable_record_id: recordId,
            choir: record.fields['Choir']?.[0] || '',
            chartCode,
            chartDescription
          }
        });

        await base('Signup Queue').update(recordId, {
          'Subscription Status': 'Active',
          'Stripe Subscription ID': subscription.id
        });

        console.log(`Subscription created for customer: ${session.customer}`);
        return res.status(200).send('Subscription created');
      } catch (err) {
        console.error('Stripe subscription creation error:', err);
        return res.status(500).send('Failed to create subscription');
      }
    }
  }

  if (event.type === 'invoice.created') {
    const invoice = event.data.object;

    try {
      const customerId = invoice.customer;
      const amountDue = invoice.amount_due;
      const currency = invoice.currency;
      const invoiceNumber = invoice.number;
      const invoiceId = invoice.id;
      const invoiceDate = new Date(invoice.created * 1000).toISOString();
      const subscriptionId = invoice.subscription || '';
      const description = invoice.description || '';

      // Link to Customer Record
      const customerRecords = await base('Customer Record').select({
        filterByFormula: `{Stripe Customer_ID} = '${customerId}'`,
        maxRecords: 1
      }).firstPage();
      const customerRecordId = customerRecords[0]?.id;

      await base('Stripe Invoices').create({
        'Invoice_ID': invoiceId,
        'Invoice Number': invoiceNumber,
        '*Link Customer Record': customerRecordId ? [customerRecordId] : [],
        'Gross Amount': amountDue,
        'Currency': currency.toUpperCase(),
        'Invoice Date': invoiceDate,
        'Subscription ID': subscriptionId,
        'Invoice Description': description,
        'Status': invoice.status || 'unknown'
      });

      console.log(`Invoice logged: ${invoiceId}`);
      return res.status(200).send('Invoice logged');
    } catch (err) {
      console.error('Invoice logging error:', err);
      return res.status(500).send('Failed to log invoice');
    }
  }

  res.status(200).send('Event received');
}
