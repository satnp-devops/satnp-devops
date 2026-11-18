// Response and request types of the messaging API (docs/platform/MESSAGING.md). The server's
// presenters (apps/api/src/modules/messaging/present.js and context.js) produce exactly these.

export type MessageChannel = 'whatsapp' | 'email' | 'sms';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
export type MessagePurpose = 'marketing' | 'transactional' | 'service';
export type ConsentState = 'granted' | 'withdrawn' | 'unknown';
export type TemplateCategory = 'utility' | 'marketing' | 'authentication';
export type TemplateStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type BlockReason =
  | 'opted_out'
  | 'consent_withdrawn'
  | 'marketing_consent_missing'
  | 'template_not_approved'
  | 'template_required'
  | 'outside_window'
  | 'no_address'
  | 'erased';

export interface MediaRef {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'other';
  url?: string;
  fileId?: string;
  mimeType?: string;
  caption?: string;
  fileName?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  companyId: string;
  contactId: string;
  dealId: string | null;
  channel: MessageChannel;
  direction: MessageDirection;
  status: MessageStatus;
  purpose: MessagePurpose | null;
  template: { id: string | null; name: string; version: number | null } | null;
  variables: Record<string, string>;
  subject: string | null;
  body: string | null;
  media: MediaRef[];
  /** Masked ("+91 •••••••210") without contacts.view_pii. */
  to: string | null;
  from: string | null;
  piiMasked: boolean;
  provider: string | null;
  providerMessageId: string | null;
  source: 'crm' | 'provider' | 'whatsapp_tool';
  actorType: 'user' | 'system' | 'ai' | 'contact';
  sentBy: { id: string; name: string } | null;
  agent: { type: 'bot' | 'human'; name: string | null } | null;
  error: { code: string; message: string } | null;
  occurredAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface TemplateHeader {
  type: 'text';
  text: string;
}

export type TemplateButton =
  | { type: 'quick_reply'; text: string }
  | { type: 'url'; text: string; url: string }
  | { type: 'phone'; text: string; phone: string };

/** What a template says: the fields the editor changes. */
export interface TemplateContent {
  header: TemplateHeader | null;
  subject: string | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  samples: Record<string, string>;
  providerTemplateName: string | null;
  providerTemplateId: string | null;
}

export interface TemplateVersion extends TemplateContent {
  version: number;
  status: TemplateStatus;
  rejectionReason: string | null;
  createdAt: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
}

export interface MessageTemplate {
  id: string;
  companyId: string;
  channel: MessageChannel;
  name: string;
  language: string;
  category: TemplateCategory;
  purpose: MessagePurpose;
  description: string | null;
  /** The latest version's status. */
  status: TemplateStatus;
  latestVersion: number;
  /** The version sends use, when one is approved. */
  approvedVersion: number | null;
  latest: TemplateVersion | null;
  live: TemplateVersion | null;
  variables: string[];
  /** The body as the provider registers it ({{1}}, {{2}}…). */
  providerBody: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  can: { manage: boolean };
}

export interface MessageTemplateDetail extends MessageTemplate {
  versions: TemplateVersion[];
}

export interface TemplateCreateBody extends Partial<TemplateContent> {
  companyId: string;
  channel: MessageChannel;
  name: string;
  language: string;
  category: TemplateCategory;
  description?: string | null;
  body: string;
}

export type TemplateUpdateBody = Partial<TemplateContent> & { category?: TemplateCategory; description?: string | null };

/** An approved template as the reply box offers it (its live version). */
export interface ReplyTemplate {
  id: string;
  channel: MessageChannel;
  name: string;
  language: string;
  category: TemplateCategory;
  purpose: MessagePurpose;
  version: number;
  header: TemplateHeader | null;
  subject: string | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  samples: Record<string, string>;
  variables: string[];
}

export interface CustomerServiceWindow {
  open: boolean;
  lastInboundAt: string | null;
  expiresAt: string | null;
  remainingSeconds: number;
}

export interface ReplyConnection {
  id: string | null;
  name: string;
  provider: string;
  mock: boolean;
  fallback: boolean;
}

export interface ReplyAddress {
  methodId: string;
  kind: 'phone' | 'whatsapp' | 'email';
  /** Masked without contacts.view_pii. */
  value: string;
  label: string | null;
  isPrimary: boolean;
  optedOut: boolean;
  conversationId: string | null;
  handledBy: 'bot' | 'human' | 'crm' | null;
  connection: ReplyConnection | null;
  connectionError: string | null;
  /** WhatsApp only. */
  window: CustomerServiceWindow | null;
}

export interface ReplyChannel {
  channel: MessageChannel;
  label: string;
  /** SMS sends registered templates only. */
  freeText: boolean;
  available: boolean;
  unavailableReason: string | null;
  defaultMethodId: string | null;
  addresses: ReplyAddress[];
  consent: Record<MessagePurpose, ConsentState>;
}

export interface ReplyContext {
  company: { id: string; name: string; code: string };
  contact: { id: string; displayName: string; firstName: string | null; kind: string; erased: boolean; piiMasked: boolean };
  deal: { id: string; ref: string; title: string; status: string; owner: { id: string; name: string } | null } | null;
  can: { send: boolean };
  channels: ReplyChannel[];
  templates: ReplyTemplate[];
  /** Values for the standard variables (first_name, contact_name, company_name, deal_ref, owner_name). */
  defaults: Record<string, string>;
}

export interface SendMessageBody {
  dealId?: string;
  contactId?: string;
  companyId?: string;
  channel: MessageChannel;
  methodId?: string;
  templateId?: string;
  variables?: Record<string, string>;
  text?: string;
  subject?: string;
  purpose?: MessagePurpose;
  /** Retrying with the same id never sends twice. */
  clientId?: string;
}

/** The reply box and message lists are about a deal, or a person in one company. */
export interface MessagingSubject {
  dealId?: string;
  contactId?: string;
  companyId?: string;
}

export interface DevDeal {
  id: string;
  ref: string;
  title: string;
  company: { id: string; name: string };
  contact: { id: string; displayName: string };
}
