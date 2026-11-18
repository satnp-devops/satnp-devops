import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../src/core/settings.js';
import { settingDefinitions } from '../src/modules/settings/definitions.js';

const definitions = [
  { key: 'locale.timeZone', default: 'Asia/Kolkata' },
  { key: 'locale.currency', default: 'INR' },
  { key: 'security.requireMfa', default: false },
];

test('values inherit from the nearest ancestor and fall back to defaults', () => {
  const result = resolveSettings({
    definitions,
    chainIds: ['group', 'company', 'branch'],
    rows: [
      { org_unit_id: 'group', key: 'locale.timeZone', value: 'Asia/Kolkata' },
      { org_unit_id: 'company', key: 'locale.timeZone', value: 'Asia/Dubai' },
      { org_unit_id: 'group', key: 'security.requireMfa', value: true },
    ],
  });
  assert.deepEqual(result['locale.timeZone'], {
    value: 'Asia/Dubai',
    sourceUnitId: 'company',
    inherited: true,
    isDefault: false,
  });
  assert.equal(result['security.requireMfa'].value, true);
  assert.equal(result['security.requireMfa'].sourceUnitId, 'group');
  assert.deepEqual(result['locale.currency'], { value: 'INR', sourceUnitId: null, inherited: true, isDefault: true });
});

test('a value set on the unit itself is not inherited', () => {
  const result = resolveSettings({
    definitions,
    chainIds: ['group', 'company'],
    rows: [{ org_unit_id: 'company', key: 'locale.currency', value: 'AED' }],
  });
  assert.equal(result['locale.currency'].inherited, false);
});

test('setting definitions validate their values', () => {
  const byKey = new Map(settingDefinitions.map((d) => [d.key, d]));
  assert.ok(byKey.get('locale.timeZone').schema.safeParse('Asia/Singapore').success);
  assert.ok(!byKey.get('locale.timeZone').schema.safeParse('Mars/Olympus').success);
  assert.ok(byKey.get('branding.primaryColor').schema.safeParse('#2840D8').success);
  assert.ok(!byKey.get('branding.primaryColor').schema.safeParse('blue').success);
  assert.ok(byKey.get('workingHours.days').schema.safeParse([1, 2, 3]).success);
  assert.ok(!byKey.get('workingHours.days').schema.safeParse([]).success);
  assert.ok(!byKey.get('workingHours.start').schema.safeParse('25:00').success);
  for (const definition of settingDefinitions) {
    assert.ok(definition.schema.safeParse(definition.default).success, `${definition.key} default is valid`);
  }
});
