import type { PillTone } from '@/components/crm';
import type { JobStatus, WebhookStatus } from './types';

// Labels and tones for the delivery log and the job list.

export const WEBHOOK_STATUS_LABEL: Record<WebhookStatus, string> = {
  queued: 'Waiting',
  processing: 'Processing',
  retrying: 'Retrying',
  processed: 'Processed',
  failed: 'Dead letter',
  rejected: 'Rejected',
};

export const WEBHOOK_STATUS_TONE: Record<WebhookStatus, PillTone> = {
  queued: 'neutral',
  processing: 'accent',
  retrying: 'warning',
  processed: 'success',
  failed: 'danger',
  rejected: 'danger',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const JOB_STATUS_TONE: Record<JobStatus, PillTone> = {
  queued: 'neutral',
  running: 'accent',
  retrying: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** "payment.captured" → "Payment captured". */
export function eventTypeLabel(type: string | null): string {
  if (!type) return 'Rejected delivery';
  const text = type.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The URL a provider is configured with, on this server's origin. */
export function webhookUrl(origin: string, provider: string, connectionId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/v1/webhooks/${provider}/${connectionId}`;
}
