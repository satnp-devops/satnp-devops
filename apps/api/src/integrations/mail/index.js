import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Mail adapter. Every provider implements: send({ to, subject, text, html? }) → { id }.
 * Phase 3 moves this behind the integration framework with per-company connections
 * (Gmail, Microsoft 365, SES, SendGrid, ...). The console provider prints emails to the
 * worker log so invites and password resets work locally without an email account.
 */
const consoleProvider = {
  name: 'console',
  async send({ to, subject, text }) {
    const id = randomUUID();
    logger.info(
      { mail: { id, to, subject } },
      `\n----- EMAIL (console provider) -----\nFrom: ${env.MAIL_FROM}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n------------------------------------`,
    );
    return { id };
  },
};

const providers = { console: consoleProvider };

export function getMailer() {
  return providers[env.MAIL_PROVIDER] ?? consoleProvider;
}
