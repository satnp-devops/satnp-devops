import { consentAllows } from '../crm/consent.js';
import { CHANNEL_LABELS, PURPOSE_OF_CATEGORY } from './constants.js';

// Whether a message may go out: consent and opt-out (India's DPDP Act, 2023), WhatsApp's 24-hour
// rule and the SMS template rule. Pure, so every caller (people, automations, reminders) gets the
// same answer and unit tests pin it down.

const PURPOSE_WORDS = { marketing: 'marketing', transactional: 'transactional', service: 'service' };

/**
 * The consent purpose of a send. Templates send under their category's purpose and can't be
 * downgraded (a marketing template is marketing whatever the caller says); free text defaults to
 * "service" (a reply in a conversation) and may be raised to transactional or marketing.
 * @param {{ category?: string | null, purpose?: string | null }} input
 */
export function purposeFor({ category = null, purpose = null }) {
  if (category) {
    const fromCategory = PURPOSE_OF_CATEGORY[category];
    if (!fromCategory) throw new TypeError(`Unknown template category "${category}"`);
    return fromCategory === 'marketing' || purpose !== 'marketing' ? fromCategory : 'marketing';
  }
  return purpose ?? 'service';
}

/**
 * Decide a send. Checks run in this order and the first failure is the answer:
 *   1. opted_out                   the number or address is opted out of everything
 *   2. consent_withdrawn           the person withdrew consent for this purpose on this channel
 *      marketing_consent_missing   marketing needs a grant (transactional and service only need no withdrawal)
 *   3. template_not_approved       a template must have an approved version
 *   4. template_required           SMS sends registered templates only (TRAI DLT)
 *   5. outside_window              WhatsApp free text needs the 24-hour window open
 * @param {{
 *   channel: 'whatsapp' | 'email' | 'sms',
 *   purpose: 'marketing' | 'transactional' | 'service',
 *   consentStatus: 'granted' | 'withdrawn' | 'unknown',
 *   optedOut: boolean,
 *   content: 'template' | 'text',
 *   templateApproved?: boolean,
 *   window?: { open: boolean } | null,
 * }} input
 * @returns {{ allowed: true, reason: null, message: null } | { allowed: false, reason: string, message: string }}
 */
export function decideSend({ channel, purpose, consentStatus, optedOut, content, templateApproved = false, window = null }) {
  const label = CHANNEL_LABELS[channel] ?? channel;
  const refuse = (reason, message) => ({ allowed: false, reason, message });
  if (optedOut) return refuse('opted_out', `This ${channel === 'email' ? 'address' : 'number'} is opted out of all messages`);
  if (!consentAllows(consentStatus, purpose)) {
    if (consentStatus === 'withdrawn') return refuse('consent_withdrawn', `They withdrew consent to ${PURPOSE_WORDS[purpose]} messages on ${label}`);
    return refuse('marketing_consent_missing', `Marketing messages on ${label} need their consent first`);
  }
  if (content === 'template' && !templateApproved) return refuse('template_not_approved', 'This template is not approved yet');
  if (content === 'text' && channel === 'sms') return refuse('template_required', 'SMS can only send registered templates (DLT)');
  if (content === 'text' && channel === 'whatsapp' && !window?.open) {
    return refuse('outside_window', 'Outside the 24-hour window: send an approved template');
  }
  return { allowed: true, reason: null, message: null };
}

/** Does an inbound text ask to stop messages? Exact keyword match, ignoring case and punctuation. Pure. */
export function isOptOutText(text, keywords) {
  if (!text) return false;
  const clean = (value) =>
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  const normalized = clean(text);
  if (!normalized || normalized.length > 40) return false;
  return keywords.some((keyword) => clean(keyword) === normalized);
}

/** Parse the opt-out keywords setting ("STOP, UNSUBSCRIBE"). Pure. */
export function parseKeywords(value) {
  return String(value ?? '')
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);
}
