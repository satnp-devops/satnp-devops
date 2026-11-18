// Request and response shapes of the phase 2 CRM API (docs/crm/PHASE2_CONTRACT.md, sections 9 and 10).
// The API's present* functions produce exactly these shapes. Times are ISO strings in UTC, dates
// "YYYY-MM-DD", money { valueMinor, currency }. Slices extend this file for their own endpoints.

import type { Page } from '../types';

export type { Page };

export type IsoDateTime = string;
export type IsoDate = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------- Shared pieces ----------

export interface Money {
  /** Integer minor units (paise, cents). */
  valueMinor: number;
  /** ISO 4217 code, e.g. "INR". */
  currency: string;
}

export interface UserRef {
  id: string;
  name: string;
}

export interface UnitRef {
  id: string;
  name: string;
  type: string;
}

export interface CompanyRef {
  id: string;
  name: string;
  code: string;
}

/** Someone who can own or be assigned work at a unit (GET /crm/people). */
export interface PersonOption {
  id: string;
  name: string;
  email: string;
  level: 'all' | 'own';
}

export type PeoplePermission =
  | 'deals.manage'
  | 'deals.view'
  | 'tasks.view'
  | 'tasks.manage'
  | 'contacts.view'
  | 'contacts.manage'
  | 'accounts.view'
  | 'accounts.manage';

export type CustomValue = string | number | boolean | string[] | null;
export type CustomValues = Record<string, CustomValue>;

/** Result of a bulk action: what changed and what didn't, per id. */
export interface BulkResult {
  updated: string[];
  failed: Array<{ id: string; code: string; message: string }>;
}

// ---------- Vocabularies (GET /crm/vocabularies) ----------

export type ChannelGroup = 'messaging' | 'web' | 'voice' | 'email' | 'ads' | 'partner' | 'import' | 'manual' | 'other';
export type BuiltInChannelKey =
  | 'whatsapp'
  | 'website_form'
  | 'website_checkout'
  | 'voice_call'
  | 'email'
  | 'lead_ad_instagram'
  | 'lead_ad_facebook'
  | 'partner_referral'
  | 'csv_import'
  | 'manual';
/** Channels are configuration: modules can add keys beyond the built-in ones. */
export type ChannelKey = BuiltInChannelKey | (string & {});

export interface Channel {
  key: ChannelKey;
  label: string;
  group: ChannelGroup;
  firstReplySla: boolean;
}

export type ContactKind = 'parent' | 'student' | 'staff' | 'other';
export type ContactMethodKind = 'phone' | 'email' | 'whatsapp';
export type LinkStatus = 'lead' | 'customer' | 'former';
export type HouseholdRole = 'parent' | 'guardian' | 'student' | 'other';
export type AccountKind = 'coaching_institute' | 'school' | 'college' | 'independent_mentor' | 'other';
export type AccountContactRole = 'decision_maker' | 'influencer' | 'champion' | 'user' | 'billing' | 'other';
export type DealKind = 'b2c' | 'b2b';
export type DealStatus = 'open' | 'won' | 'lost';
export type StageCategory = DealStatus;
export type DealContactRole = 'parent' | 'student' | 'guardian' | 'decision_maker' | 'influencer' | 'other';
export type ProductKindKey =
  | 'group_batch'
  | 'mentorship_1to1'
  | 'crash_course'
  | 'test_series'
  | 'program'
  | 'software_test_platform'
  | 'software_erp'
  | 'software_other';
export type CustomFieldEntity = 'deal' | 'contact' | 'account';
export type CustomFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'phone'
  | 'email'
  | 'url';
export type TimelineKindKey =
  | 'note'
  | 'message'
  | 'call'
  | 'email'
  | 'meeting'
  | 'system'
  | 'stage_change'
  | 'task'
  | 'ai'
  | (string & {});
export type ManualTimelineKind = 'note' | 'call' | 'email' | 'meeting' | 'message';
export type TimelineDirection = 'inbound' | 'outbound' | 'internal';
export type ActorType = 'user' | 'system' | 'ai' | 'contact';
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskKind = 'call' | 'message' | 'email' | 'meeting' | 'follow_up' | 'other';
export type ConsentChannel = 'whatsapp' | 'sms' | 'email' | 'voice' | 'all';
export type ConsentPurpose = 'marketing' | 'transactional' | 'service';
export type ConsentStatus = 'granted' | 'withdrawn';
export type ConsentSource =
  | 'web_form'
  | 'checkout'
  | 'whatsapp'
  | 'call'
  | 'email'
  | 'sms'
  | 'unsubscribe_link'
  | 'import'
  | 'manual';
export type SearchEntityType = 'deal' | 'contact' | 'account';

export interface LabelledKey<K extends string = string> {
  key: K;
  label: string;
}

export interface ProductKind {
  key: ProductKindKey;
  label: string;
  audience: DealKind;
}

/** A field a pipeline stage can require: built-in deal fields and "custom.<key>". */
export interface RequiredFieldOption {
  key: string;
  label: string;
  source: 'deal' | 'custom';
}

