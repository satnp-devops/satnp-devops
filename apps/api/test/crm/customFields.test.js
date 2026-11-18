import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applicableDefinitions,
  buildCustomFieldsSchema,
  customFieldDefinitionSchema,
  customFieldKeyOf,
  customFieldRef,
  isFilled,
  validateCustomValues,
} from '../../src/core/crm/customFields.js';
import { requiredFieldOptions, unknownRequiredFields } from '../../src/core/crm/dealFields.js';

const defs = [
  { key: 'grade', label: 'Grade', type: 'select', options: [{ value: 'class_11', label: 'Class 11' }, { value: 'class_12', label: 'Class 12' }], required: true, applies_to: 'b2c', active: true, entity: 'deal' },
  { key: 'subjects', label: 'Subjects', type: 'multiselect', options: [{ value: 'maths', label: 'Maths' }, { value: 'physics', label: 'Physics' }], required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'target_score', label: 'Target score', type: 'number', required: false, applies_to: 'b2c', active: true, entity: 'deal' },
  { key: 'demo_on', label: 'Demo date', type: 'date', required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'alt_phone', label: 'Other phone', type: 'phone', required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'billing_email', label: 'Billing email', type: 'email', required: false, applies_to: 'b2b', active: true, entity: 'deal' },
  { key: 'website', label: 'Website', type: 'url', required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'notes', label: 'Notes', type: 'textarea', required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'scholarship', label: 'Scholarship', type: 'boolean', required: false, applies_to: null, active: true, entity: 'deal' },
  { key: 'old_field', label: 'Old field', type: 'text', required: true, applies_to: null, active: false, entity: 'deal' },
];

test('definitions are validated before they are saved', () => {
  const ok = customFieldDefinitionSchema.safeParse({ entity: 'deal', key: 'Grade', label: 'Grade', type: 'select', options: [{ value: 'class_11', label: 'Class 11' }] });
  assert.ok(ok.success);
  assert.equal(ok.data.key, 'grade', 'keys are lower-cased');
  assert.equal(ok.data.required, false);
  assert.equal(ok.data.appliesTo, null);

  const noOptions = customFieldDefinitionSchema.safeParse({ entity: 'deal', key: 'grade', label: 'Grade', type: 'select' });
  assert.ok(!noOptions.success);
  const optionsOnText = customFieldDefinitionSchema.safeParse({ entity: 'deal', key: 'x', label: 'X', type: 'text', options: [{ value: 'a', label: 'A' }] });
  assert.ok(!optionsOnText.success);
  const duplicate = customFieldDefinitionSchema.safeParse({ entity: 'deal', key: 'x', label: 'X', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] });
  assert.ok(!duplicate.success);
  const kindOnContact = customFieldDefinitionSchema.safeParse({ entity: 'contact', key: 'x', label: 'X', type: 'text', appliesTo: 'b2c' });
  assert.ok(!kindOnContact.success);
  assert.ok(!customFieldDefinitionSchema.safeParse({ entity: 'deal', key: '1abc', label: 'X', type: 'text' }).success);
  assert.ok(!customFieldDefinitionSchema.safeParse({ entity: 'task', key: 'abc', label: 'X', type: 'text' }).success);
});

test('only active fields for the deal kind apply', () => {
  assert.deepEqual(
    applicableDefinitions(defs, { kind: 'b2b' }).map((d) => d.key),
    ['subjects', 'demo_on', 'alt_phone', 'billing_email', 'website', 'notes', 'scholarship'],
  );
  assert.ok(applicableDefinitions(defs, { kind: 'b2c' }).some((d) => d.key === 'grade'));
  assert.ok(!applicableDefinitions(defs).some((d) => d.key === 'old_field'));
});

test('values are checked and normalised by type', () => {
  const schema = buildCustomFieldsSchema(defs, { kind: 'b2c', partial: true, defaultCountry: 'IN' });
  const parsed = schema.parse({
    grade: 'class_11',
    subjects: ['maths', 'maths', 'physics'],
    target_score: '1450',
    demo_on: '2026-12-01',
    alt_phone: '098123 45678',
    website: 'https://school.example',
    notes: '  likes evening slots ',
    scholarship: true,
  });
  assert.deepEqual(parsed, {
    grade: 'class_11',
    subjects: ['maths', 'physics'],
    target_score: 1450,
    demo_on: '2026-12-01',
    alt_phone: '+919812345678',
    website: 'https://school.example',
    notes: 'likes evening slots',
    scholarship: true,
  });
  for (const [key, value] of [
    ['grade', 'class_9'],
    ['subjects', ['chemistry']],
    ['target_score', 'lots'],
    ['demo_on', '01/12/2026'],
    ['alt_phone', '12345'],
    ['website', 'javascript:alert(1)'],
    ['scholarship', 'yes'],
  ]) {
    assert.ok(!schema.safeParse({ [key]: value }).success, `${key}=${JSON.stringify(value)} should fail`);
  }
  assert.ok(!schema.safeParse({ unknown_key: 'x' }).success, 'unknown keys are rejected');
  assert.ok(!schema.safeParse({ old_field: 'x' }).success, 'inactive fields are rejected');
  assert.ok(!schema.safeParse({ billing_email: 'a@b.example' }).success, 'b2b-only fields are rejected on b2c');
});

