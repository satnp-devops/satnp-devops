// Labels, tones and the window wording of the messaging screens.

import type { IconName } from '@/components/icons';
import type { PillTone } from '@/components/crm';
import type { ConsentState, CustomerServiceWindow, MessageChannel, MessagePurpose, MessageStatus, TemplateCategory, TemplateStatus } from './types';

export const MESSAGE_CHANNELS: MessageChannel[] = ['whatsapp', 'email', 'sms'];

export const CHANNEL_NAMES: Record<MessageChannel, string> = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' };
export const CHANNEL_ICONS: Record<MessageChannel, IconName> = { whatsapp: 'whatsapp', email: 'mail', sms: 'message' };

export const CATEGORY_NAMES: Record<TemplateCategory, string> = { utility: 'Utility', marketing: 'Marketing', authentication: 'Authentication' };
export const CATEGORY_HINTS: Record<TemplateCategory, string> = {
  utility: 'Booking links, reminders, receipts. Sent unless the person withdrew consent.',
  marketing: 'Offers, newsletters, welcome series. Needs the person’s marketing consent.',
  authentication: 'Verification codes. Sent unless the person withdrew consent.',
};

export const TEMPLATE_STATUS: Record<TemplateStatus, { label: string; tone: PillTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Waiting for approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export const MESSAGE_STATUS: Record<MessageStatus, { label: string; tone: PillTone }> = {
  queued: { label: 'Sending', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'neutral' },
  delivered: { label: 'Delivered', tone: 'accent' },
  read: { label: 'Read', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  received: { label: 'Received', tone: 'neutral' },
};

export const PURPOSE_NAMES: Record<MessagePurpose, string> = { marketing: 'marketing', transactional: 'transactional', service: 'service' };

export const LANGUAGE_NAMES: Record<string, string> = { en: 'English', hi: 'Hindi', mr: 'Marathi', ta: 'Tamil', te: 'Telugu', bn: 'Bengali', gu: 'Gujarati', kn: 'Kannada', en_US: 'English (US)', en_GB: 'English (UK)' };
export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

/** Whether consent lets a purpose through: marketing needs a grant; the others only need no withdrawal. */
export function consentAllows(state: ConsentState, purpose: MessagePurpose): boolean {
  return purpose === 'marketing' ? state === 'granted' : state !== 'withdrawn';
}

/** "13 h", "45 min", "under a minute". */
export function formatRemaining(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return 'under a minute';
}

/**
 * The reply box's window line: "Free text allowed for 13 h more" or
 * "Outside the 24-hour window: send a template". `now` keeps it ticking without a refetch.
 */
export function windowLabel(window: CustomerServiceWindow | null, now: number = Date.now()): { open: boolean; text: string } {
  if (!window?.expiresAt) return { open: false, text: 'Outside the 24-hour window: send a template' };
  const remaining = Math.floor((new Date(window.expiresAt).getTime() - now) / 1000);
  if (remaining <= 0) return { open: false, text: 'Outside the 24-hour window: send a template' };
  return { open: true, text: `Free text allowed for ${formatRemaining(remaining)} more` };
}

/** A fresh idempotency key for one send (retries of the same send reuse it). */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