export interface CrmVocabularies {
  channels: Channel[];
  contactKinds: ContactKind[];
  linkStatuses: LinkStatus[];
  householdRoles: HouseholdRole[];
  accountKinds: Array<LabelledKey<AccountKind>>;
  accountContactRoles: AccountContactRole[];
  dealKinds: DealKind[];
  dealContactRoles: DealContactRole[];
  dealSorts: DealSort[];
  dealColumns: DealColumn[];
  productKinds: ProductKind[];
  customFieldTypes: CustomFieldType[];
  dealRequiredFields: RequiredFieldOption[];
  timelineKinds: TimelineKind[];
  manualTimelineKinds: ManualTimelineKind[];
  taskKinds: TaskKind[];
  taskPriorities: TaskPriority[];
  consentChannels: ConsentChannel[];
  consentPurposes: ConsentPurpose[];
  consentSources: ConsentSource[];
}

// ---------- Sources and messages ----------

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** Where an enquiry came from (deals.first_touch / last_touch, link source). */
export interface TouchSource {
  channel: ChannelKey;
  campaign?: string;
  utm?: Utm;
  referrer?: string;
  partnerId?: string;
  landingUrl?: string;
  formId?: string;
  adId?: string;
  at?: IsoDateTime;
}

export interface OriginalMessage {
  channel: ChannelKey;
  text: string;
  subject?: string;
  receivedAt: IsoDateTime;
  /** phone and email are masked for viewers without contacts.view_pii. */
  from?: { name?: string; phone?: string; email?: string };
}

/** What the intake agent extracted (phase 9 fills it; {} until then). */
export interface AiFields {
  extracted?: {
    parentName?: string;
    studentName?: string;
    grade?: string;
    exam?: string;
    targetDate?: IsoDate;
    intent?: string;
    language?: string;
    city?: string;
    timeZone?: string;
  };
  /** 0 to 1. */
  confidence?: number;
  model?: string;
  extractedAt?: IsoDateTime;
}

// ---------- People ----------

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
}

/** Facts about a student, shared across the group. */
export interface StudentProfile {
  grade?: string;
  school?: string;
  board?: string;
  targetExam?: string;
  targetDate?: IsoDate;
  graduationYear?: number;
  stream?: string;
}

export interface ContactMethod {
  id: string;
  kind: ContactMethodKind;
  /** As entered, or masked ("+91 •••••••678") when `masked`. */
  value: string;
  /** E.164 or lower-case email; null when masked. */
  normalized: string | null;
  label: string | null;
  isPrimary: boolean;
  verifiedAt: IsoDateTime | null;
  optedOutAt: IsoDateTime | null;
  masked: boolean;
}

/** A person as shown inside other records (deals, households, institutes, tasks). */
export interface ContactSummary {
  id: string;
  kind: ContactKind;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  city: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  piiMasked: boolean;
  erased: boolean;
}

/** A company's link to a person or institute. */
export interface CompanyLink {
  id: string;
  company: CompanyRef;
  unit: UnitRef;
  owner: UserRef | null;
  status: LinkStatus;
  firstSeenAt: IsoDateTime;
  source: TouchSource | null;
  tags: string[];
  custom: CustomValues;
  archivedAt: IsoDateTime | null;
}

/** The link of the working company, shown in lists. */
export interface CompanyLinkSummary {
  companyId: string;
  unitId: string;
  owner: UserRef | null;
  status: LinkStatus;
  tags: string[];
  firstSeenAt: IsoDateTime;
}

