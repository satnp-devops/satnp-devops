import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { hashPassword } from '../../lib/crypto.js';
import { childPath } from '../../core/orgTree.js';
import { createRegistry } from '../../core/registry.js';
import { syncSystemRoles } from '../../core/systemRoles.js';
import { modules } from '../../modules/index.js';

// Demo data for local development: the Phoenix group, three companies with branches
// and teams, and people at different levels so permissions can be tried out.

const GROUP_CODE = 'phoenix';

export async function seed(knex) {
  const registry = createRegistry(modules);
  await syncSystemRoles(knex, registry);

  const existing = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (existing) {
    console.log('Demo data is already there. Run `npm run db:reset` to start over.');
    return;
  }

  const units = new Map();
  async function addUnit(key, { parent, type, name, code, profile = {} }) {
    const id = randomUUID();
    const parentRow = parent ? units.get(parent) : null;
    const row = {
      id,
      parent_id: parentRow?.id ?? null,
      root_id: parentRow?.root_id ?? id,
      type,
      name,
      code,
      path: childPath(parentRow?.path ?? null, id),
      depth: parentRow ? parentRow.depth + 1 : 0,
      profile: JSON.stringify(profile),
    };
    await knex('org_units').insert(row);
    units.set(key, row);
  }

  await addUnit('group', {
    type: 'group',
    name: 'Phoenix Educational Institute',
    code: GROUP_CODE,
    profile: { legalName: 'Phoenix Educational Institute' },
  });

  // Companies
  await addUnit('pivector', {
    parent: 'group',
    type: 'company',
    name: 'Pi Vector',
    code: 'pi-vector',
    profile: { brandName: 'Pi Vector', businessLines: ['b2c'], brandColor: '#0E7C66' },
  });
  await addUnit('satnpaper', {
    parent: 'group',
    type: 'company',
    name: 'SatnPaper',
    code: 'satnpaper',
    profile: { brandName: 'SatnPaper', businessLines: ['b2c', 'b2b'], brandColor: '#2840D8' },
  });
  await addUnit('excel', {
    parent: 'group',
    type: 'company',
    name: 'Excel',
    code: 'excel',
    profile: { brandName: 'Excel', businessLines: ['b2c'], brandColor: '#C2410C' },
  });

  // SatnPaper: a centre, online delivery, a family admissions team and a software sales team
  await addUnit('sp-pune', {
    parent: 'satnpaper',
    type: 'branch',
    name: 'Pune centre',
    code: 'pune',
    profile: { mode: 'in_person', address: { city: 'Pune', state: 'Maharashtra', country: 'India' } },
  });
  await addUnit('sp-online', { parent: 'satnpaper', type: 'branch', name: 'Online', code: 'online', profile: { mode: 'online' } });
  await addUnit('sp-admissions', {
    parent: 'sp-online',
    type: 'team',
    name: 'SAT admissions',
    code: 'sat-admissions',
    profile: { function: 'admissions' },
  });
  await addUnit('sp-software', {
    parent: 'satnpaper',
    type: 'team',
    name: 'Software sales',
    code: 'software-sales',
    profile: { function: 'b2b_sales' },
  });

  // Pi Vector: a region with a branch
  await addUnit('pv-north', { parent: 'pivector', type: 'region', name: 'North', code: 'north' });
  await addUnit('pv-delhi', {
    parent: 'pv-north',
    type: 'branch',
    name: 'Delhi centre',
    code: 'delhi',
    profile: { mode: 'hybrid', address: { city: 'New Delhi', state: 'Delhi', country: 'India' } },
  });
  await addUnit('pv-admissions', {
    parent: 'pv-delhi',
    type: 'team',
    name: 'Admissions',
    code: 'admissions',
    profile: { function: 'admissions' },
  });

  // Excel
  await addUnit('ex-mumbai', {
    parent: 'excel',
    type: 'branch',
    name: 'Mumbai centre',
    code: 'mumbai',
    profile: { mode: 'in_person', address: { city: 'Mumbai', state: 'Maharashtra', country: 'India' } },
  });
  await addUnit('ex-admissions', {
    parent: 'ex-mumbai',
    type: 'team',
    name: 'Admissions',
    code: 'admissions',
    profile: { function: 'admissions' },
  });

  // Settings: set once on the group, overridden per company where it differs
  const settings = [
    ['group', 'locale.timeZone', 'Asia/Kolkata'],
    ['group', 'locale.currency', 'INR'],
    ['pivector', 'branding.primaryColor', '#0E7C66'],
    ['satnpaper', 'branding.primaryColor', '#2840D8'],
    ['excel', 'branding.primaryColor', '#C2410C'],
  ];
  for (const [unitKey, key, value] of settings) {
    await knex('settings').insert({ org_unit_id: units.get(unitKey).id, key, value: JSON.stringify(value) });
  }

  // People
  const roles = new Map((await knex('roles').whereNull('group_id')).map((role) => [role.key, role]));
  const passwordHash = await hashPassword(env.SEED_PASSWORD);
  const people = [
    { email: 'owner@phoenix.test', name: 'Anand Rao', access: [['group_owner', 'group']] },
    { email: 'admin@phoenix.test', name: 'Meenal Joshi', access: [['group_admin', 'group']] },
    { email: 'finance@phoenix.test', name: 'Farah Siddiqui', access: [['finance', 'group']] },
    { email: 'admin.satnpaper@phoenix.test', name: 'Rohit Bansal', access: [['company_admin', 'satnpaper']] },
    {
      email: 'kabir@phoenix.test',
      name: 'Kabir Anand',
      access: [
        ['manager', 'sp-online'],
        ['counsellor', 'sp-admissions'],
      ],
    },
    { email: 'ritika@phoenix.test', name: 'Ritika Sharma', access: [['counsellor', 'sp-admissions']] },
    { email: 'sales.satnpaper@phoenix.test', name: 'Dev Khanna', access: [['account_executive', 'sp-software']] },
    { email: 'admin.pivector@phoenix.test', name: 'Nisha Pillai', access: [['company_admin', 'pivector']] },
  ];

  for (const person of people) {
    const [user] = await knex('users')
      .insert({ email: person.email, name: person.name, status: 'active', password_hash: passwordHash })
      .returning('*');
    for (const [roleKey, unitKey] of person.access) {
      await knex('role_assignments').insert({
        user_id: user.id,
        role_id: roles.get(roleKey).id,
        org_unit_id: units.get(unitKey).id,
      });
    }
  }

  console.log(`Seeded the Phoenix group with ${units.size} units and ${people.length} people.`);
  console.log(`Sign in as owner@phoenix.test (or any seeded person) with the SEED_PASSWORD from .env.`);
}
