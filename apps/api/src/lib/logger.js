import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'phoenix-api' },
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    remove: true,
  },
});
