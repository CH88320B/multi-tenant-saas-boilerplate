const express = require('express');
const Stripe = require('stripe');
const { z } = require('zod');
const { env } = require('../config');
const { withTenant, withBypass } = require('../db');
const { requireAuth, requireRole, requireTenant } = require('../middleware/auth');
const { HttpError, asyncHandler, validate } = require('../middleware/errors');
const { sendMail } = require('../services/mailer');
const logger = require('../logger');

const PRICE_TO_PLAN = () => ({
  [env.STRIPE_PRICE_PRO]: 'pro',
  [env.STRIPE_PRICE_ENTERPRISE]: 'enterprise',
});

function billingRouter({ stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 3 }) : null } = {}) {
  const router = express.Router();

  const ensureStripe = (_req, _res, next) => (stripe ? next() : next(new HttpError(503, 'Billing is not configured')));

  /** Stripe webhook: must receive the raw body, so it is mounted before express.json(). */
  router.post('/webhook', ensureStripe, express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new HttpError(400, 'Invalid signature');
    }

    if (!event.type.startsWith('customer.subscription.')) return res.json({ received: true, ignored: true });

    const sub = event.data.object;
    const priceId = sub.items?.data?.[0]?.price?.id;
    const active = ['active', 'trialing'].includes(sub.status) && event.type !== 'customer.subscription.deleted';
    const plan = active ? PRICE_TO_PLAN()[priceId] ?? 'free' : 'free';

    const changed = await withBypass(async (db) => {
      const { rowCount } = await db.query('INSERT INTO processed_stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.id]);
      if (!rowCount) return null; // duplicate delivery
      const { rows } = await db.query(
        'UPDATE tenants SET plan = $1, subscription_status = $2 WHERE stripe_customer_id = $3 RETURNING id, name, plan',
        [plan, sub.status, sub.customer],
      );
      return rows[0] ?? null;
    });

    if (changed) {
      logger.info({ tenant: changed.id, plan }, 'tenant plan updated');
      const admins = await withTenant(changed.id, async (db) => (await db.query("SELECT email FROM users WHERE role = 'admin'")).rows);
      for (const a of admins) sendMail(a.email, 'planChanged', { tenant: changed.name, plan });
    }
    return res.json({ received: true });
  }));

  router.use(express.json(), requireAuth, requireTenant, requireRole('admin'), ensureStripe);

  router.post('/checkout', asyncHandler(async (req, res) => {
    const { plan } = validate(z.object({ plan: z.enum(['pro', 'enterprise']) }), req.body);
    const price = plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_ENTERPRISE;
    if (!price) throw new HttpError(503, `No Stripe price configured for ${plan}`);

    const customer = await withTenant(req.auth.tenantId, async (db) => {
      const { rows: [tenant] } = await db.query('SELECT id, name, stripe_customer_id FROM tenants WHERE id = $1', [req.auth.tenantId]);
      if (tenant.stripe_customer_id) return tenant.stripe_customer_id;
      const created = await stripe.customers.create(
        { name: tenant.name, metadata: { tenant_id: tenant.id } },
        { idempotencyKey: `tenant-customer:${tenant.id}` },
      );
      await db.query('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2', [created.id, tenant.id]);
      return created.id;
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      success_url: `${env.APP_URL}/billing/success`,
      cancel_url: `${env.APP_URL}/billing`,
      subscription_data: { metadata: { tenant_id: req.auth.tenantId } },
    });
    res.status(201).json({ url: session.url });
  }));

  router.post('/portal', asyncHandler(async (req, res) => {
    const customer = await withTenant(req.auth.tenantId, async (db) =>
      (await db.query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [req.auth.tenantId])).rows[0]?.stripe_customer_id);
    if (!customer) throw new HttpError(400, 'No subscription yet. Start one with /billing/checkout');
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${env.APP_URL}/billing` });
    res.json({ url: portal.url });
  }));

  return router;
}

module.exports = { billingRouter };
