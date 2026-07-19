// api/submit-lead.js
// Vercel serverless function — keeps Odoo credentials server-side

const ODOO_URL = 'https://sdnz.odoo.com';
const ODOO_DB  = 'sdnz';
const ODOO_USER = 'mitch@sprinklerdesign.co.nz';

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — allow requests from your Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { name, email, location, phone } = req.body;

  // Basic validation
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  const apiKey = process.env.Odoo;
  if (!apiKey) {
    console.error('Odoo environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // Step 1: Authenticate with Odoo
    const authRes = await fetch(`${ODOO_URL}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: 1,
        params: {
          db: ODOO_DB,
          login: ODOO_USER,
          password: apiKey,
        },
      }),
    });

    const authData = await authRes.json();

    if (!authData.result || !authData.result.uid) {
      console.error('Odoo auth failed:', authData);
      throw new Error('Odoo authentication failed');
    }

    // Extract session cookie for subsequent calls
    const sessionCookie = authRes.headers.get('set-cookie');

    // Step 2: Create CRM Lead
    const leadRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: 2,
        params: {
          model: 'crm.lead',
          method: 'create',
          args: [{
            name:        `${name} — Resiguard Enquiry`,
            email_from:  email,
            phone:       phone || '',
            street:      location || '',
            description: `Lead source: Resiguard landing page\nLocation: ${location || 'Not provided'}\nPhone: ${phone || 'Not provided'}`,
            tag_ids:     [],           // Add Odoo tag IDs here if you want e.g. [6, 0, [your_tag_id]]
          }],
          kwargs: {},
        },
      }),
    });

    const leadData = await leadRes.json();

    if (leadData.error) {
      console.error('Odoo lead creation error:', leadData.error);
      throw new Error(leadData.error.data?.message || 'Lead creation failed');
    }

    console.log(`Lead created in Odoo. ID: ${leadData.result}, Name: ${name}, Email: ${email}`);
    return res.status(200).json({ success: true, leadId: leadData.result });

  } catch (err) {
    console.error('submit-lead error:', err.message);
    // Return success to user anyway — don't expose internal errors
    return res.status(200).json({ success: true, fallback: true });
  }
}
