const { rateLimit } = require('express-rate-limit');
const { RATE_LIMITS } = require('../config');

/**
 * Per-tenant rate limiting: all users of a tenant share one budget sized by the tenant's plan,
 * so one noisy customer cannot degrade the service for others. Unauthenticated traffic is keyed by IP.
 * Uses the in-memory store; swap in rate-limit-redis when running more than one instance.
 */
function tenantRateLimit({ planOf }) {
  return rateLimit({
    windowMs: 60_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.auth?.tenantId ? `tenant:${req.auth.tenantId}` : `ip:${req.ip}`),
    limit: async (req) => (req.auth?.tenantId ? RATE_LIMITS[await planOf(req.auth.tenantId)] ?? RATE_LIMITS.free : 30),
    skip: (req) => req.auth?.role === 'superadmin',
    handler: (_req, res) => res.status(429).json({ error: 'Rate limit exceeded for your plan. Upgrade for higher limits.' }),
  });
}

module.exports = { tenantRateLimit };
