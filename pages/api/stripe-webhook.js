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

// Helper: Read raw buffer for signature validation
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Helper: Calculate next billing anchor date (1st or 15th)
function getNextAnchorDate(anchorDay) {
  const now = new Date();
  return anchorDay === 15
    ? now.getDate() >= 15
      ? new Date(now.getFullYear(), now.getMonth() + 1, 15)
      : new Date(now.getFullYear(), now.getMonth(), 15)
    : now.getDate() >= 1
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  console.log('🧪 Using webhook secret:', process.env.STRIPE_WEBHOOK_SECRET); // 👈 INSERT THIS
  
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // === checkout.session.completed ===
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode !== 'payment') return res.status(200).send('Not a payment session');

    const recordId = session.metadata?.recordId;
    if (!recordId) return res.status(200).send('No recordId');

    let webhookReport = [];

    try {
      const record = await base('Signup Queue').find(recordId);
      const customerId = session.customer;
      const priceId = record.fields['Stripe PRICE_ID'];
      const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
      const billingAnchor = Number(record.fields['Billing Anchor']) || 1;

      const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
      const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';
      const trackingCode = record.fields['Tracking Code'] || '';
      const sku = record.fields['SKU'] || '';
      const choirName = record.fields['Choir Name'] || '';
      const voicePart = record.fields['Voice Part'] || '';

      try {
        await base('Signup Queue').update(recordId, {
          'Stripe Customer ID': customerId,
          'Initial Payment Status': 'Success',
        });
        webhookReport.push('✅ Stripe customer ID saved');
      } catch (err) {
        webhookReport.push(`❌ Error saving customer ID: ${err.message}`);
      }

      try {
        const anchorDate = getNextAnchorDate(billingAnchor);
        const anchorUnix = Math.floor(anchorDate.getTime() / 1000);
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: Array.isArray(priceId) ? priceId[0] : priceId }],
          billing_cycle_anchor: anchorUnix,
          coupon: couponId,
          metadata: {
            airtable_record_id: recordId,
            choir: record.fields['Choir']?.[0] || '',
            chartCode,
            chartDescription,
            trackingCode,
            sku
          },
        });
        webhookReport.push('✅ Subscription created');

        // Save Subscription ID and other fields to Customer Record
        const customerRecords = await base('Customer Record').select({
          filterByFormula: `{Stripe Customer_ID} = '${customerId}'`,
          maxRecords: 1,
        }).firstPage();

        if (customerRecords.length > 0) {
          const customerRecordId = customerRecords[0].id;

          await base('Customer Record').update(customerRecordId, {
            'Stripe Subscription_ID': subscription.id,
            'Voice Part': voicePart || '',
            'Choir Name': choirName || '',
            'Chart of Accounts Code': chartCode || '',
            'Tracking Code': trackingCode || '',
            'SKU': sku || ''
          });
          webhookReport.push('✅ Customer Record updated');

          // Update or create Members record
          const choirId = (record.fields['Choir'] || [])[0] || null;
          const members = await base('Members').select({
            filterByFormula: `ARRAYJOIN({*Customer Record}) = '${customerRecordId}'`,
            maxRecords: 1,
          }).firstPage();

          if (members.length > 0) {
            const m = members[0];
            const choirList = m.fields['Choir'] || [];
            const updatedChoirList = choirId && !choirList.includes(choirId)
              ? [...choirList, choirId]
              : choirList;

            await base('Members').update(m.id, {
              'Choir': updatedChoirList,
            });
            webhookReport.push('✅ Members record updated');
          } else {
            await base('Members').create({
              'Email': record.fields['Email'] || '',
              'First Name': record.fields['First Name'] || '',
              'Surname': record.fields['Surname'] || '',
              'Mobile Phone Number': record.fields['Mobile Phone Number'] || '',
              '*Customer Record': [customerRecordId],
              'Choir': choirId ? [choirId] : []
            });
            webhookReport.push('✅ Members record created');
          }
        } else {
          webhookReport.push('❌ No matching Customer Record found to update');
        }
      } catch (err) {
        webhookReport.push(`❌ Subscription/Members sync error: ${err.message}`);
      }

    } catch (err) {
      webhookReport.push(`🚨 General error: ${err.message}`);
    }

    try {
      await base('Signup Queue').update(recordId, {
        'Webhook Report': webhookReport.join('\n')
      });
    } catch (err) {
      console.error('❌ Failed to write webhook report:', err.message);
    }
  }

  // === invoice.created ===
  if (event.type === 'invoice.created') {
    const invoice = event.data.object;

    try {
      const customerId = invoice.customer;
      const email = invoice.customer_email || '';
      const customer = await stripe.customers.retrieve(customerId);
      const phone = customer.phone || '';
      const name = customer.name || '';
      const [firstName, ...surnameParts] = name.trim().split(' ');
      const surname = surnameParts.join(' ');
      const address = customer.address || {};

      const customerRecords = await base('Customer Record').select({
        filterByFormula: `{Stripe Customer_ID} = '${customerId}'`,
        maxRecords: 1,
      }).firstPage();

      let customerRecordId;
      if (customerRecords.length > 0) {
        customerRecordId = customerRecords[0].id;
        await base('Customer Record').update(customerRecordId, {
          'Mobile Phone Number': phone,
          'First Name': firstName || '',
          'Surname': surname || '',
          'Address Line 1': address.line1 || '',
          'Address Line 2': address.line2 || '',
          'Address City': address.city || '',
          'Post Code': address.postal_code || '',
        });
      } else {
        const newCustomer = await base('Customer Record').create({
          'Email': email,
          'Stripe Customer_ID': customerId,
          'Mobile Phone Number': phone,
          'First Name': firstName || '',
          'Surname': surname || '',
          'Address Line 1': address.line1 || '',
          'Address Line 2': address.line2 || '',
          'Address City': address.city || '',
          'Post Code': address.postal_code || '',
        });
        customerRecordId = newCustomer.id;
      }

      await base('Stripe Invoices').create({
        'Invoice_ID': invoice.id,
        'Invoice Number': invoice.number?.toString() || '',
        '*Link Customer Record': [customerRecordId],
        'Gross Amount': invoice.amount_due,
        'Currency': invoice.currency?.toUpperCase() || 'GBP',
        'Invoice Description': invoice.description || '',
        'Stripe Timestamp': new Date(invoice.created * 1000).toISOString(),
        'Subscription ID': invoice.subscription || '',
        'Invoice Status': invoice.status || '',
      });

      const choirId = invoice.metadata?.choir || null;
      const members = await base('Members').select({
        filterByFormula: `ARRAYJOIN({*Customer Record}) = '${customerRecordId}'`,
        maxRecords: 1,
      }).firstPage();

      if (members.length > 0) {
        const m = members[0];
        const choirList = m.fields['Choir'] || [];
        const updatedChoirList = choirId && !choirList.includes(choirId)
          ? [...choirList, choirId]
          : choirList;

        await base('Members').update(m.id, {
          'Choir': updatedChoirList,
        });
      } else {
        await base('Members').create({
          'Email': email,
          'First Name': firstName || '',
          'Surname': surname || '',
          'Mobile Phone Number': phone || '',
          '*Customer Record': [customerRecordId],
          'Choir': choirId ? [choirId] : []
        });
      }

      // If this is the FIRST subscription invoice (will show Stripe's "Trial period" wording),
      // add a footer + custom field explaining the trial is actually a billing delay.
      // Only the first invoice (billing_reason = subscription_create) carries the trial labelling;
      // subsequent monthly invoices don't, so we don't need to add the footer to them.
      if (invoice.billing_reason === 'subscription_create' && invoice.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          if (subscription.trial_end) {
            const trialEndDate = new Date(subscription.trial_end * 1000);
            const trialEndReadable = trialEndDate.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            });
            await stripe.invoices.update(invoice.id, {
              footer: `The "Trial period" shown above is not a free trial — it is a billing delay so your monthly Some Voices membership payments align with your chosen billing date. Your first £29 monthly payment will be charged on ${trialEndReadable}.`,
              custom_fields: [
                { name: 'Subscription begins', value: trialEndReadable }
              ]
            });
            console.log(`✅ Added billing-anchor footer to invoice ${invoice.id}`);
          }
        } catch (invoiceUpdateErr) {
          console.error('⚠️ Could not update invoice footer (non-fatal):', invoiceUpdateErr.message);
        }
      }

      // Snapshot multiplier + tier + initial charge on the Signup Queue record.
      // Frozen values (non-formula) so historical audits don't drift with TODAY().
      // Only fires on the first subscription invoice (the one paid at checkout).
      if (invoice.billing_reason === 'subscription_create') {
        try {
          const recordId = invoice.metadata?.recordId
            || invoice.subscription_details?.metadata?.recordId;
          if (recordId) {
            const signupRecord = await base('Signup Queue').find(recordId);
            await base('Signup Queue').update(recordId, {
              'Initial Charge Paid': invoice.amount_paid,
              'Multiplier at Signup': signupRecord.fields['Billing Anchor Rehearsals Left Multiplier'],
              'Tier at Signup': signupRecord.fields['Tier (Current)'],
            });
            console.log(`✅ Wrote signup snapshot to Signup Queue ${recordId}`);
          } else {
            console.warn('⚠️ No recordId in invoice metadata — snapshot skipped for invoice', invoice.id);
          }
        } catch (snapshotErr) {
          console.error('⚠️ Could not write signup snapshot (non-fatal):', snapshotErr.message);
        }
      }

    } catch (err) {
      console.error('❌ Error logging invoice:', err);
    }
  }

  res.status(200).send('Event received');
}
