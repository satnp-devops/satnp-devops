import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customFieldDefinitionSchema } from '../../src/core/crm/customFields.js';
import { definitionErrors, mergedDefinition, orderFields, stageConflict, stagesRequiring } from '../../src/modules/fields/rules.js';
import { productAttributesSchema, productCodeSchema } from '../../src/modules/catalog/routes.js';

const row = (extra = {}) => ({
  id: 'f1',
  entity: 'deal',
  key: 'grade',
  label: 'Grade',
  type: 'select',
  options: [{ value: 'g10', label: 'Grade 10' }],
  required: false,
  applies_to: null,
  help: null,
  position: 0,
  active: true,
  ...extra,
});

test('definition rules: options only and always for select types', () => {
  assert.deepEqual(definitionErrors({ entity: 'deal', type: 'select', options: [{ value: 'a' }], appliesTo: null }), []);
  assert.deepEqual(definitionErrors({ entity: 'deal', type: 'multiselect', options: [], appliesTo: null }).map((e) => e.path), ['body.options']);
  assert.deepEqual(definitionErrors({ entity: 'deal', type: 'text', options: [{ value: 'a' }], appliesTo: null }).map((e) => e.path), ['body.options']);
  assert.match(definitionErrors({ entity: 'deal', type: 'select', options: [{ value: 'a' }, { value: 'a' }], appliesTo: null })[0].message, /different/);
  assert.deepEqual(definitionErrors({ entity: 'contact', type: 'text', options: [], appliesTo: 'b2c' }).map((e) => e.path), ['body.appliesTo']);
});

test('the shared create schema applies the same rules', () => {
  const base = { entity: 'deal', key: 'mode', label: 'Mode', type: 'select' };
  assert.equal(customFieldDefinitionSchema.safeParse(base).success, false, 'select without options');
  assert.equal(customFieldDefinitionSchema.safeParse({ ...base, options: [{ value: 'online', label: 'Online' }] }).success, true);
  assert.equal(customFieldDefinitionSchema.safeParse({ ...base, entity: 'contact', appliesTo: 'b2b', options: [{ value: 'a', label: 'A' }] }).success, false);
  assert.equal(customFieldDefinitionSchema.safeParse({ ...base, type: 'colour' }).success, false);
});

test('mergedDefinition: a PATCH over the stored row', () => {
  const merged = mergedDefinition(row(), { label: 'Class', required: true });
  assert.equal(merged.label, 'Class');
  assert.equal(merged.required, true);
  assert.deepEqual(merged.options, row().options);
  // Switching to a type without options drops the old ones…
  assert.deepEqual(mergedDefinition(row(), { type: 'text' }).options, []);
  // …unless the request sends options, which is then an error.
  const sent = mergedDefinition(row(), { type: 'text', options: [{ value: 'x', label: 'X' }] });
  assert.deepEqual(definitionErrors(sent).map((e) => e.path), ['body.options']);
  // Switching to a select type needs options.
  assert.deepEqual(definitionErrors(mergedDefinition(row({ type: 'text', options: [] }), { type: 'select' })).map((e) => e.path), ['body.options']);
  // null clears help and appliesTo; undefined keeps them.
  assert.equal(mergedDefinition(row({ help: 'Hint', applies_to: 'b2c' }), { help: null }).help, null);
  assert.equal(mergedDefinition(row({ help: 'Hint', applies_to: 'b2c' }), {}).appliesTo, 'b2c');
});

const stages = [
  { id: 's1', name: 'Demo booked', required_fields: ['custom.grade', 'students'], pipeline_name: 'Admissions', pipeline_kind: 'b2c' },
  { id: 's2', name: 'Qualified', required_fields: ['custom.grade'], pipeline_name: 'Software sales', pipeline_kind: 'b2b' },
  { id: 's3', name: 'New', required_fields: [], pipeline_name: 'Admissions', pipeline_kind: 'b2c' },
];

test('stages that require a field', () => {
  assert.deepEqual(stagesRequiring(stages, 'grade').map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(stagesRequiring(stages, 'other'), []);
});

test('deactivating a deal field a stage requires is refused, naming the stages', () => {
  const conflict = stageConflict(row(), { active: false, appliesTo: null }, stages);
  assert.match(conflict.message, /Admissions › Demo booked, Software sales › Qualified/);
  assert.deepEqual(conflict.stages.map((s) => s.id), ['s1', 's2']);
  assert.equal(stageConflict(row({ key: 'other' }), { active: false, appliesTo: null }, stages), null);
  assert.equal(stageConflict(row({ entity: 'contact' }), { active: false, appliesTo: null }, stages), null);
  assert.equal(stageConflict(row({ active: false }), { active: false, appliesTo: null }, stages), null, 'already inactive');
});

test('limiting a field to one kind is refused when the other kind requires it', () => {
  const conflict = stageConflict(row(), { active: true, appliesTo: 'b2c' }, stages);
  assert.deepEqual(conflict.stages.map((s) => s.id), ['s2']);
  assert.equal(stageConflict(row({ key: 'only_b2c' }), { active: true, appliesTo: 'b2c' }, stages), null);
});

test('field order: listed first, the rest after in their current order', () => {
  const rows = [
    { id: 'a', position: 0, label: 'A' },
    { id: 'b', position: 1, label: 'B' },
    { id: 'c', position: 2, label: 'C' },
  ];
  assert.deepEqual(orderFields(rows, ['c', 'a']), { errors: [], order: ['c', 'a', 'b'] });
  assert.deepEqual(orderFields(rows, ['a', 'z', 'a']).errors.map((e) => e.path), ['body.ids.1', 'body.ids.2']);
});

test('product codes and attributes', () => {
  assert.equal(productCodeSchema.parse(' sat-batch-12 '), 'SAT-BATCH-12');
  assert.equal(productCodeSchema.safeParse('-SAT').success, false);
  assert.equal(productCodeSchema.safeParse('SAT BATCH').success, false);
  assert.equal(productCodeSchema.safeParse('A'.repeat(31)).success, false);
  assert.deepEqual(productAttributesSchema.parse({ mode: 'online', sessions: 24, grades: ['11', '12'] }), { mode: 'online', sessions: 24, grades: ['11', '12'] });
  assert.equal(productAttributesSchema.safeParse({ colour: 'red' }).success, false);
  assert.equal(productAttributesSchema.safeParse({ billing: 'weekly' }).success, false);
});
