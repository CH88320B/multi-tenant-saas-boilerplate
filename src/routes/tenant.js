const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { withTenant } = require('../db');
const { SEAT_LIMITS } = require('../config');
const { requireRole } = require('../middleware/auth');
const { HttpError, asyncHandler, validate } = require('../middleware/errors');
const { sendMail } = require('../services/mailer');

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(['admin', 'user']).default('user'),
});
const roleSchema = z.object({ role: z.enum(['admin', 'user']) });
const projectSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional() });
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const router = express.Router();

// ----------------------------------------------------------------------------- users

router.get('/users', asyncHandler(async (req, res) => {
  const rows = await withTenant(req.auth.tenantId, async (db) =>
    (await db.query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at')).rows);
  res.json({ items: rows });
}));

router.post('/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const data = validate(inviteSchema, req.body);
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 10);

  const result = await withTenant(req.auth.tenantId, async (db) => {
    const { rows: [tenant] } = await db.query('SELECT name, plan FROM tenants WHERE id = $1', [req.auth.tenantId]);
    const { rows: [{ count }] } = await db.query('SELECT COUNT(*)::int AS count FROM users');
    if (count >= SEAT_LIMITS[tenant.plan]) {
      throw new HttpError(402, `The ${tenant.plan} plan allows ${SEAT_LIMITS[tenant.plan]} users. Upgrade to add more.`);
    }
    // RLS WITH CHECK rejects the insert if tenant_id does not match the transaction tenant.
    const { rows: [user] } = await db.query(
      'INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role',
      [req.auth.tenantId, data.email, data.name, hash, data.role],
    );
    const { rows: [inviter] } = await db.query('SELECT name FROM users WHERE id = $1', [req.auth.userId]);
    return { user, tenant, inviter };
  });

  sendMail(result.user.email, 'invite', { name: result.user.name, tenant: result.tenant.name, inviter: result.inviter?.name ?? 'Your admin', tempPassword });
  res.status(201).json(result.user);
}));

router.patch('/users/:id/role', requireRole('admin'), asyncHandler(async (req, res) => {
  const { role } = validate(roleSchema, req.body);
  if (req.params.id === req.auth.userId) throw new HttpError(400, 'You cannot change your own role');
  const user = await withTenant(req.auth.tenantId, async (db) =>
    (await db.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role', [role, req.params.id])).rows[0]);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
}));

router.delete('/users/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (req.params.id === req.auth.userId) throw new HttpError(400, 'You cannot remove yourself');
  const { rowCount } = await withTenant(req.auth.tenantId, (db) => db.query('DELETE FROM users WHERE id = $1', [req.params.id]));
  if (!rowCount) throw new HttpError(404, 'User not found');
  res.status(204).end();
}));

// ----------------------------------------------------------------------------- projects (example resource)

router.get('/projects', asyncHandler(async (req, res) => {
  const { limit, offset } = validate(pageSchema, req.query);
  const result = await withTenant(req.auth.tenantId, async (db) => ({
    items: (await db.query('SELECT * FROM projects ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])).rows,
    total: (await db.query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n,
  }));
  res.json(result);
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const data = validate(projectSchema, req.body);
  // No tenant_id in the INSERT: the column default reads app.tenant_id, so it cannot be spoofed.
  const project = await withTenant(req.auth.tenantId, async (db) => (await db.query(
    'INSERT INTO projects (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
    [data.name, data.description ?? null, req.auth.userId],
  )).rows[0]);
  res.status(201).json(project);
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await withTenant(req.auth.tenantId, async (db) =>
    (await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id])).rows[0]);
  if (!project) throw new HttpError(404, 'Project not found');
  res.json(project);
}));

router.delete('/projects/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { rowCount } = await withTenant(req.auth.tenantId, (db) => db.query('DELETE FROM projects WHERE id = $1', [req.params.id]));
  if (!rowCount) throw new HttpError(404, 'Project not found');
  res.status(204).end();
}));

module.exports = router;
