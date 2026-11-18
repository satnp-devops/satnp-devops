import { z } from 'zod';
import { db as defaultDb } from '../../lib/db.js';
import { getSetting } from '../../core/settings.js';

export const automationsEnabledSetting = {
  key: 'automations.enabled',
  category: 'Automations',
  label: 'Run automations',
  description: 'Start new automation runs for this company. Turn off to stop every flow from starting; runs already going carry on (pause a flow to hold its runs).',
  input: 'boolean',
  schema: z.boolean(),
  default: true,
  levels: ['group', 'company'],
};

export const automationSettings = [automationsEnabledSetting];

/** Whether new runs may start in a company (the setting, inherited from the group). */
export async function automationsEnabled(companyId, trx = defaultDb) {
  const company = await trx('org_units').where({ id: companyId }).first('id', 'path', 'root_id', 'type');
  if (!company) return false;
  return (await getSetting(company, automationsEnabledSetting, trx)) !== false;
}
