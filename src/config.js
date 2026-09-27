require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url(),                 // app_user (RLS applies)
  MIGRATION_DATABASE_URL: z.string().url().optional(), // owner role, used only by migrations
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('1h'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  SMTP_URL: z.string().optional(),                // e.g. smtp://user:pass@smtp.mailtrap.io:2525
  MAIL_FROM: z.string().default('SaaS App <no-reply@example.com>'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
}

const env = parsed.data;

/** Requests per minute per tenant, by plan. */
const RATE_LIMITS = { free: 60, pro: 600, enterprise: 3000 };
/** Seats (users) per tenant, by plan. */
const SEAT_LIMITS = { free: 3, pro: 25, enterprise: Infinity };

module.exports = { env, RATE_LIMITS, SEAT_LIMITS };
