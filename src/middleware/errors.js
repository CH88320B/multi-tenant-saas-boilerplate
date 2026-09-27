const logger = require('../logger');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validates with a zod schema or throws a 400 with field details. */
function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'Validation failed', result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

// PostgreSQL error codes worth translating instead of returning 500.
const PG_ERRORS = {
  23505: [409, 'A record with that value already exists'],
  23503: [409, 'Referenced record does not exist or is still in use'],
  '22P02': [400, 'Invalid identifier format'],
  42501: [403, 'Access denied by row-level security'],
};

function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
  }
  if (PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code];
    return res.status(status).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  logger.error({ err, path: req.path }, 'unhandled error');
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, asyncHandler, validate, errorHandler };
