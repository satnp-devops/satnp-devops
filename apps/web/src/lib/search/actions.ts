import type { IconName } from '@/components/icons';
import type { Session } from '@/lib/session';
import { visibleSettingsTabs } from '@/lib/settingsTabs';

// Quick actions in the palette: shortcuts to pages the user may open in the current scope.
// The same permission checks as the sidebar (lib/nav.ts) and the settings tabs (lib/settingsTabs.ts).

export interface QuickAction {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** 'Go to' pages and creation, or a settings page. */
  section: 'actions' | 'settings';
  /** Extra words it can be found by ("add enquiry" finds New lead). */
  keywords?: string[];
}

/** Opens the deals slice's new-lead dialog on the Leads page. */
export const NEW_LEAD_HREF = '/leads?new=1';

type ActionSession = Pick<Session, 'can' | 'canAnywhere' | 'mfaSetupRequired'>;

interface ActionDefinition extends Omit<QuickAction, 'section'> {
  anyOf: string[];
}

const ACTIONS: ActionDefinition[] = [
  { id: 'new-lead', label: 'New lead', href: NEW_LEAD_HREF, icon: 'plus', anyOf: ['deals.manage'], keywords: ['create', 'add', 'enquiry', 'deal'] },
  { id: 'tasks', label: 'My tasks', href: '/tasks', icon: 'tasks', anyOf: ['tasks.view'], keywords: ['todo', 'follow up'] },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', icon: 'kanban', anyOf: ['deals.view'], keywords: ['board', 'stages'] },
  { id: 'leads', label: 'Leads', href: '/leads', icon: 'funnel', anyOf: ['deals.view', 'contacts.view'], keywords: ['enquiries', 'deals'] },
  { id: 'contacts', label: 'Contacts', href: '/leads/contacts', icon: 'users', anyOf: ['contacts.view'], keywords: ['people', 'parents', 'students'] },
  { id: 'accounts', label: 'Accounts', href: '/accounts', icon: 'building', anyOf: ['accounts.view'], keywords: ['institutes', 'schools'] },
];

/** The actions this user may take in their current scope, in display order. */
export function quickActions(session: ActionSession): QuickAction[] {
  if (session.mfaSetupRequired) return [];
  const pages: QuickAction[] = ACTIONS.filter((action) => action.anyOf.some((permission) => session.canAnywhere(permission))).map(
    (action) => ({ id: action.id, label: action.label, href: action.href, icon: action.icon, keywords: action.keywords, section: 'actions' }),
  );
  const settings: QuickAction[] = visibleSettingsTabs(session).map((tab) => ({
    id: `settings:${tab.href}`,
    label: `Settings: ${tab.label}`,
    href: tab.href,
    icon: 'settings',
    section: 'settings',
    keywords: ['settings', 'configure'],
  }));
  return [...pages, ...settings];
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Actions whose label or keywords contain every typed word as a word prefix
 * ("set peo" finds "Settings: People"). An empty query returns them all.
 */
export function filterActions(actions: readonly QuickAction[], query: string): QuickAction[] {
  const typed = words(query);
  if (typed.length === 0) return [...actions];
  return actions.filter((action) => {
    const own = words([action.label, ...(action.keywords ?? [])].join(' '));
    return typed.every((word) => own.some((candidate) => candidate.startsWith(word)));
  });
}
