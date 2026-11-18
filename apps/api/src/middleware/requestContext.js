import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/**
 * Query parameters whose values never reach the log: search text (people search by name, phone
 * number or email address, which is personal data under the DPDP Act) and secrets (a provider's
 * webhook verify token, signatures, codes).
 */
const SENSITIVE_PARAM = /^(q|query|search|term|email|phone|mobile|token|code|otp|secret|signature|sig|key|password|hub\.verify_token)$/i;

function paramName(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** The URL as the request log keeps it: long tokens and sensitive query values replaced by [redacted]. */
export function redactUrl(originalUrl) {
  const url = String(originalUrl ?? '');
  const at = url.indexOf('?');
  const path = (at === -1 ? url : url.slice(0, at)).replace(LONG_TOKEN, '[redacted]');
  if (at === -1) return path;
  const query = url
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair.replace(LONG_TOKEN, '[redacted]');
      const name = pair.slice(0, eq);
      return SENSITIVE_PARAM.test(paramName(name)) ? `${name}=[redacted]` : pair.replace(LONG_TOKEN, '[redacted]');
    })
    .join('&');
  return `${path}?${query}`;
}

/** Request id, a per-request logger, and one log line per request. */
export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.set('x-request-id', req.id);
  req.log = logger.child({ requestId: req.id });

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    req.log.info(
      {
        method: req.method,
        url: redactUrl(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(ms),
        userId: req.auth?.user?.id,
      },
      'request',
    );
  });
  next();
}
