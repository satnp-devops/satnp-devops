// Response and request types of the intake API (apps/api/src/modules/intake/present.js).

export type Audience = 'b2c' | 'b2b';
export type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'number' | 'checkbox' | 'hidden';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  maps: string | null;
  options: Array<{ value: string; label: string }>;
  placeholder?: string | null;
  help?: string | null;
  defaultValue?: string | null;
}

export interface FormConsent {
  text?: string;
  required: boolean;
  channels: Array<'whatsapp' | 'calls' | 'marketing'>;
}

export interface FormSpam {
  honeypot: boolean;
  minSeconds: number;
  captcha: 'none' | 'turnstile' | 'recaptcha' | 'hcaptcha';
  captchaSiteKey?: string;
  allowedOrigins: string[];
  perIpPerHour: number;
}

export type ThankYou = { mode: 'message'; message: string } | { mode: 'redirect'; redirectUrl: string };

export interface IntakeForm {
  id: string;
  companyId: string;
  unitId: string;
  key: string;
  name: string;
  kind: 'enquiry' | 'checkout';
  audience: Audience;
  productLineId: string | null;
  fields: FormField[];
  consent: FormConsent;
  spam: FormSpam;
  thankYou: ThankYou;
  active: boolean;
  hasSigningSecret: boolean;
  submissionCount: number;
  spamCount: number;
  lastSubmissionAt: string | null;
  url: string | null;
  embed: { url: string; iframe: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Only in the create and rotate responses of checkout forms. */
  signingSecret?: string;
}

export interface PublicForm {
  key: string;
  name: string;
  fields: Array<Pick<FormField, 'key' | 'label' | 'type' | 'required' | 'options'> & { placeholder: string | null; help: string | null }>;
  consent: { text: string; required: boolean } | null;
  spam: { honeypot: boolean; captcha: FormSpam['captcha']; captchaSiteKey: string | null };
  thankYou: ThankYou;
  token: string;
}

export interface ChannelIdentity {
  id: string;
  type: string;
  identity: string;
  identityNormalized: string;
  companyId: string | null;
  unitId: string | null;
  productLineId: string | null;
  shared: boolean;
  companyIds: string[];
  label: string | null;
  active: boolean;
  createdAt: string;
}

export interface PoolMember {
  userId: string;
  name: string | null;
  capacity: number | null;
  languages: string[];
  timeZone: string | null;
  active: boolean;
  awayUntil: string | null;
  openLeads: number;
  assigned: number;
}

export interface AssignmentPool {
  id: string;
  companyId: string;
  unitId: string;
  name: string;
  kind: Audience | null;
  productLineIds: string[];
  isDefault: boolean;
  languageMatch: 'prefer' | 'require' | 'ignore';
  workingHours: 'prefer' | 'require' | 'ignore';
  timeZoneMatch: 'prefer' | 'ignore';
  position: number;
  active: boolean;
  members: PoolMember[];
}

export interface PartnerLink {
  id: string;
  companyId: string;
  code: string;
  partnerId: string;
  partnerName: string;
  ownerUserId: string | null;
  productLineId: string | null;
  formId: string | null;
  url: string | null;
  clickCount: number;
  active: boolean;
  createdAt: string;
}

export interface EnquiryPerson {
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  studentName: string | null;
  grade: string | null;
  instituteName: string | null;
  message: string | null;
  piiMasked: boolean;
}

export interface ReviewContact {
  id: string;
  displayName: string;
  kind: string;
  city: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  merged: boolean;
}

export type ReviewKind = 'routing' | 'duplicate' | 'extraction';

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  status: 'open' | 'resolved';
  reason: string;
  message: string | null;
  confidence: number | null;
  companyId: string | null;
  unitId: string | null;
  companyName: string | null;
  candidateCompanies: Array<{ id: string; name: string | null }>;
  suggestion: {
    companyId: string | null;
    companyName: string | null;
    productLineId: string | null;
    confidence: number | null;
    rationale: string | null;
    rules: Array<{ rule: string; score: number }>;
    fields: Record<string, unknown> | null;
  };
  enquiry: { id: string; channelType: string; channelIdentity: string | null; channel: string; receivedAt: string; status: string; person: EnquiryPerson };
  contact: ReviewContact | null;
  candidate: ReviewContact | null;
  deal: { id: string; ref: string; title: string; status: string } | null;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type ReviewAction = 'approve' | 'override' | 'discard' | 'merge' | 'keep_separate' | 'dismiss';

export interface ImportSuggestion {
  index: number;
  header: string;
  field: string | null;
  confidence: number;
  alternatives: Array<{ field: string; confidence: number }>;
}

export type ImportStatus = 'uploaded' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportJob {
  id: string;
  companyId: string;
  unitId: string;
  fileName: string;
  fileSize: number;
  delimiter: string | null;
  headers: string[];
  sample: string[][];
  suggestions: ImportSuggestion[];
  mapping: Record<string, string>;
  defaults: { audience?: Audience; productLineId?: string; campaign?: string; dateOrder?: 'DMY' | 'MDY' };
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  counts: { created: number; merged: number; reopened: number; review: number; error: number; warning: number };
  fileIssues: Array<{ line?: number; code: string; message: string; level: string }>;
  hasErrorReport: boolean;
  failure: string | null;
  createdBy: string | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ImportRowStatus = 'created' | 'merged' | 'reopened' | 'review' | 'error' | 'skipped';

export interface ImportRow {
  row: number;
  line: number | null;
  status: ImportRowStatus;
  enquiryId: string | null;
  contactId: string | null;
  dealId: string | null;
  dealRef: string | null;
  issues: Array<{ column?: string | null; field?: string; code: string; message: string; level?: string }>;
}

export interface ImportField {
  field: string;
  label: string;
}

export const CHANNEL_TYPE_LABELS: Record<string, string> = {
  website_form: 'Website form',
  landing_page: 'Landing page',
  chat_widget: 'Chat widget',
  whatsapp: 'WhatsApp number',
  phone_call: 'Phone number (calls)',
  missed_call: 'Missed-call number',
  sms: 'SMS number',
  email: 'Email inbox',
  facebook_lead_ad: 'Facebook lead form',
  instagram: 'Instagram account',
  google_lead_form: 'Google lead form',
  walk_in: 'Walk-in centre',
  event: 'Event',
  partner_referral: 'Partner',
  csv_import: 'CSV import',
  api: 'API client',
  other: 'Other',
};
