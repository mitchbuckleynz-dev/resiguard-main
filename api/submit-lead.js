// api/submit-lead.js
// Vercel serverless function for the Resiguard enquiry form.
//
// Two independent destinations, each attempted even if the other fails:
//   1. Odoo CRM lead  (needs env var: Odoo  = Odoo API key for ODOO_USER)
//   2. Email copy     (needs env var: RESEND_API_KEY; optional NOTIFY_TO, NOTIFY_FROM)
//
// Default notification recipient is mitch@sprinklerdesign.co.nz.

const ODOO_URL  = 'https://sdnz.odoo.com';
const ODOO_DB   = 'sdnz';
const ODOO_USER = 'mitch@sprinklerdesign.co.nz';

const NOTIFY_TO   = process.env.NOTIFY_TO   || 'mitch@sprinklerdesign.co.nz';
// Resend lets an account send from onboarding@resend.dev to the account owner's
// own address with no domain verification. Set NOTIFY_FROM once resiguard.co.nz
// is verified in Resend, e.g. "Resiguard Website <enquiries@resiguard.co.nz>".
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'Resiguard Website <onboarding@resend.dev>';

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- Odoo ----

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

  if (text.includes('<fault>')) {
    const msg = text.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string><\/value>/);
    throw new Error(msg ? msg[1].trim().split('\n').pop() : 'XML-RPC fault');
  }

  const int = text.match(/<value><int>(\d+)<\/int><\/value>/);
  if (int) return parseInt(int[1], 10);

  // authenticate() returns <boolean>0</boolean> on bad credentials
  if (/<boolean>0<\/boolean>/.test(text)) return false;

  return null;
}

async function createOdooLead({ name, email, phone, location }) {
  const apiKey = process.env.Odoo;
  if (!apiKey) throw new Error('Odoo env variable not set');

  const uid = await xmlrpc('/xmlrpc/2/common', 'authenticate', `
      <param><value><string>${ODOO_DB}</string></value></param>
      <param><value><string>${ODOO_USER}</string></value></param>
      <param><value><string>${esc(apiKey)}</string></value></param>
      <param><value><struct></struct></value></param>`);

  if (!uid) throw new Error(`Odoo rejected login for ${ODOO_USER} - API key invalid or expired`);

  const leadId = await xmlrpc('/xmlrpc/2/object', 'execute_kw', `
      <param><value><string>${ODOO_DB}</string></value></param>
      <param><value><int>${uid}</int></value></param>
      <param><value><string>${esc(apiKey)}</string></value></param>
      <param><value><string>crm.lead</string></value></param>
      <param><value><string>create</string></value></param>
      <param><value><array><data>
        <value><struct>
          <member><name>name</name><value><string>${esc(name)} - Resiguard Enquiry</string></value></member>
          <member><name>email_from</name><value><string>${esc(email)}</string></value></member>
          <member><name>phone</name><value><string>${esc(phone)}</string></value></member>
          <member><name>street</name><value><string>${esc(location)}</string></value></member>
          <member><name>description</name><value><string>Source: Resiguard landing page&#10;Location: ${esc(location) || 'Not provided'}&#10;Phone: ${esc(phone) || 'Not provided'}</string></value></member>
        </struct></value>
      </data></array></value></param>
      <param><value><struct></struct></value></param>`);

  if (!leadId) throw new Error('Odoo create returned no lead id');
  return leadId;
}

// --------------------------------------------------------------- Email ----

async function sendNotificationEmail({ name, email, phone, location }, odooResult) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY env variable not set');

  const when = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
  const crmLine = odooResult.ok
    ? `Odoo CRM lead #${odooResult.leadId} created.`
    : `Odoo CRM lead NOT created: ${odooResult.error}`;

  const row = (label, value) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#555;white-space:nowrap">${label}</td><td style="padding:6px 0"><strong>${esc(value) || '-'}</strong></td></tr>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">
      <h2 style="margin:0 0 12px">New Resiguard enquiry</h2>
      <table style="border-collapse:collapse">
        ${row('Name', name)}
        ${row('Email', email)}
        ${row('Phone', phone)}
        ${row('Location', location)}
        ${row('Received', when)}
      </table>
      <p style="margin:16px 0 0;color:#555;font-size:13px">${esc(crmLine)}</p>
      <p style="margin:4px 0 0;color:#555;font-size:13px">Reply to this email to respond to the customer directly.</p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: NOTIFY_TO.split(',').map((s) => s.trim()).filter(Boolean),
      reply_to: email,
      subject: `Resiguard enquiry: ${name}${location ? ` (${location})` : ''}`,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.id;
}

// ------------------------------------------------------------- Handler ----

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, location, phone } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  const lead = { name, email, phone, location };

  // 1. Odoo CRM
  let odoo = { ok: false, error: '' };
  try {
    const leadId = await createOdooLead(lead);
    odoo = { ok: true, leadId };
    console.log(`Odoo lead created. id=${leadId} name=${name} email=${email}`);
  } catch (err) {
    odoo.error = err.message;
    console.error('Odoo lead failed:', err.message);
  }

  // 2. Email copy - attempted regardless of the Odoo outcome
  let mail = { ok: false, error: '' };
  try {
    const id = await sendNotificationEmail(lead, odoo);
    mail = { ok: true, id };
    console.log(`Notification email sent. id=${id} to=${NOTIFY_TO}`);
  } catch (err) {
    mail.error = err.message;
    console.error('Notification email failed:', err.message);
  }

  if (!odoo.ok && !mail.ok) {
    // Nothing captured the enquiry. Tell the visitor so they use the fallback email.
    console.error(`ENQUIRY LOST - name=${name} email=${email} phone=${phone} location=${location}`);
    return res.status(502).json({ success: false, error: 'Unable to record enquiry' });
  }

  return res.status(200).json({
    success: true,
    crm: odoo.ok,
    email: mail.ok,
    ...(odoo.ok ? { leadId: odoo.leadId } : {}),
  });
};
