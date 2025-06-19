// pages/api/stripe-invoice-webhook.js
import Stripe from 'stripe';
import Airtable from 'airtable';

// Disable body parsing to read raw Stripe webhook
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'invoice.created') {
    const invoice = event.data.object;

    try {
      await base('Stripe Invoices').create({
        fields: {
          'Invoice ID': invoice.id,
          'Invoice Number': invoice.number?.toString() || '',
          'Customer ID': invoice.customer || '',
          'Amount Due': (invoice.amount_due / 100).toFixed(2),
          'Currency': invoice.currency.toUpperCase(),
          'Status': invoice.status,
          'Subscription ID': invoice.subscription || '',
          'Description': invoice.description || `Invoice ${invoice.number}`,
          'Invoice Date': new Date(invoice.created * 1000).toISOString(),
        }
      });

      console.log(`Invoice ${invoice.id} logged to Airtable`);
      return res.status(200).send('Invoice logged');
    } catch (err) {
      console.error('Airtable logging error:', err);
      return res.status(500).send('Failed to log invoice');
    }
  }

  res.status(200).send('Event received');
}
