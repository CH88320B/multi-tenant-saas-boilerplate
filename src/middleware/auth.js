const jwt = require('jsonwebtoken');
const { env } = require('../config');
const { HttpError } = require('./errors');

const ISSUER = 'saas-boilerplate';

function signToken(user) {
  return jwt.sign({ sub: user.id, tid: user.tenant_id, role: user.role }, env.JWT_SECRET, {
    issuer: ISSUER,
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

/** Attaches req.auth = { userId, tenantId, role } from a valid bearer token. */
function requireAuth(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Missing bearer token'));
  try {
    const claims = jwt.verify(token, env.JWT_SECRET, { issuer: ISSUER, algorithms: ['HS256'] });
    req.auth = { userId: claims.sub, tenantId: claims.tid ?? null, role: claims.role };
    return next();
  } catch {
    return next(new HttpError(401, 'Invalid or expired token'));
  }
}

/** Role hierarchy: superadmin > admin > user. */
const RANK = { user: 1, admin: 2, superadmin: 3 };

const requireRole = (minimum) => (req, _res, next) =>
  RANK[req.auth?.role] >= RANK[minimum] ? next() : next(new HttpError(403, `Requires ${minimum} role`));

/** Tenant-scoped routes need a tenant in the token (superadmins act through /admin routes). */
function requireTenant(req, _res, next) {
  return req.auth?.tenantId ? next() : next(new HttpError(403, 'This endpoint requires a tenant account'));
}

module.exports = { signToken, requireAuth, requireRole, requireTenant };
