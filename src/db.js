const { Pool } = require('pg');
const { env } = require('./config');

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

/**
 * Runs `fn` in a transaction scoped to one tenant. SET LOCAL makes the setting vanish at
 * COMMIT/ROLLBACK, so a pooled connection can never leak one tenant's context into another request.
 */
async function withTenant(tenantId, fn) {
  return transaction(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(client);
  });
}

/** Cross-tenant access for trusted paths only (login lookup, superadmin, billing webhooks). */
async function withBypass(fn) {
  return transaction(async (client) => {
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    return fn(client);
  });
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant, withBypass, transaction };
