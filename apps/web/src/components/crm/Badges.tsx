'use client';

import type { ReactNode } from 'react';
import { channelLabel, formatInZone, isChannelKey, slaStatus, type ChannelKey, type DateInput } from '@/lib/crm/format';
import { Icon, type IconName } from '../icons';
import { cx } from '../ui';
import { useNow } from './hooks';
import './crm.css';

export type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

/**
 * A status in words with a coloured dot: green #067647, amber #9A4A00, red #B42318 or neutral.
 * The words carry the meaning; colour only reinforces it.
 */
export function StatusPill({
  tone = 'neutral',
  icon,
  title,
  children,
}: {
  tone?: PillTone;
  /** Replaces the dot. */
  icon?: IconName;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx('crm-pill', tone !== 'neutral' && `crm-pill--${tone}`)} title={title}>
      {icon ? <Icon name={icon} size={13} /> : <span className="crm-pill__dot" aria-hidden="true" />}
      <span className="crm-pill__text">{children}</span>
    </span>
  );
}

/** The yellow "New" highlight (#FFE27A) for records nobody has opened yet. */
export function NewBadge({ children = 'New', title }: { children?: ReactNode; title?: string }) {
  return (
    <span className="badge badge--new crm-new" title={title}>
      {children}
    </span>
  );
}

/**
 * Time left on a deadline (first reply, task): "Due in 25 min" turns amber close to the
 * deadline and red once it's passed; with `completedAt` it shows whether it was met.
 */
export function SlaBadge({
  dueAt,
  completedAt,
  warnWithinMinutes = 60,
  prefix,
}: {
  dueAt: DateInput;
  completedAt?: DateInput;
  warnWithinMinutes?: number;
  /** Names the deadline: prefix "Reply" gives "Reply due in 25 min". */
  prefix?: string;
}) {
  const now = useNow();
  const status = slaStatus(dueAt, { completedAt, now, warnWithinMinutes });
  if (!status) return null;
  const text = prefix ? `${prefix} ${status.label.charAt(0).toLowerCase()}${status.label.slice(1)}` : status.label;
  return (
    <StatusPill tone={status.tone} icon={status.overdue ? 'alert' : status.tone === 'success' ? 'check' : 'clock'} title={`Due ${formatInZone(dueAt)}`}>
      {text}
    </StatusPill>
  );
}

const CHANNEL_ICONS: Record<ChannelKey, IconName> = {
  whatsapp: 'whatsapp',
  website_form: 'form',
  website_checkout: 'cart',
  voice_call: 'phone',
  email: 'mail',
  lead_ad_instagram: 'instagram',
  lead_ad_facebook: 'facebook',
  partner_referral: 'link',
  csv_import: 'upload',
  manual: 'edit',
};

/** The icon for a channel; channels added later by configuration get a neutral dot. */
export function channelIcon(channel: string): IconName {
  return isChannelKey(channel) ? CHANNEL_ICONS[channel] : 'dot';
}

/** Where an enquiry came from: icon and name ("WhatsApp", "Instagram lead ad"). */
export function ChannelBadge({ channel, iconOnly = false }: { channel: ChannelKey | (string & {}); iconOnly?: boolean }) {
  const label = channelLabel(channel);
  return (
    <span className="crm-channel" title={iconOnly ? label : undefined}>
      <span className="crm-channel__icon" aria-hidden="true">
        <Icon name={channelIcon(channel)} size={14} />
      </span>
      <span className={iconOnly ? 'visually-hidden' : 'crm-channel__label'}>{label}</span>
    </span>
  );
}
