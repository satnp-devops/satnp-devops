// Response and request types of the delivery API (apps/api/src/modules/delivery/present.js and
// docs/delivery/DELIVERY.md §8). Shared summaries come from the CRM types.

import type { AccountRef, ContactSummary, DealRef, Money, ProductLineRef, ProductRef, UnitRef, UserRef } from '@/lib/crm/types';

export type BatchMode = 'online' | 'centre' | 'hybrid';
export type BatchStatus = 'planned' | 'open' | 'closed' | 'completed' | 'cancelled';
export type RefundUnit = 'days' | 'classes';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type EnrollmentStatus = 'active' | 'paused' | 'withdrawn' | 'completed';
export type SeatStatus = 'seated' | 'waitlisted' | 'unassigned';
export type AccessStatus = 'not_required' | 'pending' | 'granted' | 'suspended' | 'revoked';
export type EnrollmentSource = 'checkout' | 'payment' | 'manual';
export type WithdrawalChannel = 'form' | 'whatsapp' | 'email' | 'phone' | 'counter' | 'portal' | 'other';
export type RefundStatus = 'requested' | 'processing' | 'paid' | 'not_applicable' | 'failed';
export type ItemStatus = 'pending' | 'done' | 'skipped';
export type ProjectStatus = 'planned' | 'in_progress' | 'live' | 'on_hold' | 'cancelled';
export type PhaseStatus = 'pending' | 'in_progress' | 'done';
export type ChurnLevel = 'low' | 'medium' | 'high';
export type OwnerRole = 'record_owner' | 'batch_teacher' | 'unassigned';

export interface BatchSchedule {
  days?: Weekday[];
  startTime?: string;
  endTime?: string;
  timeZone?: string;
  notes?: string;
}

export interface BatchRef {
  id: string;
  name: string;
  code: string | null;
  mode: BatchMode;
  startsOn: string;
  endsOn: string;
  status: BatchStatus;
}

export interface Batch extends BatchRef {
  companyId: string;
  unit: UnitRef | null;
  product: ProductRef | null;
  productLine: ProductLineRef | null;
  schedule: BatchSchedule;
  capacity: number;
  seatsTaken: number;
  seatsLeft: number;
  waitlistEnabled: boolean;
  waitlistLimit: number | null;
  waitlistCount: number;
  fee: Money | null;
  checkoutEnabled: boolean;
  teacher: UserRef | null;
  teacherName: string | null;
  location: string | null;
  refundUnit: RefundUnit;
  totalClasses: number | null;
  createdAt: string;
  updatedAt: string;
  can: { manage: boolean };
}

export interface BatchInput {
  unitId?: string;
  productId?: string;
  code?: string | null;
  name?: string;
  mode?: BatchMode;
  schedule?: BatchSchedule;
  startsOn?: string;
  endsOn?: string;
  capacity?: number;
  waitlistEnabled?: boolean;
  waitlistLimit?: number | null;
  fee?: Money | null;
  checkoutEnabled?: boolean;
  teacherUserId?: string | null;
  teacherName?: string | null;
  location?: string | null;
  status?: BatchStatus;
  refundUnit?: RefundUnit;
  totalClasses?: number | null;
}

export interface ChecklistProgress {
  id: string;
  status: 'open' | 'done';
  itemsTotal: number;
  itemsDone: number;
}

