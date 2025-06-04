// pages/api/create-initial-invoice.js
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recordId } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  try {
    const record = await base('Signup Queue').find(recordId);
    const customerId = record.fields['Stripe Customer ID'];
    const amount = Number(record.fields['Total Cost Initial Invoice'] || 0);
    const description = record.fields['Initial Payment Description'] || 'Initial Payment';

    if (!customerId) return res.status(400).json({ error: 'Missing Stripe Customer ID' });

    // 1. Create invoice item
    await stripe.invoiceItems.create({
      customer: customerId,
      amount,
      currency: 'gbp', // Or read from record
      description
    });

    // 2. Create the invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: true // Finalize and send the invoice
    });

    res.status(200).json({ success: true, invoiceId: invoice.id });
  } catch (err) {
    console.error('Invoice creation error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
}
