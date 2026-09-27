const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');
const { pool } = require('./db');
const { requireAuth, requireRole, requireTenant } = require('./middleware/auth');
const { tenantRateLimit } = require('./middleware/tenantRateLimit');
const { errorHandler } = require('./middleware/errors');
const authRoutes = require('./routes/auth');
const tenantRoutes = require('./routes/tenant');
const adminRoutes = require('./routes/admin');
const { billingRouter } = require('./routes/billing');

// Plans change rarely; cache lookups briefly so rate limiting doesn't hit the DB on every request.
const planCache = new Map();
async function planOf(tenantId) {
  const hit = planCache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.plan;
  const { rows } = await pool.query('SELECT plan FROM tenants WHERE id = $1', [tenantId]);
  const plan = rows[0]?.plan ?? 'free';
  planCache.set(tenantId, { plan, expires: Date.now() + 30_000 });
  return plan;
}

function createApp({ billing = billingRouter() } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.yaml'), 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

  app.use('/api/billing', billing);
  app.use(express.json({ limit: '200kb' }));

  app.use('/api/auth', tenantRateLimit({ planOf }), authRoutes);
  app.use('/api/admin', requireAuth, requireRole('superadmin'), adminRoutes);
  app.use('/api', requireAuth, requireTenant, tenantRateLimit({ planOf }), tenantRoutes);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