export interface Enrollment {
  id: string;
  ref: string;
  companyId: string;
  unit: UnitRef | null;
  student: ContactSummary | null;
  payer: ContactSummary | null;
  householdId: string | null;
  deal: DealRef | null;
  product: ProductRef | null;
  productLine: ProductLineRef | null;
  batch: BatchRef | null;
  waitlist: { batch: BatchRef | null; position: number; queuedAt: string } | null;
  owner: UserRef | null;
  status: EnrollmentStatus;
  seatStatus: SeatStatus;
  accessStatus: AccessStatus;
  source: EnrollmentSource;
  fee: Money | null;
  paid: Money;
  enrolledAt: string;
  startsOn: string | null;
  endsOn: string | null;
  pausedAt: string | null;
  resumeOn: string | null;
  pauseReason: string | null;
  withdrawnAt: string | null;
  completedAt: string | null;
  checklist: ChecklistProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundBasis {
  rule?: 'pro_rata_remaining_period' | 'cooling_off_full_refund';
  unit?: RefundUnit;
  totalUnits?: number;
  usedUnits?: number;
  remainingUnits?: number;
  feeMinor?: number;
  paidMinor?: number;
  consumedMinor?: number;
  startsOn?: string;
  endsOn?: string;
  effectiveOn?: string;
  receivedOn?: string;
  dueOn?: string;
  slaDays?: number;
  coolingOffDays?: number;
}

export interface Withdrawal {
  id: string;
  receivedAt: string;
  channel: WithdrawalChannel;
  reason: string | null;
  effectiveOn: string;
  refund: Money;
  refundDueAt: string;
  refundStatus: RefundStatus;
  refundReference: string | null;
  refundPaidAt: string | null;
  basis: RefundBasis;
  createdAt: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  owner: UserRef | null;
  dueOn: string | null;
  position: number;
  completedAt: string | null;
  completedBy: UserRef | null;
}

export interface EnrollmentDetail extends Enrollment {
  withdrawal: Withdrawal | null;
  payments: Array<{ id: string; paymentId: string; amount: Money; paidAt: string }>;
  checklistItems: ChecklistItem[];
  can: {
    manage: boolean;
    withdraw: boolean;
    changeBatch: boolean;
    pause: boolean;
    resume: boolean;
    complete: boolean;
    manageChecklist: boolean;
  };
}

export interface EnrollmentCounts {
  active: number;
  paused: number;
  withdrawn: number;
  completed: number;
  waitlisted: number;
}

export interface RefundPreview {
  refund: Money;
  dueAt: string;
  coolingOff: boolean;
  basis: RefundBasis;
}

export interface WaitlistEntry {
  id: string;
  position: number;
  queuedAt: string;
  enrollment: Enrollment;
}

// ---------- Onboarding ----------

export interface ChecklistSummary {
  id: string;
  name: string;
  companyId: string;
  unit: UnitRef | null;
  status: 'open' | 'done';
  itemsTotal: number;
  itemsDone: number;
  owner: UserRef | null;
  nextDueOn: string | null;
  overdueCount: number;
  enrollment: {
    id: string;
    ref: string;
    status: EnrollmentStatus;
    student: ContactSummary | null;
    batch: BatchRef | null;
    product: ProductRef | null;
  } | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ChecklistDetail extends ChecklistSummary {
  items: ChecklistItem[];
  can: { manage: boolean };
}

export interface ProjectSummary {
  id: string;
  name: string;
  companyId: string;
  unit: UnitRef | null;
  account: AccountRef | null;
  deal: DealRef | null;
  product: ProductRef | null;
  productLine: ProductLineRef | null;
  subscriptionId: string | null;
  contractId: string | null;
  status: ProjectStatus;
  owner: UserRef | null;
  kickoffOn: string | null;
  targetGoLiveOn: string | null;
  wentLiveAt: string | null;
  tasksTotal: number;
  tasksDone: number;
  currentPhase: { key: string; name: string; dueOn: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTask extends ChecklistItem {
  overdue: boolean;
}

export interface ProjectPhase {
  id: string;
  key: string;
  name: string;
  position: number;
  status: PhaseStatus;
  owner: UserRef | null;
  dueOn: string | null;
  overdue: boolean;
  completedAt: string | null;
  tasks: ProjectTask[];
}

export interface ProjectDetail extends ProjectSummary {
  phases: ProjectPhase[];
  can: { manage: boolean };
}

export interface ChurnSignal {
  key: string;
  label: string;
  points: number;
}

export interface UpsellFlag {
  key: string;
  label: string;
  productLineIds?: string[];
}

export interface Renewal {
  id: string;
  companyId: string;
  unit: UnitRef | null;
  subscriptionId: string;
  account: AccountRef | null;
  deal: DealRef | null;
  product: ProductRef | null;
  productLine: ProductLineRef | null;
  planName: string | null;
  status: 'active' | 'cancelled' | 'ended';
  termStart: string | null;
  termEnd: string;
  autoRenew: boolean;
  amount: Money;
  seats: number | null;
  owner: UserRef | null;
  remindersSent: number[];
  churn: { score: number; level: ChurnLevel; signals: ChurnSignal[]; scoredAt: string | null };
  upsell: UpsellFlag[];
  updatedAt: string;
}

export interface RenewalSummary {
  due30: number;
  due90: number;
  high: number;
  medium: number;
  upsell: number;
  value90: Money[];
}

export interface TemplatePhase {
  key: string;
  name: string;
  offsetDays: number;
}

export interface TemplateItem {
  id?: string;
  phaseKey: string | null;
  title: string;
  description: string | null;
  ownerRole: OwnerRole;
  dueOffsetDays: number;
  position?: number;
}

export interface OnboardingTemplate {
  id: string;
  companyId: string;
  kind: 'b2c' | 'b2b';
  name: string;
  productLine: ProductLineRef | null;
  product: ProductRef | null;
  phases: TemplatePhase[];
  items: TemplateItem[];
  active: boolean;
  updatedAt: string;
}

// ---------- Public checkout ----------

export interface PublicBatch {
  id: string;
  name: string;
  code: string | null;
  mode: BatchMode;
  schedule: BatchSchedule;
  startsOn: string;
  endsOn: string;
  location: string | null;
  fee: Money;
  seatsLeft: number;
  product: { id: string; name: string; description: string | null };
  productLine: { id: string; name: string };
}

export interface PublicCheckout {
  company: { id: string; name: string; code: string };
  policy: { text: string; version: string; refundDays: number };
  batches: PublicBatch[];
}

export interface CheckoutSession {
  id: string;
  status: 'pending' | 'paid' | 'completed' | 'expired' | 'failed';
  company: { name: string; code: string };
  batch: { name: string; startsOn: string; endsOn: string; mode: BatchMode };
  amount: Money;
  paymentUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
  enrollment: { ref: string; seatStatus: SeatStatus; waitlistPosition: number | null } | null;
  /** Only in the response that starts the checkout. */
  token?: string;
}

export interface Programme {
  id: string;
  name: string;
  code: string | null;
  companyId: string;
  productLine: { id: string; name: string; kind: string };
}