export interface ContactListItem extends ContactSummary {
  studentProfile: StudentProfile;
  /** Companies (visible to the viewer) that know this person. */
  companies: CompanyRef[];
  /** The working company's link; null when working at group level. */
  link: CompanyLinkSummary | null;
  openDealCount: number;
  /** Newest timeline entry of the person in the visible companies (or group-wide). */
  lastActivityAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ContactHouseholdRef {
  id: string;
  name: string;
  role: HouseholdRole;
  relation: string | null;
  memberCount: number;
}

export interface ContactAccountRef {
  account: AccountRef;
  title: string | null;
  role: AccountContactRole;
  isPrimary: boolean;
}

export interface ContactDetail extends ContactSummary {
  dateOfBirth: IsoDate | null;
  address: Address | null;
  countryCode: string | null;
  timeZone: string | null;
  language: string | null;
  studentProfile: StudentProfile;
  methods: ContactMethod[];
  links: CompanyLink[];
  households: ContactHouseholdRef[];
  accounts: ContactAccountRef[];
  /** Deals the person takes part in that the viewer may see, newest first (at most 20). */
  deals: DealSummary[];
  erasedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  can: { manage: boolean; viewPii: boolean; merge: boolean; privacy: boolean };
}

export interface ContactCreateResult {
  contact: ContactDetail;
  created: boolean;
  matchedBy: 'email' | 'phone' | null;
  linkCreated: boolean;
}

export interface DuplicateCandidate {
  contact: ContactSummary;
  /** 'household': a parent + student name pair matches another household's pair. */
  reasons: Array<'phone' | 'email' | 'name' | 'household'>;
  /** 0 to 1. */
  score: number;
}

export interface ContactDuplicates {
  candidates: DuplicateCandidate[];
  /** Matches the viewer can't see (known only to other companies or owners). */
  hiddenCount: number;
}

export interface ContactMatchCheck {
  match: ContactSummary | null;
  matchedBy: 'email' | 'phone' | null;
  /** The person exists in the group but the viewer can't see them; saving links them. */
  hiddenMatch: boolean;
  candidates: DuplicateCandidate[];
}

export interface HouseholdMember {
  contact: ContactSummary;
  role: HouseholdRole;
  relation: string | null;
  isPrimary: boolean;
}

export interface Household {
  id: string;
  name: string;
  city: string | null;
  members: HouseholdMember[];
  hiddenMemberCount: number;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  can: { manage: boolean };
}

export interface HouseholdListItem {
  id: string;
  name: string;
  city: string | null;
  members: Array<{ id: string; displayName: string; kind: ContactKind; role: HouseholdRole }>;
  hiddenMemberCount: number;
  updatedAt: IsoDateTime;
}

export interface ConsentRecord {
  id: string;
  contactId: string;
  /** null = for the whole group. */
  companyId: string | null;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  source: ConsentSource;
  evidence: Record<string, string | number | boolean | null>;
  capturedAt: IsoDateTime;
  capturedBy: UserRef | null;
  createdAt: IsoDateTime;
}

export interface ConsentState {
  companyId: string | null;
  channel: Exclude<ConsentChannel, 'all'>;
  purpose: ConsentPurpose;
  status: ConsentStatus | 'unknown';
  recordId: string | null;
  capturedAt: IsoDateTime | null;
}

export interface ContactConsents {
  records: ConsentRecord[];
  effective: ConsentState[];
}

/** Everything the group holds about a person (DPDP access request). Never masked. */
export interface ContactExport {
  exportedAt: IsoDateTime;
  contact: ContactDetail;
  households: Household[];
  consents: ConsentRecord[];
  deals: DealSummary[];
  timeline: TimelineEntry[];
  tasks: Task[];
}

// Requests of the contacts endpoints (section 9.1).

export type ContactSort = '-updatedAt' | '-createdAt' | 'name';

/** GET /contacts (csv lists are joined with commas). */
export interface ContactListQuery {
  unitId: string;
  q?: string;
  kind?: string;
  status?: string;
  owner?: string;
  tag?: string;
  householdId?: string;
  accountId?: string;
  includeArchived?: boolean;
  sort?: ContactSort;
  cursor?: string;
  limit?: number;
}

/** POST /contacts. `mode: 'create'` skips the phone/email match and always adds a new person. */
export interface ContactCreateBody extends ContactInput {
  unitId: string;
  dateOfBirth?: IsoDate;
  address?: Address;
  ownerUserId?: string | null;
  status?: LinkStatus;
  tags?: string[];
  custom?: CustomValues;
  source?: TouchSource;
  household?: { householdId: string; role: HouseholdRole; relation?: string };
  mode?: 'link' | 'create';
}

/** POST /contacts/check */
export interface ContactCheckBody {
  unitId: string;
  kind?: ContactKind;
  firstName?: string;
  lastName?: string;
  phones?: ContactInput['phones'];
  emails?: ContactInput['emails'];
}

/** PATCH /contacts/:id (`dateOfBirth` and `address` need contacts.view_pii). */
export interface ContactPatchBody {
  kind?: ContactKind;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: IsoDate | null;
  address?: Address | null;
  city?: string | null;
  countryCode?: string | null;
  timeZone?: string | null;
  language?: string | null;
  /** Merged into the stored profile; null removes a key. */
  studentProfile?: { [K in keyof StudentProfile]?: StudentProfile[K] | null };
}

/** PATCH /contacts/:id/links/:companyId */
export interface ContactLinkPatchBody {
  unitId?: string;
  ownerUserId?: string | null;
  status?: LinkStatus;
  tags?: string[];
  custom?: CustomValues;
  archived?: boolean;
}

/** POST /contacts/:id/methods */
export interface ContactMethodBody {
  kind: ContactMethodKind;
  value: string;
  label?: string;
  isPrimary?: boolean;
}

/** PATCH /contacts/:id/methods/:methodId */
export interface ContactMethodPatchBody {
  label?: string | null;
  isPrimary?: true;
  verified?: boolean;
  optedOut?: boolean;
}

/** POST /contacts/:id/merge: keeps `:id`, folds `sourceId` into it. */
export interface ContactMergeBody {
  sourceId: string;
}

/** POST /contacts/:id/erase */
export interface ContactEraseBody {
  reason: string;
  confirm: true;
}

/** POST /contacts/:id/consents (append-only). */
export interface ConsentBody {
  companyId: string | null;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  source?: ConsentSource;
  evidence?: Record<string, string | number | boolean | null>;
  capturedAt?: IsoDateTime;
}

/** GET /households */
export interface HouseholdListQuery {
  unitId: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/** A member in POST /households and POST /households/:id/members. */
export interface HouseholdMemberBody {
  contactId: string;
  role: HouseholdRole;
  relation?: string;
  isPrimary?: boolean;
}

/** POST /households */
export interface HouseholdCreateBody {
  unitId: string;
  name: string;
  city?: string;
  members: HouseholdMemberBody[];
}

/** PATCH /households/:id */
export interface HouseholdPatchBody {
  name?: string;
  city?: string | null;
  archived?: boolean;
}

/** PATCH /households/:id/members/:contactId */
export interface HouseholdMemberPatchBody {
  role?: HouseholdRole;
  relation?: string | null;
  isPrimary?: boolean;
}

// ---------- Institutes ----------

export interface AccountRef {
  id: string;
  name: string;
  kind: AccountKind;
}

export interface AccountProfile {
  boards?: string[];
  exams?: string[];
  budgetBand?: string;
  decisionTimeline?: string;
  notes?: string;
  /** GST number (India), 15 characters. */
  gstin?: string;
}

export interface AccountContact {
  contact: ContactSummary;
  title: string | null;
  role: AccountContactRole;
  isPrimary: boolean;
}

export interface AccountListItem extends AccountRef {
  city: string | null;
  state: string | null;
  branchCount: number | null;
  studentCount: number | null;
  currentSoftware: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  piiMasked: boolean;
  companies: CompanyRef[];
  link: CompanyLinkSummary | null;
  openDealCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AccountDetail extends AccountListItem {
  legalName: string | null;
  website: string | null;
  domain: string | null;
  countryCode: string | null;
  address: Address | null;
  profile: AccountProfile;
  links: CompanyLink[];
  contacts: AccountContact[];
  openDeals: DealSummary[];
  /** The most recently closed (won or lost) deals the viewer may see, at most 10. */
  closedDeals: DealSummary[];
  can: { manage: boolean; viewPii: boolean };
}

export interface AccountCreateResult {
  account: AccountDetail;
  created: boolean;
  /** Which key found the existing institute: web domain, exact email, exact phone, or name in the same city. */
  matchedBy: 'domain' | 'email' | 'phone' | 'name' | null;
  linkCreated: boolean;
}

export type AccountSort = '-updatedAt' | '-createdAt' | 'name';

/** GET /accounts query (lists comma-separated). */
export interface AccountListQuery {
  unitId: string;
  q?: string;
  kind?: AccountKind[];
  status?: LinkStatus[];
  owner?: OwnerFilter[];
  tag?: string[];
  city?: string[];
  state?: string[];
  currentSoftware?: string;
  studentCountMin?: number;
  studentCountMax?: number;
  includeArchived?: boolean;
  sort?: AccountSort;
  cursor?: string;
  limit?: number;
}

/** The institute's own details (POST /accounts, PATCH /accounts/:id). */
export interface AccountDetailsInput {
  kind?: AccountKind;
  name?: string;
  legalName?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  countryCode?: string | null;
  address?: Address | null;
  branchCount?: number | null;
  studentCount?: number | null;
  currentSoftware?: string | null;
  profile?: AccountProfile | null;
}

/** A person to add at an institute: an existing contact or a new one (exactly one of the two). */
export type AccountContactInput = ({ contactId: string; contact?: never } | { contact: ContactInput; contactId?: never }) & {
  title?: string;
  role?: AccountContactRole;
  isPrimary?: boolean;
};

export interface AccountCreateInput extends Omit<AccountDetailsInput, 'kind' | 'name'> {
  unitId: string;
  kind: AccountKind;
  name: string;
  ownerUserId?: string | null;
  status?: LinkStatus;
  tags?: string[];
  custom?: CustomValues;
  source?: TouchSource;
  contacts?: AccountContactInput[];
  mode?: 'link' | 'create';
}

export type AccountPatchInput = AccountDetailsInput;

/** PATCH /accounts/:id/links/:companyId (also the shape of PATCH /contacts/:id/links/:companyId). */
export interface CompanyLinkPatchInput {
  unitId?: string;
  ownerUserId?: string | null;
  status?: LinkStatus;
  tags?: string[];
  custom?: CustomValues;
  archived?: boolean;
}

export interface AccountContactPatchInput {
  title?: string | null;
  role?: AccountContactRole;
  isPrimary?: boolean;
}

// ---------- Catalog ----------

export interface ProductAttributes {
  mode?: 'online' | 'centre' | 'hybrid';
  sessions?: number;
  durationWeeks?: number;
  tests?: number;
  exam?: string;
  grades?: string[];
  billing?: 'one_time' | 'monthly' | 'annual' | 'per_student_year' | 'per_branch_year' | 'per_institute_year' | 'per_seat_month';
  addOn?: boolean;
}

export interface ProductLineRef {
  id: string;
  name: string;
  kind: ProductKindKey;
}

export interface ProductLine extends ProductLineRef {
  companyId: string;
  key: string;
  audience: DealKind;
  description: string | null;
  position: number;
  active: boolean;
  productCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProductRef {
  id: string;
  name: string;
  code: string | null;
}

export interface Product extends ProductRef {
  companyId: string;
  productLineId: string;
  description: string | null;
  attributes: ProductAttributes;
  position: number;
  active: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------- Pipelines ----------

export interface StageEntryRules {
  /** Stage keys a deal must come from to enter this stage. */
  allowedFrom?: string[];
}

export interface StageRef {
  id: string;
  key: string;
  name: string;
  category: StageCategory;
  colour: string | null;
}

export interface Stage extends StageRef {
  pipelineId: string;
  position: number;
  probability: number;
  slaHours: number | null;
  /** Deal field keys (and "custom.<key>") required to enter the stage. */
  requiredFields: string[];
  entryRules: StageEntryRules;
  archivedAt: IsoDateTime | null;
}

export interface Pipeline {
  id: string;
  companyId: string;
  key: string;
  name: string;
  kind: DealKind;
  isDefault: boolean;
  productLineIds: string[];
  position: number;
  archivedAt: IsoDateTime | null;
  stages: Stage[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface LostReasonRef {
  id: string;
  label: string;
}

export interface LostReason extends LostReasonRef {
  companyId: string;
  kind: DealKind | null;
  requiresNote: boolean;
  position: number;
  active: boolean;
}

export interface StageInput {
  key: string;
  name: string;
  category: StageCategory;
  probability?: number;
  slaHours?: number | null;
  requiredFields?: string[];
  entryRules?: StageEntryRules;
  colour?: string | null;
}

export interface PipelineCreateInput {
  companyId: string;
  key: string;
  name: string;
  kind: DealKind;
  isDefault?: boolean;
  productLineIds?: string[];
  position?: number;
  stages: StageInput[];
}

// ---------- Custom fields ----------

export interface CustomFieldOption {
  value: string;
  label: string;
}

export interface CustomFieldDefinition {
  id: string;
  companyId: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: CustomFieldOption[];
  required: boolean;
  /** Deal fields only: limit to B2C or B2B deals. */
  appliesTo: DealKind | null;
  help: string | null;
  position: number;
  active: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CustomFieldCreateInput {
  companyId: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options?: CustomFieldOption[];
  required?: boolean;
  appliesTo?: DealKind | null;
  help?: string | null;
  position?: number;
}

// ---------- Configuration requests (config slice) ----------

/** PATCH /pipelines/:id. Key and kind are fixed. */
export interface PipelinePatchInput {
  name?: string;
  isDefault?: true;
  productLineIds?: string[];
  position?: number;
}

/** POST /pipelines/:id/stages: inserted at `position` (default: before the first won stage). */
export interface StageCreateInput extends StageInput {
  position?: number;
}

/** PATCH /pipelines/:id/stages/:stageId. Key and category are fixed. */
export type StagePatchInput = Partial<Omit<StageInput, 'key' | 'category'>>;

/** POST /pipelines/:id/stages/:stageId/archive. */
export interface StageArchiveInput {
  moveToStageId?: string;
}

/** 409 details when a stage or pipeline still has deals. */
export interface DealCountConflictDetails {
  openDealCount: number;
  dealCount?: number;
}

export interface LostReasonInput {
  companyId: string;
  label: string;
  kind?: DealKind | null;
  requiresNote?: boolean;
  position?: number;
}

export type LostReasonPatchInput = Partial<Omit<LostReasonInput, 'companyId'>> & { active?: boolean };

export interface ProductLineInput {
  companyId: string;
  key: string;
  name: string;
  kind: ProductKindKey;
  description?: string;
  position?: number;
}

export interface ProductLinePatchInput {
  name?: string;
  description?: string | null;
  position?: number;
  active?: boolean;
}

export interface ProductInput {
  productLineId: string;
  code?: string | null;
  name: string;
  description?: string;
  attributes?: ProductAttributes;
  position?: number;
}

export interface ProductPatchInput extends Partial<Omit<ProductInput, 'description'>> {
  description?: string | null;
  active?: boolean;
}

/** PATCH /custom-fields/:id. Entity and key are fixed; `type` only while no record stores a value. */
export interface CustomFieldPatchInput {
  label?: string;
  type?: CustomFieldType;
  options?: CustomFieldOption[];
  required?: boolean;
  appliesTo?: DealKind | null;
  help?: string | null;
  position?: number;
  active?: boolean;
}

/** PUT /custom-fields/order: listed fields first, the rest keep their order after them. */
export interface CustomFieldOrderInput {
  companyId: string;
  entity: CustomFieldEntity;
  ids: string[];
}

// ---------- Deals ----------

export type DealSort =
  | '-updatedAt'
  | 'updatedAt'
  | '-createdAt'
  | 'createdAt'
  | '-lastActivityAt'
  | 'lastActivityAt'
  | '-value'
  | 'value'
  | 'expectedCloseOn'
  | '-expectedCloseOn'
  | 'slaDueAt'
  | '-slaDueAt'
  | 'stageEnteredAt'
  | '-stageEnteredAt'
  /** Deals slice: by title (the lead's name), A–Z and Z–A. */
  | 'title'
  | '-title';

export type BuiltInDealColumn =
  | 'ref'
  | 'title'
  | 'contact'
  | 'account'
  | 'stage'
  | 'status'
  | 'owner'
  | 'unit'
  | 'channel'
  | 'productLine'
  | 'product'
  | 'value'
  | 'tags'
  | 'expectedCloseOn'
  | 'slaDueAt'
  | 'firstReplyDueAt'
  | 'lastActivityAt'
  | 'createdAt'
  | 'updatedAt';
export type DealColumn = BuiltInDealColumn | `custom.${string}`;

/** "me" is the signed-in user; "none" means no owner. */
export type OwnerFilter = 'me' | 'none' | (string & {});

/** Filters of the Leads list; saved views store exactly this (GET /deals takes the same keys, lists comma-separated). */
export interface DealFilters {
  pipelineId?: string;
  stageId?: string[];
  status?: DealStatus[];
  kind?: DealKind;
  channel?: ChannelKey[];
  owner?: OwnerFilter[];
  productLineId?: string[];
  tag?: string[];
  q?: string;
  nurture?: boolean;
  slaBreached?: boolean;
  firstReplyOverdue?: boolean;
  createdFrom?: IsoDateTime;
  createdTo?: IsoDateTime;
  /** Deals slice: stage SLA or first reply past due ("breached"), or with less than a quarter of the window left ("due_soon"). */
  sla?: DealSlaFilter;
  /** Deals slice: first-touch campaign (or UTM campaign), any of. */
  campaign?: string[];
  /** Deals slice: UTM source of the first touch, any of. */
  source?: string[];
  updatedFrom?: IsoDateTime;
  updatedTo?: IsoDateTime;
}

export type DealSlaFilter = 'breached' | 'due_soon';

export interface DealListQuery extends DealFilters {
  unitId: string;
  contactId?: string;
  accountId?: string;
  householdId?: string;
  archived?: boolean;
  sort?: DealSort;
  cursor?: string;
  limit?: number;
}

export interface DealRef {
  id: string;
  ref: string;
  title: string;
  status: DealStatus;
}

/** A deal inside another record (institute page, contact export). */
export interface DealSummary extends DealRef {
  kind: DealKind;
  companyId: string;
  stage: StageRef;
  owner: UserRef | null;
  value: Money;
  updatedAt: IsoDateTime;
}

export interface DealListItem extends DealSummary {
  unit: UnitRef;
  pipelineId: string;
  productLine: ProductLineRef | null;
  product: ProductRef | null;
  primaryContact: ContactSummary | null;
  account: AccountRef | null;
  studentNames: string[];
  channel: ChannelKey;
  firstTouch: TouchSource | null;
  /** The first 140 characters of the original message. */
  messagePreview: string | null;
  tags: string[];
  nurture: boolean;
  stageEnteredAt: IsoDateTime;
  slaDueAt: IsoDateTime | null;
  slaBreached: boolean;
  firstReplyDueAt: IsoDateTime | null;
  firstRepliedAt: IsoDateTime | null;
  firstReplyOverdue: boolean;
  /** Open, with less than a quarter of the stage SLA left. */
  slaDueSoon: boolean;
  /** Waiting for a first reply, with less than a quarter of the window left. */
  firstReplyDueSoon: boolean;
  /** Open, created in the last 7 days, and its owner hasn't opened it yet (POST /deals/:id/seen). */
  isNew: boolean;
  expectedCloseOn: IsoDate | null;
  closedAt: IsoDateTime | null;
  lastActivityAt: IsoDateTime;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface DealContact {
  contact: ContactSummary;
  role: DealContactRole;
  isPrimary: boolean;
}

export interface DealDetail extends DealListItem {
  pipeline: { id: string; name: string; kind: DealKind };
  household: { id: string; name: string } | null;
  contacts: DealContact[];
  lastTouch: TouchSource | null;
  originalMessage: OriginalMessage | null;
  aiFields: AiFields;
  custom: CustomValues;
  lostReason: LostReasonRef | null;
  lostNote: string | null;
  createdBy: UserRef | null;
  can: { manage: boolean; assign: boolean; archive: boolean };
}

export interface StageHistoryEntry {
  id: string;
  fromStage: StageRef | null;
  toStage: StageRef;
  fromStatus: DealStatus | null;
  toStatus: DealStatus;
  lostReason: LostReasonRef | null;
  movedBy: UserRef | null;
  secondsInFromStage: number | null;
  movedAt: IsoDateTime;
}

export interface StageCount {
  stageId: string;
  count: number;
  slaBreachedCount: number;
  /** Totals per currency. */
  value: Money[];
}

export interface StageCounts {
  pipelineId: string;
  stages: StageCount[];
  total: number;
}

export interface DealDuplicateCheck {
  contact: ContactSummary | null;
  account: AccountRef | null;
  /** The person or institute exists in the group but the viewer can't see them. */
  knownElsewhere: boolean;
  openDeals: DealListItem[];
  recentlyLost: DealListItem[];
  hiddenOpenDealCount: number;
}

/** A person given inline; the server reuses an existing contact when one matches. */
export interface ContactInput {
  kind?: ContactKind;
  firstName?: string;
  lastName?: string;
  phones?: Array<string | { value: string; kind?: 'phone' | 'whatsapp'; label?: string; isPrimary?: boolean }>;
  emails?: Array<string | { value: string; label?: string; isPrimary?: boolean }>;
  city?: string;
  countryCode?: string;
  timeZone?: string;
  language?: string;
  studentProfile?: StudentProfile;
}

export type DealContactRefInput = { contactId: string } | { contact: ContactInput };

export interface DealFieldsPatch {
  title?: string;
  productLineId?: string | null;
  productId?: string | null;
  valueMinor?: number;
  currency?: string;
  primaryContactId?: string;
  householdId?: string | null;
  accountId?: string | null;
  expectedCloseOn?: IsoDate | null;
  tags?: string[];
  custom?: CustomValues;
  nurture?: boolean;
  lastTouch?: TouchSource;
}

export interface DealCreateInput {
  unitId: string;
  kind: DealKind;
  title?: string;
  pipelineId?: string;
  stageId?: string;
  productLineId?: string | null;
  productId?: string | null;
  ownerUserId?: string | null;
  valueMinor?: number;
  currency?: string;
  primaryContactId?: string;
  contact?: ContactInput;
  students?: DealContactRefInput[];
  householdId?: string | null;
  accountId?: string;
  channel?: ChannelKey;
  firstTouch?: TouchSource;
  originalMessage?: OriginalMessage;
  expectedCloseOn?: IsoDate | null;
  tags?: string[];
  custom?: CustomValues;
  nurture?: boolean;
  sourceEventId?: string;
}

export interface DealMoveInput {
  stageId: string;
  fromStageId?: string;
  lostReasonId?: string;
  lostNote?: string;
  nurture?: boolean;
  fields?: DealFieldsPatch;
}

/** What a bulk action runs on: the selected ids, or everything the list's filters match (up to 1000). */
export interface DealBulkFilter extends DealFilters {
  unitId: string;
  contactId?: string;
  accountId?: string;
  householdId?: string;
  archived?: boolean;
}
export type DealBulkTarget = { ids: string[]; filter?: never } | { filter: DealBulkFilter; ids?: never };

export type DealBulkAction =
  | { action: 'assign'; ownerUserId: string | null }
  | { action: 'move'; stageId: string; lostReasonId?: string; lostNote?: string }
  | { action: 'lose'; lostReasonId: string; lostNote?: string; nurture?: boolean }
  | { action: 'addTags'; tags: string[] }
  | { action: 'removeTags'; tags: string[] }
  | { action: 'setNurture'; nurture: boolean }
  | { action: 'archive' }
  | { action: 'restore' };

/** POST /deals/bulk: up to 1000 records, processed in chunks; each record succeeds or fails on its own. */
export type DealBulkInput = DealBulkTarget & DealBulkAction;

/** POST /deals/bulk result: `updated` and `unchanged` keep the order of the ids. */
export interface DealBulkResult extends BulkResult {
  unchanged: string[];
  total: number;
}

/** details of a 422 "stage_rules" error. */
export interface StageRulesErrorDetails {
  missing: Array<{ key: string; label: string }>;
  allowedFrom: string[] | null;
}

// ---------- Saved views ----------

export interface SavedView {
  id: string;
  entity: 'deals';
  name: string;
  visibility: 'personal' | 'shared';
  unitId: string;
  companyId: string | null;
  owner: UserRef;
  filters: DealFilters;
  sort: DealSort;
  columns: DealColumn[];
  position: number;
  can: { edit: boolean };
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface SavedViewInput {
  unitId: string;
  entity?: 'deals';
  name: string;
  visibility?: 'personal' | 'shared';
  filters?: DealFilters;
  sort?: DealSort;
  columns?: DealColumn[];
  position?: number;
}

// ---------- Timeline ----------

export interface TimelineKind {
  key: TimelineKindKey;
  label: string;
}

export interface TimelineMeta {
  action?: string;
  channel?: string;
  ref?: string;
  original?: boolean;
  durationSeconds?: number;
  outcome?: 'connected' | 'no_answer' | 'busy' | 'voicemail' | 'wrong_number' | 'left_message';
  attendees?: string[];
  subject?: string;
  fromStageId?: string;
  toStageId?: string;
  fromStatus?: DealStatus;
  toStatus?: DealStatus;
  lostReasonId?: string | null;
  lostNote?: string | null;
  taskId?: string;
  dueAt?: IsoDateTime;
  changes?: Record<string, { from: JsonValue; to: JsonValue }>;
  [key: string]: JsonValue | undefined;
}

export interface TimelineEntry {
  id: string;
  kind: TimelineKindKey;
  channel: ChannelKey | null;
  direction: TimelineDirection | null;
  title: string | null;
  body: string | null;
  meta: TimelineMeta;
  actorType: ActorType;
  actor: UserRef | null;
  companyId: string | null;
  unitId: string | null;
  dealId: string | null;
  contactId: string | null;
  accountId: string | null;
  /** The deal an entry belongs to, on contact and institute timelines. */
  deal: DealRef | null;
  occurredAt: IsoDateTime;
  createdAt: IsoDateTime;
  editedAt: IsoDateTime | null;
  pinnedAt: IsoDateTime | null;
  /** Read from timeline_events_archive (includeArchive=true): read-only. */
  archived: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
}

export type TimelineSubject = { dealId: string } | { contactId: string } | { accountId: string };

/** GET /timeline filters besides the subject. */
export interface TimelineListFilters {
  kind?: TimelineKindKey[];
  channel?: ChannelKey[];
  pinned?: boolean;
  /** Also read entries moved to the archive. */
  includeArchive?: boolean;
  limit?: number;
}

export type TimelineCreateInput = TimelineSubject & {
  companyId?: string;
  kind: ManualTimelineKind;
  direction?: TimelineDirection;
  channel?: ChannelKey | null;
  title?: string;
  body?: string;
  occurredAt?: IsoDateTime;
  meta?: Pick<TimelineMeta, 'durationSeconds' | 'outcome' | 'attendees' | 'subject'>;
};

// ---------- Tasks ----------

/** later_today: open, due between now and the end of the viewer's day (today minus overdue). */
export type TaskDue = 'overdue' | 'today' | 'later_today' | 'upcoming' | 'none';
/** What a task is about: its deal, else its person, else its institute, else nothing. */
export type TaskRelatedType = 'deal' | 'contact' | 'account' | 'none';
export type TaskSort = 'dueAt' | '-dueAt' | '-createdAt' | '-completedAt';

export interface Task {
  id: string;
  companyId: string;
  unit: UnitRef;
  title: string;
  notes: string | null;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: IsoDateTime | null;
  reminderAt: IsoDateTime | null;
  overdue: boolean;
  assignee: UserRef | null;
  createdBy: UserRef | null;
  completedAt: IsoDateTime | null;
  completedBy: UserRef | null;
  deal: DealRef | null;
  contact: { id: string; displayName: string } | null;
  account: AccountRef | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  can: { manage: boolean };
}

export interface TaskCounts {
  overdue: number;
  today: number;
  upcoming: number;
  noDueDate: number;
  open: number;
  /** Open and due between now and the end of today (today without the overdue ones). */
  laterToday: number;
  /** The time zone the groups were computed in (tz, else the user's, else locale.timeZone). */
  timeZone: string;
  startOfToday: IsoDateTime;
  startOfTomorrow: IsoDateTime;
}

export interface TaskListQuery {
  unitId: string;
  assignee?: OwnerFilter[];
  status?: TaskStatus[];
  due?: TaskDue;
  dealId?: string;
  contactId?: string;
  accountId?: string;
  priority?: TaskPriority[];
  q?: string;
  tz?: string;
  companyId?: string;
  related?: TaskRelatedType[];
  completedAfter?: IsoDateTime;
  sort?: TaskSort;
  cursor?: string;
  limit?: number;
}

export interface TaskInput {
  unitId?: string;
  dealId?: string;
  contactId?: string;
  accountId?: string;
  title: string;
  notes?: string | null;
  kind?: TaskKind;
  priority?: TaskPriority;
  dueAt?: IsoDateTime | null;
  reminderAt?: IsoDateTime | null;
  assigneeUserId?: string | null;
}

// ---------- Search ----------

export interface SearchHit {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string | null;
  /** Set for deals; people and institutes are group-level. */
  companyId: string | null;
  matchedOn: 'name' | 'phone' | 'email' | 'ref' | 'text';
  /** Why it matched, e.g. "Phone +91 •••••••210", "Ref SP-1042" or "Contact Priya Sharma" (masked as needed). */
  snippet: string | null;
  /** Deals: the company the deal belongs to. */
  company: CompanyRef | null;
  /** Deals only. */
  status: DealStatus | null;
  /** Deals only. */
  value: Money | null;
  /** Deals only. */
  owner: UserRef | null;
  /** People and institutes: the primary phone or email, masked without contacts.view_pii. */
  contactPoint: string | null;
  /** True when contactPoint or snippet was masked for this viewer. */
  piiMasked: boolean;
}

/** GET /search query. */
export interface SearchQuery {
  unitId: string;
  /** 2–100 characters. */
  q: string;
  /** Comma-separated in the URL; all types when empty. */
  types?: SearchEntityType[];
  /** 1–20 per type (default 6). */
  limit?: number;
}

export interface SearchGroup {
  type: SearchEntityType;
  hits: SearchHit[];
}

export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
}
