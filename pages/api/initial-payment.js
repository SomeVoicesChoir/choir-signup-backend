// initial-payment.js - Endpoint for charging initial payment after subscription creation
import Stripe from 'stripe';
import Airtable from 'airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app_url = process.env.APP_URL || 'https://choir-signup-backend-atuj.vercel.app';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Get parameters from request (either query params for GET or body for POST)
  const params = req.method === 'GET' ? req.query : req.body;
  const { recordId, session_id, paymentMethod = 'ideal', customer: customerId_param } = params;
  let { subscriptionId } = params;
  
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });
  
  try {
    // If we have a session_id, retrieve the session to get the subscription and payment method
    let paymentMethodId = null;
    if (session_id) {
      const session = await stripe.checkout.sessions.retrieve(session_id, {
        expand: ['subscription', 'setup_intent', 'payment_intent']
      });
      
      if (session.subscription) {
        subscriptionId = typeof session.subscription === 'string' ? 
          session.subscription : session.subscription.id;
      }
      
      // Try to get the payment method from setup_intent or payment_intent
      if (session.setup_intent && session.setup_intent.payment_method) {
        paymentMethodId = session.setup_intent.payment_method;
        console.log('Found payment method from setup intent:', paymentMethodId);
      } else if (session.payment_intent && session.payment_intent.payment_method) {
        paymentMethodId = session.payment_intent.payment_method;
        console.log('Found payment method from payment intent:', paymentMethodId);
      }
    }

    if (!subscriptionId) {
      throw new Error('Missing subscriptionId and unable to retrieve it from session');
    }
    
    // Get record from Airtable to retrieve necessary details
    const record = await base('Signup Queue').find(recordId);
    
    // Get the customer ID from params, record, or from the subscription
    let customerId = customerId_param || record.fields['Stripe Customer ID'];
    if (!customerId) {
      // Fetch subscription to get customer ID if not available in record or params
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      customerId = subscription.customer;
      
      // Update the record with the customer ID if we got it from subscription
      if (customerId) {
        await base('Signup Queue').update(recordId, {
          'Stripe Customer ID': customerId
        });
      }
    }

    if (!customerId) {
      throw new Error('Unable to determine customer ID');
    }

    // Get the initial payment amount
    const amount = Number(record.fields['Total Cost Initial Invoice'] || 0);
    if (amount <= 0) {
      if (req.method === 'GET') {
        return res.redirect(303, `https://somevoices.co.uk/success?subscriptionId=${subscriptionId}&status=active`);
      } else {
        return res.status(200).json({ 
          message: 'No initial payment required',
          success: true,
          subscriptionId
        });
      }
    }

    // Get currency from record
    const currencyField = record.fields["Stripe 'default_price_data[currency]'"] || 'gbp';
    const currency = typeof currencyField === 'string'
      ? currencyField.toLowerCase()
      : Array.isArray(currencyField)
        ? currencyField[0].toLowerCase()
        : 'gbp';

    // Set description for the payment
    const description = record.fields['Initial Payment Description'] || 'Some Voices – Initial Pro-Rata Payment';

    // Collect metadata for the invoice and payment intent
    const metadata = {
      choir: record.fields['Choir']?.[0] || '',
      voicePart: record.fields['Voice Part'] || '',
      firstName: record.fields['First Name'] || '',
      surname: record.fields['Surname'] || '',
      chartCode: (record.fields['Chart of Accounts Code'] || [])[0] || '',
      chartDescription: (record.fields['Chart of Accounts Full Length'] || [])[0] || '',
      trackingCode: String(record.fields['Tracking Code'] || ''),
      sku: String(record.fields['SKU'] || ''),
      choirName: String(record.fields['Choir Name'] || ''),
      subscriptionId,
      recordId
    };

    // First, retrieve the subscription to get payment method info
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method']
    });
    
    // Check if the customer has a default payment method, if not, set one
    const customerDetails = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method']
    });
    
    let defaultPaymentMethod = customerDetails.invoice_settings.default_payment_method;
    
    // If no default payment method is set, try to use one from:
    // 1. The payment method we found from the session
    // 2. The subscription's default payment method
    // 3. List the customer's payment methods and use the most recent one
    if (!defaultPaymentMethod) {
      console.log('No default payment method found for customer, attempting to set one...');
      
      if (paymentMethodId) {
        // Use the payment method from the session
        await stripe.customers.update(customerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId
          }
        });
        console.log('Set default payment method from session:', paymentMethodId);
      } else if (subscription.default_payment_method) {
        // Use the subscription's default payment method
        const subPaymentMethodId = typeof subscription.default_payment_method === 'string' ? 
          subscription.default_payment_method : subscription.default_payment_method.id;
        
        await stripe.customers.update(customerId, {
          invoice_settings: {
            default_payment_method: subPaymentMethodId
          }
        });
        console.log('Set default payment method from subscription:', subPaymentMethodId);
      } else {
        // Try to find a payment method attached to the customer
        const paymentMethods = await stripe.paymentMethods.list({
          customer: customerId,
          type: 'card'
        });
        
        if (paymentMethods.data.length > 0) {
          const latestPaymentMethod = paymentMethods.data[0].id;
          await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method: latestPaymentMethod
            }
          });
          console.log('Set default payment method from customer payment methods:', latestPaymentMethod);
        } else {
          console.log('No payment methods found for customer, will need to send invoice link');
        }
      }
    }

    // For direct charge, first create an invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      description: description,
      metadata,
      auto_advance: true, // Auto-finalize the invoice
    });

    // Add an invoice item for the initial payment
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      currency,
      amount,
      description: description,
      metadata
    });

    // Finalize the invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    // Try to pay the invoice immediately
    try {
      // Get the updated customer to check if we now have a default payment method
      const updatedCustomer = await stripe.customers.retrieve(customerId, {
        expand: ['invoice_settings.default_payment_method']
      });
      
      let paymentOptions = {};
      if (updatedCustomer.invoice_settings.default_payment_method) {
        // If we have a default payment method, specify it explicitly
        const pmId = typeof updatedCustomer.invoice_settings.default_payment_method === 'string' ?
          updatedCustomer.invoice_settings.default_payment_method :
          updatedCustomer.invoice_settings.default_payment_method.id;
        
        paymentOptions.payment_method = pmId;
        console.log('Using specific payment method for invoice:', pmId);
      } else if (paymentMethodId) {
        // Use the payment method we found from the session if available
        paymentOptions.payment_method = paymentMethodId;
        console.log('Using session payment method for invoice:', paymentMethodId);
      }
      
      const paidInvoice = await stripe.invoices.pay(finalizedInvoice.id, paymentOptions);
      console.log('Successfully charged customer directly:', paidInvoice.id);
      
      // Redirect to success page for GET requests or return success response for POST
      if (req.method === 'GET') {
        res.redirect(303, `https://somevoices.co.uk/success?subscriptionId=${subscriptionId}&payment_success=true&invoice_id=${paidInvoice.id}`);
      } else {
        res.status(200).json({ 
          success: true,
          invoice_id: paidInvoice.id,
          subscription_id: subscriptionId,
          message: 'Initial payment processed successfully'
        });
      }
    } catch (payError) {
      console.error('Error charging invoice automatically:', payError);
      
      // If we can't charge automatically (e.g., for iDEAL which doesn't support direct charges),
      // create a payment link for the invoice instead
      try {
        const paymentLink = await stripe.invoices.sendInvoice(finalizedInvoice.id);
        
        if (req.method === 'GET') {
          res.redirect(303, paymentLink.hosted_invoice_url);
        } else {
          res.status(200).json({ 
            success: true,
            invoice_id: finalizedInvoice.id,
            payment_url: paymentLink.hosted_invoice_url,
            message: 'Invoice created, payment link generated'
          });
        }
      } catch (invoiceError) {
        console.error('Error sending invoice:', invoiceError);
        throw new Error(`Could not process payment automatically or send invoice: ${payError.message}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Stripe.errors.StripeError 
      ? error.message 
      : 'Failed to process initial payment';

    console.error('Detailed error:', {
      message: error.message,
      stack: error.stack,
      data: req.method === 'GET' ? req.query : req.body
    });

    if (req.method === 'GET') {
      // For GET requests, redirect to an error page
      res.redirect(303, `https://somevoices.co.uk/cancelled?error=${encodeURIComponent(errorMessage)}`);
    } else {
      // For POST requests, return error as JSON
      res.status(500).json({ 
        error: error.message,
        code: error.code || 'UNKNOWN_ERROR',
        success: false
      });
    }
  }
}
