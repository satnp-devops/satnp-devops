import { AppError, errors } from '../lib/errors.js';
import { PG } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler() {
  throw errors.notFound('Route');
}

// Express recognises error handlers by their four arguments.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const log = req.log ?? logger;
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.status >= 500) log.error({ err }, err.message);
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON', requestId } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'The request is too large', requestId } });
  }
  if (err?.code === PG.UNIQUE_VIOLATION) {
    return res.status(409).json({
      error: { code: 'conflict', message: 'Something with these details already exists', details: { constraint: err.constraint }, requestId },
    });
  }
  if (err?.code === PG.FOREIGN_KEY_VIOLATION) {
    return res.status(409).json({ error: { code: 'conflict', message: 'This is still linked to other records', requestId } });
  }

  log.error({ err }, 'Unhandled error');
  return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.', requestId } });
}
