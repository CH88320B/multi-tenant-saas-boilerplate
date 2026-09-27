const nodemailer = require('nodemailer');
const { env } = require('../config');
const logger = require('../logger');

// Without SMTP_URL (tests, first run) messages are rendered to JSON and logged instead of sent.
const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : nodemailer.createTransport({ jsonTransport: true });

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (title, body) => `
  <div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px">
    <h2 style="margin:0 0 16px">${escape(title)}</h2>${body}
    <p style="color:#888;font-size:12px;margin-top:32px">You received this email because of your account at ${escape(env.APP_URL)}.</p>
  </div>`;

const templates = {
  welcome: ({ name, tenant }) => ({
    subject: `Welcome to ${tenant}!`,
    html: layout(`Welcome, ${name} 👋`, `<p>Your workspace <b>${escape(tenant)}</b> is ready.</p>`),
  }),
  invite: ({ name, tenant, inviter, tempPassword }) => ({
    subject: `${inviter} invited you to ${tenant}`,
    html: layout(`You're invited, ${name}`, `<p>${escape(inviter)} added you to <b>${escape(tenant)}</b>.</p>
      <p>Temporary password: <code>${escape(tempPassword)}</code><br/>Please change it after signing in.</p>`),
  }),
  planChanged: ({ tenant, plan }) => ({
    subject: `Your plan is now ${plan}`,
    html: layout('Subscription updated', `<p><b>${escape(tenant)}</b> is now on the <b>${escape(plan)}</b> plan.</p>`),
  }),
};

/** Fire-and-forget: email failures are logged but never fail the API request. */
async function sendMail(to, template, data) {
  try {
    const { subject, html } = templates[template](data);
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, html });
  } catch (err) {
    logger.error({ err, template, to }, 'email delivery failed');
  }
}

module.exports = { sendMail, templates };
