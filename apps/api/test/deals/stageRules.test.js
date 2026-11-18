import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStageMove, missingRequiredFields, stageRulesMessage } from '../../src/modules/deals/stageRules.js';

// The seeded B2C admissions pipeline, as rows of pipeline_stages.
const P = 'pipeline-1';
const stage = (key, name, category, position, extra = {}) => ({
  id: `stage-${key}`,
  pipeline_id: P,
  key,
  name,
  category,
  position,
  required_fields: [],
  entry_rules: {},
  archived_at: null,
  ...extra,
});
const stages = [
  stage('new', 'New enquiry', 'open', 0),
  stage('contacted', 'Contacted', 'open', 1),
  stage('demo_booked', 'Demo booked', 'open', 2, { required_fields: ['productLineId', 'students', 'custom.grade'] }),
  stage('demo_done', 'Demo done', 'open', 3),
  stage('fee_proposed', 'Fee proposed', 'open', 4, { required_fields: ['productId', 'valueMinor'] }),
  stage('enrolled', 'Enrolled', 'won', 5, { entry_rules: { allowedFrom: ['demo_done', 'fee_proposed'] } }),
  stage('lost', 'Lost', 'lost', 6),
];
const byKey = (key) => stages.find((s) => s.key === key);
const definitions = [
  { key: 'grade', label: 'Grade', active: true, applies_to: 'b2c' },
  { key: 'old_field', label: 'Old field', active: false, applies_to: null },
  { key: 'student_count', label: 'Student count', active: true, applies_to: 'b2b' },
];
const facts = (overrides = {}) => ({ studentCount: 0, contactHasPhone: true, contactHasEmail: false, ...overrides });
const deal = (overrides = {}) => ({
  kind: 'b2c',
  pipeline_id: P,
  stage_id: 'stage-contacted',
  status: 'open',
  product_line_id: null,
  product_id: null,
  owner_user_id: 'user-1',
  value_minor: 0,
  expected_close_on: null,
  primary_contact_id: 'contact-1',
  household_id: null,
  account_id: null,
  custom: {},
  ...overrides,
});
const evaluate = (input) =>
  evaluateStageMove({ pipelineStages: stages, customDefinitions: definitions, facts: facts(), mode: 'move', ...input });

test('a move to a stage without rules passes', () => {
  const result = evaluate({ deal: deal(), fromStage: byKey('new'), toStage: byKey('contacted') });
  assert.deepEqual(result, { ok: true, missing: [], allowedFrom: null, reason: null });
});

test('required fields must be filled to enter a stage, each with its label', () => {
  const result = evaluate({ deal: deal(), fromStage: byKey('contacted'), toStage: byKey('demo_booked') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_fields');
  assert.deepEqual(result.missing, [
    { key: 'productLineId', label: 'Product line' },
    { key: 'students', label: 'Student' },
    { key: 'custom.grade', label: 'Grade' },
  ]);
  assert.equal(stageRulesMessage(result, byKey('demo_booked'), stages), 'Fill Product line, Student and Grade to move to Demo booked');
});

test('filled fields pass, reading built-in columns, facts and custom values', () => {
  const ready = deal({ product_line_id: 'pl-1', custom: { grade: '11' } });
  const result = evaluate({ deal: ready, fromStage: byKey('contacted'), toStage: byKey('demo_booked'), facts: facts({ studentCount: 1 }) });
  assert.equal(result.ok, true);
});

test('value must be above zero; bigint strings from Postgres are read as numbers', () => {
  const zero = evaluate({ deal: deal({ product_id: 'p-1', value_minor: '0' }), fromStage: byKey('demo_done'), toStage: byKey('fee_proposed') });
  assert.deepEqual(zero.missing, [{ key: 'valueMinor', label: 'Value' }]);
  const set = evaluate({ deal: deal({ product_id: 'p-1', value_minor: '5500000' }), fromStage: byKey('demo_done'), toStage: byKey('fee_proposed') });
  assert.equal(set.ok, true);
});

test('required fields of skipped stages are not checked', () => {
  // Straight from Contacted to Demo done skips Demo booked and its rules.
  const result = evaluate({ deal: deal(), fromStage: byKey('contacted'), toStage: byKey('demo_done') });
  assert.equal(result.ok, true);
});

test('allowedFrom limits where a stage can be reached from, on moves only', () => {
  const blocked = evaluate({ deal: deal(), fromStage: byKey('contacted'), toStage: byKey('enrolled') });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'not_allowed_from');
  assert.deepEqual(blocked.allowedFrom, ['demo_done', 'fee_proposed']);
  assert.equal(stageRulesMessage(blocked, byKey('enrolled'), stages), 'Enrolled can only be reached from Demo done or Fee proposed');

  assert.equal(evaluate({ deal: deal(), fromStage: byKey('fee_proposed'), toStage: byKey('enrolled') }).ok, true);
  assert.equal(evaluate({ deal: deal(), fromStage: null, toStage: byKey('enrolled'), mode: 'create' }).ok, true);
  assert.equal(evaluate({ deal: deal({ status: 'lost' }), fromStage: byKey('lost'), toStage: byKey('enrolled'), mode: 'reopen' }).ok, true);
});

test('required fields still apply on create and reopen', () => {
  const created = evaluate({ deal: deal(), fromStage: null, toStage: byKey('fee_proposed'), mode: 'create' });
  assert.equal(created.reason, 'missing_fields');
  const reopened = evaluate({ deal: deal({ status: 'lost' }), fromStage: byKey('lost'), toStage: byKey('demo_booked'), mode: 'reopen' });
  assert.equal(reopened.reason, 'missing_fields');
});

test('a stage of another pipeline or an archived stage is refused', () => {
  const other = { ...byKey('contacted'), id: 'stage-elsewhere', pipeline_id: 'pipeline-2' };
  assert.equal(evaluate({ deal: deal(), fromStage: byKey('new'), toStage: other }).reason, 'other_pipeline');
  const archived = { ...byKey('demo_done'), archived_at: new Date() };
  const result = evaluate({ deal: deal(), fromStage: byKey('new'), toStage: archived });
  assert.equal(result.reason, 'archived_stage');
  assert.equal(stageRulesMessage(result, archived, stages), 'Demo done is archived');
});

test('inactive, missing and other-kind custom fields are ignored; unknown keys too', () => {
  const toStage = { ...byKey('contacted'), required_fields: ['custom.old_field', 'custom.gone', 'custom.student_count', 'mystery'] };
  assert.deepEqual(missingRequiredFields({ deal: deal(), toStage, facts: facts(), customDefinitions: definitions }), []);
});

test('contact facts: phone and email of the main contact', () => {
  const toStage = { ...byKey('contacted'), required_fields: ['contactPhone', 'contactEmail', 'householdId', 'accountId', 'expectedCloseOn', 'ownerUserId'] };
  const missing = missingRequiredFields({ deal: deal({ owner_user_id: null }), toStage, facts: facts(), customDefinitions: [] });
  assert.deepEqual(
    missing.map((m) => m.key),
    ['contactEmail', 'householdId', 'accountId', 'expectedCloseOn', 'ownerUserId'],
  );
});

test('both problems at once: allowedFrom wins, missing fields are still reported', () => {
  const toStage = { ...byKey('enrolled'), required_fields: ['productId'] };
  const result = evaluate({ deal: deal(), fromStage: byKey('new'), toStage });
  assert.equal(result.reason, 'not_allowed_from');
  assert.deepEqual(result.missing, [{ key: 'productId', label: 'Product' }]);
});