test('a full schema enforces required fields with readable messages', () => {
  const schema = buildCustomFieldsSchema(defs, { kind: 'b2c' });
  const result = schema.safeParse({ subjects: ['maths'] });
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues.map((i) => [i.path.join('.'), i.message]), [['grade', 'Grade is required']]);
  assert.ok(buildCustomFieldsSchema(defs, { kind: 'b2c', enforceRequired: false }).safeParse({}).success);
});

test('validateCustomValues merges over stored values; null and empty strings clear', () => {
  const existing = { grade: 'class_11', notes: 'old', old_field: 'kept' };
  const merged = validateCustomValues(defs, { notes: '', target_score: 1500 }, { existing, kind: 'b2c' });
  assert.deepEqual(merged, { grade: 'class_11', old_field: 'kept', target_score: 1500 });

  assert.throws(
    () => validateCustomValues(defs, { grade: null }, { existing, kind: 'b2c' }),
    (err) => err.status === 422 && err.details[0].path === 'body.custom.grade' && err.details[0].message === 'Grade is required',
  );
  assert.throws(
    () => validateCustomValues(defs, { grade: 'class_99' }, { kind: 'b2c', path: 'body.fields.custom' }),
    (err) => err.status === 422 && err.details[0].path === 'body.fields.custom.grade',
  );
  // System intake doesn't enforce required fields.
  assert.deepEqual(validateCustomValues(defs, { notes: 'x' }, { kind: 'b2c', enforceRequired: false }), { notes: 'x' });
});

test('filled checks and stage references for custom fields', () => {
  assert.ok(isFilled('x'));
  assert.ok(isFilled(0));
  assert.ok(isFilled(false));
  assert.ok(!isFilled('  '));
  assert.ok(!isFilled([]));
  assert.ok(!isFilled(null));
  assert.equal(customFieldRef('grade'), 'custom.grade');
  assert.equal(customFieldKeyOf('custom.grade'), 'grade');
  assert.equal(customFieldKeyOf('productId'), null);
});

test('stage required fields come from deal fields and active custom deal fields', () => {
  const options = requiredFieldOptions(defs);
  assert.ok(options.some((o) => o.key === 'productLineId' && o.source === 'deal'));
  assert.ok(options.some((o) => o.key === 'students'));
  assert.ok(options.some((o) => o.key === 'custom.grade' && o.source === 'custom'));
  assert.ok(!options.some((o) => o.key === 'custom.old_field'));
  assert.deepEqual(unknownRequiredFields(['productId', 'custom.grade', 'custom.nope', 'colour'], defs), ['custom.nope', 'colour']);
});

test('phone and email custom values are masked for viewers without contacts.view_pii; echoes of the mask are no change', async () => {
  const { maskCustomPii, withoutMaskedEchoes, PII_CUSTOM_FIELD_TYPES } = await import('../../src/core/crm/customFields.js');
  assert.deepEqual([...PII_CUSTOM_FIELD_TYPES].sort(), ['email', 'phone']);
  const piiDefs = defs.filter((d) => PII_CUSTOM_FIELD_TYPES.includes(d.type));
  const stored = { alt_phone: '+919876543210', billing_email: 'accounts@school.in', grade: 'class_11', target_score: 1500 };
  const shown = maskCustomPii(stored, piiDefs);
  assert.notEqual(shown.alt_phone, stored.alt_phone);
  assert.ok(!shown.alt_phone.includes('98765'));
  assert.ok(!shown.billing_email.startsWith('accounts@'));
  assert.equal(shown.grade, 'class_11');
  assert.equal(shown.target_score, 1500);
  assert.deepEqual(maskCustomPii(null, piiDefs), {});
  // The masked values sent back unchanged are dropped; a real edit stays.
  assert.deepEqual(withoutMaskedEchoes({ ...shown, grade: 'class_12' }, stored, piiDefs), { grade: 'class_12', target_score: 1500 });
  assert.deepEqual(withoutMaskedEchoes({ alt_phone: '+919000011111' }, stored, piiDefs), { alt_phone: '+919000011111' });
  assert.equal(withoutMaskedEchoes(undefined, stored, piiDefs), undefined);
});
