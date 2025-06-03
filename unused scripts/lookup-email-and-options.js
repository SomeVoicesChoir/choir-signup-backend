import Airtable from 'airtable';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const members = await base('Members').select({ filterByFormula: `{Email} = '${email}'`, maxRecords: 1 }).firstPage();
    let found = false, firstName = '', surname = '', latestChoir = '', voicePart = '', stripeCustomerId = null;
    if (members.length) {
      const member = members[0];
      firstName = member.fields['First Name'] || '';
      surname = member.fields['Surname'] || '';
      latestChoir = member.fields['LATEST CHOIR (conc)'] || '';
      voicePart = member.fields['Voice Part'] || '';
      const customerLink = member.fields['*Customer Record']?.[0];
      if (customerLink) {
        const customer = await base('Customer Record').find(customerLink);
        stripeCustomerId = customer.fields['Stripe Customer_ID'] || null;
      }
      found = true;
    }

    const choirRecords = await base('Choirs MASTER').select({ view: 'Choir CURRENT (SqSp Signup)' }).all();
    const choirs = choirRecords.map(r => ({ id: r.id, name: r.get('Name') }));

    const voiceRecords = await base('Voice Parts').select({ fields: ['Voice Part'], view: 'Voice Parts' }).firstPage();
    const voiceParts = voiceRecords.map(r => ({ id: r.id, name: r.fields['Voice Part'] }));

    return res.status(200).json({ found, firstName, surname, latestChoir, voicePart, stripeCustomerId, choirs, voiceParts });
  } catch (err) {
    console.error('Airtable error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
