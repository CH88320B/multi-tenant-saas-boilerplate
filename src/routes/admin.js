const express = require('express');
const { z } = require('zod');
const { withBypass } = require('../db');
const { asyncHandler, validate, HttpError } = require('../middleware/errors');

/** Platform-operator endpoints (superadmin only): see and manage every tenant. */
const router = express.Router();

router.get('/tenants', asyncHandler(async (_req, res) => {
  const rows = await withBypass(async (db) => (await db.query(`
    SELECT t.id, t.name, t.slug, t.plan, t.subscription_status, t.created_at,
           (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
           (SELECT COUNT(*)::int FROM projects p WHERE p.tenant_id = t.id) AS projects
    FROM tenants t ORDER BY t.created_at DESC`)).rows);
  res.json({ items: rows });
}));

router.patch('/tenants/:id/plan', asyncHandler(async (req, res) => {
  const { plan } = validate(z.object({ plan: z.enum(['free', 'pro', 'enterprise']) }), req.body);
  const tenant = await withBypass(async (db) =>
    (await db.query('UPDATE tenants SET plan = $1 WHERE id = $2 RETURNING id, name, plan', [plan, req.params.id])).rows[0]);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  res.json(tenant);
}));

router.delete('/tenants/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await withBypass((db) => db.query('DELETE FROM tenants WHERE id = $1', [req.params.id]));
  if (!rowCount) throw new HttpError(404, 'Tenant not found');
  res.status(204).end();
}));

module.exports = router;
