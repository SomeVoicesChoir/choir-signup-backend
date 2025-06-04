// pages/api/stripe-webhook.js
import Stripe from 'stripe';
import Airtable from 'airtable';

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
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.mode === 'payment') {
      const recordId = session.metadata?.recordId;
      if (!recordId) return res.status(200).send('No recordId');

      let webhookReport = [];

      try {
        const record = await base('Signup Queue').find(recordId);
        const customerId = session.customer;
        const priceId = record.fields['Stripe PRICE_ID'];
        const couponId = (record.fields['Stripe Coupon ID'] || [])[0] || undefined;
        const billingAnchor = Number(record.fields['Billing Anchor']) || 1;

        try {
          await base('Signup Queue').update(recordId, {
            'Stripe Customer ID': customerId,
            'Initial Payment Status': 'Success',
          });
          webhookReport.push('✅ Stripe customer ID saved');
        } catch (err) {
          webhookReport.push(`❌ Error saving customer ID: ${err.message}`);
        }

        const anchorDate = getNextAnchorDate(billingAnchor);
        const anchorUnix = Math.floor(anchorDate.getTime() / 1000);
        const chartCode = (record.fields['Chart of Accounts Code'] || [])[0] || '';
        const chartDescription = (record.fields['Chart of Accounts Full Length'] || [])[0] || '';

        try {
          await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: Array.isArray(priceId) ? priceId[0] : priceId }],
            billing_cycle_anchor: anchorUnix,
            coupon: couponId,
            metadata: {
              airtable_record_id: recordId,
              choir: record.fields['Choir']?.[0] || '',
              chartCode,
              chartDescription
            },
          });
          webhookReport.push('✅ Subscription created');
        } catch (err) {
          webhookReport.push(`❌ Subscription error: ${err.message}`);
        }

        try {
          const customerRecords = await base('Customer Record').select({
            filterByFormula: `{Stripe Customer_ID} = '${customerId}'`,
            maxRecords: 1,
          }).firstPage();

          if (customerRecords.length > 0) {
            const customerRecordId = customerRecords[0].id;
            const choirId = (record.fields['Choir'] || [])[0] || null;

            const membersRecords = await base('Members').select({
              filterByFormula: `ARRAYJOIN({*Customer Record}) = '${customerRecordId}'`,
              maxRecords: 1
            }).firstPage();

            if (membersRecords.length > 0) {
              const membersRecord = membersRecords[0];
              const membersRecordId = membersRecord.id;

              const existingChoirs = membersRecord.fields['Choir'] || [];
              const updatedChoirs = choirId && !existingChoirs.includes(choirId)
                ? [...existingChoirs, choirId]
                : existingChoirs;

              await base('Members').update(membersRecordId, {
                'Choir': updatedChoirs
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
          }
        } catch (err) {
          webhookReport.push(`❌ Members sync error: ${err.message}`);
        }

      } catch (err) {
        webhookReport.push(`🚨 General error: ${err.message}`);
      }

      try {
        await base('Signup Queue').update(recordId, {
          'Webhook Report': webhookReport.join('\n')
        });
      } catch (err) {
        console.error('❌ Failed to write webhook report to Airtable:', err.message);
      }
    }
  }

  // Handle invoice.created — UNCHANGED except one fix for Stripe Timestamp
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

      const choirId = (invoice.metadata?.choir || '') || (customerRecords[0]?.fields?.Choir || [])[0] || null;

      const membersRecords = await base('Members').select({
        filterByFormula: `ARRAYJOIN({*Customer Record}) = '${customerRecordId}'`,
        maxRecords: 1
      }).firstPage();

      if (membersRecords.length > 0) {
        const membersRecord = membersRecords[0];
        const membersRecordId = membersRecord.id;

        const existingChoirs = membersRecord.fields['Choir'] || [];
        const updatedChoirs = choirId && !existingChoirs.includes(choirId)
          ? [...existingChoirs, choirId]
          : existingChoirs;

        await base('Members').update(membersRecordId, {
          'Choir': updatedChoirs
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

      console.log(`📄 Invoice logged for ${invoice.id}`);
    } catch (err) {
      console.error('❌ Airtable error logging invoice or updating customer:', err);
    }
  }

  res.status(200).send('Event received');
}
