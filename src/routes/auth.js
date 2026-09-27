const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { transaction, withBypass } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { HttpError, asyncHandler, validate } = require('../middleware/errors');
const { sendMail } = require('../services/mailer');

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8).max(72);

const signupSchema = z.object({
  company: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'lowercase letters, digits and hyphens (3-40)'),
  name: z.string().trim().min(1).max(80),
  email,
  password,
});
const loginSchema = z.object({ email, password: z.string().min(1) });

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const router = express.Router();

/** Self-service signup: creates the tenant and its first admin atomically. */
router.post('/signup', asyncHandler(async (req, res) => {
  const data = validate(signupSchema, req.body);
  const hash = await bcrypt.hash(data.password, 10);

  const user = await transaction(async (db) => {
    const { rows: [tenant] } = await db.query('INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id', [data.company, data.slug]);
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
    const { rows: [u] } = await db.query(
      "INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin') RETURNING id, tenant_id, email, name, role",
      [tenant.id, data.email, data.name, hash],
    );
    return u;
  });

  sendMail(user.email, 'welcome', { name: user.name, tenant: data.company });
  res.status(201).json({ token: signToken(user), user });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email: e, password: p } = validate(loginSchema, req.body);
  // Email lookup happens before we know the tenant, so it is one of the few bypass paths.
  const user = await withBypass(async (db) => (await db.query('SELECT * FROM users WHERE email = $1', [e])).rows[0]);
  const ok = await bcrypt.compare(p, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');

  const { password_hash: _ignored, ...publicUser } = user;
  res.json({ token: signToken(user), user: publicUser });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const me = await withBypass(async (db) => (await db.query(
    `SELECT u.id, u.email, u.name, u.role, t.id AS tenant_id, t.name AS tenant_name, t.plan
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.auth.userId],
  )).rows[0]);
  if (!me) throw new HttpError(404, 'User not found');
  res.json(me);
}));

module.exports = router;
