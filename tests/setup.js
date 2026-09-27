// Integration tests run against a real PostgreSQL (RLS cannot be faked).
// Locally: docker compose up -d db, then npm test.
process.env.NODE_ENV = 'test';
process.env.MIGRATION_DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/saas_test';
process.env.DATABASE_URL ??= 'postgres://app_user:app_user@localhost:5432/saas_test';
process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters';
