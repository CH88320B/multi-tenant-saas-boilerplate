const request = require('supertest');
const { Client } = require('pg');
const { migrate } = require('../scripts/migrate');

let app;
let pool;
let owner;

beforeAll(async () => {
  await migrate(process.env.MIGRATION_DATABASE_URL);
  owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  ({ createApp: app } = require('../src/app'));
  ({ pool } = require('../src/db'));
  app = app({ billing: require('express').Router() });
});

beforeEach(async () => {
  await owner.query('TRUNCATE tenants, users, projects, processed_stripe_events CASCADE');
});

afterAll(async () => {
  await owner.end();
  await pool.end();
});

let counter = 0;
async function signup(slug = `acme-${++counter}`) {
  const res = await request(app).post('/api/auth/signup').send({
    company: `Company ${slug}`, slug, name: 'Owner', email: `owner@${slug}.com`, password: 'password123',
  });
  expect(res.status).toBe(201);
  return { token: res.body.token, tenantId: res.body.user.tenant_id, userId: res.body.user.id };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('signup and login', () => {
  it('creates a tenant with an admin and logs in case-insensitively', async () => {
    await signup('globex');
    const res = await request(app).post('/api/auth/login').send({ email: 'OWNER@globex.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'admin' });
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('rejects duplicate slugs with 409', async () => {
    await signup('dup-co');
    const res = await request(app).post('/api/auth/signup').send({
      company: 'Other', slug: 'dup-co', name: 'X', email: 'x@other.com', password: 'password123',
    });
    expect(res.status).toBe(409);
  });

  it('returns the same error for unknown email and wrong password', async () => {
    await signup('initech');
    const a = await request(app).post('/api/auth/login').send({ email: 'owner@initech.com', password: 'wrong-pass' });
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@initech.com', password: 'wrong-pass' });
    expect(a.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });
});

describe('tenant isolation', () => {
  it('never exposes another tenant\'s projects', async () => {
    const a = await signup();
    const b = await signup();
    const created = await request(app).post('/api/projects').set(auth(a.token)).send({ name: 'Secret roadmap' });
    expect(created.body.tenant_id).toBe(a.tenantId);

    const listB = await request(app).get('/api/projects').set(auth(b.token));
    expect(listB.body.total).toBe(0);

    const getB = await request(app).get(`/api/projects/${created.body.id}`).set(auth(b.token));
    expect(getB.status).toBe(404);

    const delB = await request(app).delete(`/api/projects/${created.body.id}`).set(auth(b.token));
    expect(delB.status).toBe(404);
  });

  it('ignores a tenant_id smuggled in the request body', async () => {
    const a = await signup();
    const b = await signup();
    const res = await request(app).post('/api/projects').set(auth(a.token)).send({ name: 'x', tenant_id: b.tenantId });
    expect(res.body.tenant_id).toBe(a.tenantId);
  });

  it('enforces isolation in the database even without a WHERE clause', async () => {
    const a = await signup();
    await request(app).post('/api/projects').set(auth(a.token)).send({ name: 'A only' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)");
      const { rows } = await client.query('SELECT * FROM projects');
      expect(rows).toHaveLength(0);
      await client.query('ROLLBACK');

      // No tenant context at all: RLS hides everything.
      const { rows: none } = await client.query('SELECT * FROM projects');
      expect(none).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it('only lists users of the caller\'s tenant', async () => {
    const a = await signup();
    await signup();
    const res = await request(app).get('/api/users').set(auth(a.token));
    expect(res.body.items).toHaveLength(1);
  });
});

describe('roles and plans', () => {
  it('lets admins invite users but not regular users', async () => {
    const a = await signup();
    const invited = await request(app).post('/api/users').set(auth(a.token)).send({ email: 'dev@acme.com', name: 'Dev' });
    expect(invited.status).toBe(201);

    const { rows: [u] } = await owner.query('SELECT * FROM users WHERE id = $1', [invited.body.id]);
    const { signToken } = require('../src/middleware/auth');
    const userToken = signToken(u);

    const forbidden = await request(app).post('/api/users').set(auth(userToken)).send({ email: 'x@acme.com', name: 'X' });
    expect(forbidden.status).toBe(403);
  });

  it('enforces the seat limit of the free plan', async () => {
    const a = await signup();
    for (const i of [1, 2]) {
      expect((await request(app).post('/api/users').set(auth(a.token)).send({ email: `u${i}@acme.com`, name: `U${i}` })).status).toBe(201);
    }
    const over = await request(app).post('/api/users').set(auth(a.token)).send({ email: 'u3@acme.com', name: 'U3' });
    expect(over.status).toBe(402);
  });

  it('restricts platform endpoints to superadmins', async () => {
    const a = await signup();
    expect((await request(app).get('/api/admin/tenants').set(auth(a.token))).status).toBe(403);

    const { rows: [sa] } = await owner.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ('ops@platform.com', 'Ops', 'x', 'superadmin') RETURNING *",
    );
    const { signToken } = require('../src/middleware/auth');
    const res = await request(app).get('/api/admin/tenants').set(auth(signToken(sa)));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ users: 1, plan: 'free' });
  });

  it('rejects requests without a token', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
  });
});
