const { env } = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { createApp } = require('./app');

const server = createApp().listen(env.PORT, () => logger.info(`API on :${env.PORT} · docs at /docs`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
