// api/submit-lead.js
// Vercel serverless function — uses Odoo XML-RPC (stateless, no session cookie needed)

const ODOO_URL  = 'https://sdnz.odoo.com';
const ODOO_DB   = 'sdnz';
const ODOO_USER = 'mitch@sprinklerdesign.co.nz';

// Simple XML-RPC call helper
async function xmlrpc(endpoint, method, params) {
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${params}</params>
</methodCall>`;

  const res = await fetch(`${ODOO_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });

  const text = await res.text();

  // Pull value out of XML response
  const match = text.match(/<value><int>(\d+)<\/int><\/value>/);
  if (match) return parseInt(match[1], 10);

  // Check for fault
  if (text.includes('<fault>')) {
    const msg = text.match(/<value><string>(.*?)<\/string><\/value>/s);
    throw new Error(msg ? msg[1] : 'XML-RPC fault');
  }

  return null;
}

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.Odoo;
  if (!apiKey) {
    console.error('Odoo env variable not set');
    return res.status(500).json({ error: 'Server config error' });
  }

  const { name, email, location, phone } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  try {
    // Step 1: Authenticate — get uid
    const uid = await xmlrpc(
      '/xmlrpc/2/common',
      'authenticate',
      `
      <param><value><string>${ODOO_DB}</string></value></param>
      <param><value><string>${ODOO_USER}</string></value></param>
      <param><value><string>${apiKey}</string></value></param>
      <param><value><struct></struct></value></param>
      `
    );

    if (!uid) throw new Error('Odoo authentication failed — check API key');
    console.log(`Odoo auth OK. uid=${uid}`);

    // Step 2: Create CRM lead
    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const leadXml = `
      <param><value><string>${ODOO_DB}</string></value></param>
      <param><value><int>${uid}</int></value></param>
      <param><value><string>${apiKey}</string></value></param>
      <param><value><string>crm.lead</string></value></param>
      <param><value><string>create</string></value></param>
      <param><value><array><data>
        <value><struct>
          <member><name>name</name><value><string>${esc(name)} — Resiguard Enquiry</string></value></member>
          <member><name>email_from</name><value><string>${esc(email)}</string></value></member>
          <member><name>phone</name><value><string>${esc(phone)}</string></value></member>
          <member><name>street</name><value><string>${esc(location)}</string></value></member>
          <member><name>description</name><value><string>Source: Resiguard landing page&#10;Location: ${esc(location) || 'Not provided'}&#10;Phone: ${esc(phone) || 'Not provided'}</string></value></member>
        </struct></value>
      </data></array></value></param>
      <param><value><struct></struct></value></param>
    `;

    const leadId = await xmlrpc('/xmlrpc/2/object', 'execute_kw', leadXml);

    console.log(`Lead created. Odoo ID: ${leadId}, Name: ${name}, Email: ${email}`);
    return res.status(200).json({ success: true, leadId });

  } catch (err) {
    console.error('submit-lead error:', err.message);
    // Always return success to the user — never show backend errors
    return res.status(200).json({ success: true, fallback: true });
  }
};
