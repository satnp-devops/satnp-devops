import { SETTINGS_TABS, type SettingsTab } from './nav';
import type { Session } from './session';

/** Settings tabs the user may open in their current scope. */
export function visibleSettingsTabs(session: Pick<Session, 'can' | 'canAnywhere' | 'mfaSetupRequired'>): SettingsTab[] {
  if (session.mfaSetupRequired) return SETTINGS_TABS.filter((tab) => tab.anyOf.length === 0);
  return SETTINGS_TABS.filter(
    (tab) =>
      tab.anyOf.length === 0 ||
      tab.anyOf.some((permission) => (tab.anywhere ? session.canAnywhere(permission) : session.can(permission))),
  );
}
