// Usage: node scripts/create-superadmin.js ops@example.com "Ops Team" 'a-strong-password'
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function main([email, name, password]) {
  if (!email || !name || !password || password.length < 12) {
    throw new Error('Usage: create-superadmin <email> <name> <password (12+ chars)>');
  }
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'superadmin') ON CONFLICT (email) DO NOTHING",
      [email.toLowerCase(), name, await bcrypt.hash(password, 12)],
    );
    console.log(`superadmin ${email} ready`);
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
