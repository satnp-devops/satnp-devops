import type { IconName } from '@/components/icons';

// The sidebar is a registry too: each module adds its entries here when it ships.
// "Soon" entries show where upcoming phases plug in.

export interface NavItem {
  label: string;
  icon: IconName;
  /** Missing for entries that arrive in a later phase. */
  href?: string;
  /** Show the entry when the user holds any of these permissions somewhere in their scope. */
  anyOf?: string[];
  phase?: number;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  { title: null, items: [{ label: 'Home', icon: 'home', href: '/' }] },
  {
    title: 'Work',
    items: [
      { label: 'My tasks', icon: 'tasks', href: '/tasks', anyOf: ['tasks.view'] },
      { label: 'Leads', icon: 'funnel', href: '/leads', anyOf: ['deals.view', 'contacts.view', 'intake.review', 'intake.import'] },
      { label: 'Pipeline', icon: 'kanban', href: '/pipeline', anyOf: ['deals.view'] },
      { label: 'Bookings', icon: 'calendar', href: '/bookings', anyOf: ['scheduling.view'] },
      { label: 'Accounts', icon: 'building', href: '/accounts', anyOf: ['accounts.view'] },
    ],
  },
  {
    title: 'Money',
    items: [
      { label: 'Fees and billing', icon: 'card', href: '/billing', anyOf: ['billing.view'] },
      { label: 'Subscriptions', icon: 'repeat', href: '/subscriptions', anyOf: ['billing.view'] },
    ],
  },
  {
    title: 'Delivery',
    items: [
      { label: 'Enrollments', icon: 'school', href: '/enrollments', anyOf: ['enrollments.view'] },
      { label: 'Onboarding', icon: 'flag', href: '/onboarding', anyOf: ['onboarding.view', 'onboarding.view_renewals'] },
    ],
  },
  {
    title: 'Grow',
    items: [
      { label: 'Automations', icon: 'bolt', href: '/automations', anyOf: ['automations.view', 'automations.approve'] },
      { label: 'Partners', icon: 'handshake', href: '/partners', anyOf: ['partners.view', 'partners.portal'] },
      { label: 'Analytics', icon: 'chart', phase: 11 },
    ],
  },
  { title: 'Admin', items: [{ label: 'Settings', icon: 'settings', href: '/settings' }] },
];

export interface SettingsTab {
  label: string;
  href: string;
  /** Show when the user holds any of these permissions in their scope; empty means everyone. */
  anyOf: string[];
  /** Check anywhere inside the scope instead of at the scope itself. */
  anywhere?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { label: 'Organisation', href: '/settings/organization', anyOf: ['org.view', 'org.manage'], anywhere: true },
  { label: 'People', href: '/settings/people', anyOf: ['users.view'] },
  { label: 'Roles', href: '/settings/roles', anyOf: ['roles.view', 'users.manage'], anywhere: true },
  { label: 'General', href: '/settings/general', anyOf: ['settings.view'] },
  { label: 'Pipelines', href: '/settings/pipelines', anyOf: ['pipelines.manage'], anywhere: true },
  { label: 'Products', href: '/settings/products', anyOf: ['catalog.manage'], anywhere: true },
  { label: 'Custom fields', href: '/settings/fields', anyOf: ['fields.manage'], anywhere: true },
  // Phase 3: connections, channels, the sandbox outbox and API keys (app/(app)/settings/integrations).
  { label: 'Integrations', href: '/settings/integrations', anyOf: ['integrations.view', 'api_keys.manage'], anywhere: true },
  // Phase 5 foundations: WhatsApp, email and SMS templates (app/(app)/settings/templates).
  { label: 'Templates', href: '/settings/templates', anyOf: ['messaging.templates_view'], anywhere: true },
  { label: 'Forms', href: '/settings/forms', anyOf: ['intake.view'], anywhere: true },
  { label: 'Routing', href: '/settings/routing', anyOf: ['intake.view'], anywhere: true },
  { label: 'Booking', href: '/settings/booking', anyOf: ['scheduling.view'], anywhere: true },
  { label: 'Billing', href: '/settings/billing', anyOf: ['billing.configure'], anywhere: true },
  { label: 'Onboarding', href: '/settings/onboarding', anyOf: ['onboarding.configure'], anywhere: true },
  { label: 'Partner programmes', href: '/settings/partner-programmes', anyOf: ['partners.manage_plans'], anywhere: true },
  // Phase 9 foundations: AI guardrails, the review queue, knowledge base and agent test panel (app/(app)/settings/ai).
  { label: 'AI', href: '/settings/ai', anyOf: ['ai.view', 'ai.review'], anywhere: true },
  { label: 'Audit log', href: '/settings/audit', anyOf: ['audit.view'] },
  { label: 'Your account', href: '/settings/security', anyOf: [] },
  { label: 'API', href: '/settings/api', anyOf: [] },
];

/** Upcoming phases (docs/ARCHITECTURE.md section 17). Phase 2, the core CRM, is being built now. */
export const ROADMAP: Array<{ phase: number; title: string; detail: string }> = [
  { phase: 3, title: 'Integration framework', detail: 'Connectors, webhooks, sync jobs and API keys' },
  { phase: 4, title: 'Capture and intake', detail: 'Forms, WhatsApp and call leads, imports, de-duplication, routing' },
  { phase: 5, title: 'Communication', detail: 'WhatsApp, email, SMS and calls on one timeline' },
  { phase: 6, title: 'Scheduling', detail: 'Booking links across time zones, reminders, meeting attendance' },
  { phase: 7, title: 'Money', detail: 'Quotes, agreements and e-sign, payment links, instalments, GST invoices' },
  { phase: 8, title: 'Admissions and delivery', detail: 'Applications, enrollments, batches, ERP onboarding' },
  { phase: 9, title: 'Automation and AI agents', detail: 'Flows, intake and reply agents, nurture' },
  { phase: 10, title: 'Partners and portals', detail: 'Parents, students, institutes and brokers' },
  { phase: 11, title: 'Analytics', detail: 'Dashboards, funnels, attribution, forecasts' },
];
