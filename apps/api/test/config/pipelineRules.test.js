import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveStageBlocker,
  defaultStagePosition,
  entryRulesWithout,
  errorsForStage,
  insertAt,
  normalizeStage,
  requiredFieldChoices,
  stageOrderErrors,
  stageSetErrors,
} from '../../src/modules/pipelines/rules.js';
import { schemas } from '../../src/modules/pipelines/routes.js';

const stage = (key, category = 'open', extra = {}) => ({ key, name: key, category, requiredFields: [], entryRules: {}, ...extra });
const basic = () => [stage('new'), stage('demo'), stage('enrolled', 'won'), stage('lost', 'lost')];

const fields = [
  { key: 'grade', label: 'Grade', entity: 'deal', active: true, applies_to: null },
  { key: 'student_count', label: 'Students', entity: 'deal', active: true, applies_to: 'b2b' },
  { key: 'old_field', label: 'Old', entity: 'deal', active: false, applies_to: null },
  { key: 'heard_from', label: 'Heard from', entity: 'contact', active: true, applies_to: null },
];

const paths = (errors) => errors.map((error) => error.path);

test('a valid stage set has no errors', () => {
  assert.deepEqual(stageSetErrors(basic(), { kind: 'b2c', customDefinitions: fields }), []);
});

test('stage keys must be unique', () => {
  const stages = [...basic(), stage('demo')];
  assert.deepEqual(paths(stageSetErrors(stages)), ['body.stages.4.key']);
});

test('every category needs at least one stage', () => {
  const errors = stageSetErrors([stage('a'), stage('b'), stage('c')]);
  assert.deepEqual(
    errors.map((error) => error.message),
    ['Add at least one won stage', 'Add at least one lost stage'],
  );
  assert.ok(errors.every((error) => error.path === 'body.stages'));
  // Several won or lost stages are fine (the contract asks for at least one of each).
  assert.deepEqual(stageSetErrors([...basic(), stage('enrolled_late', 'won')]), []);
});

test('required fields must be built-in deal fields or active custom deal fields', () => {
  const stages = basic();
  stages[1].requiredFields = ['productLineId', 'custom.grade', 'custom.old_field', 'custom.heard_from', 'nonsense'];
  const errors = stageSetErrors(stages, { kind: 'b2c', customDefinitions: fields });
  assert.deepEqual(paths(errors), ['body.stages.1.requiredFields.2', 'body.stages.1.requiredFields.3', 'body.stages.1.requiredFields.4']);
  assert.match(errors[0].message, /No active custom deal field/);
  assert.equal(errors[2].message, 'Unknown deal field');
});

test('required fields must exist on deals of the pipeline kind', () => {
  const b2c = basic();
  b2c[1].requiredFields = ['accountId', 'custom.student_count', 'students'];
  assert.deepEqual(paths(stageSetErrors(b2c, { kind: 'b2c', customDefinitions: fields })), [
    'body.stages.1.requiredFields.0',
    'body.stages.1.requiredFields.1',
  ]);
  const b2b = basic();
  b2b[1].requiredFields = ['accountId', 'custom.student_count', 'students', 'householdId'];
  assert.deepEqual(paths(stageSetErrors(b2b, { kind: 'b2b', customDefinitions: fields })), [
    'body.stages.1.requiredFields.2',
    'body.stages.1.requiredFields.3',
  ]);
});

test('entry rules must name other stages of the pipeline', () => {
  const stages = basic();
  stages[2].entryRules = { allowedFrom: ['demo', 'enrolled', 'missing'] };
  const errors = stageSetErrors(stages);
  assert.deepEqual(paths(errors), ['body.stages.2.entryRules.allowedFrom.1', 'body.stages.2.entryRules.allowedFrom.2']);
  assert.match(errors[0].message, /itself/);
  // Any stage of the set counts, also one listed later.
  const later = basic();
  later[0].entryRules = { allowedFrom: ['demo'] };
  assert.deepEqual(stageSetErrors(later), []);
});

test('normalizeStage drops repeats and empty entry rules', () => {
  assert.deepEqual(normalizeStage(stage('x', 'open', { requiredFields: ['a', 'a', 'b'], entryRules: { allowedFrom: ['y', 'y'] } })).requiredFields, ['a', 'b']);
  assert.deepEqual(normalizeStage(stage('x', 'open', { entryRules: { allowedFrom: ['y', 'y'] } })).entryRules, { allowedFrom: ['y'] });
  assert.deepEqual(normalizeStage(stage('x', 'open', { entryRules: { allowedFrom: [] } })).entryRules, {});
});

test('errorsForStage re-roots one stage\'s errors for single-stage requests', () => {
  const errors = [
    { path: 'body.stages.1.requiredFields.0', message: 'a' },
    { path: 'body.stages.2.key', message: 'b' },
    { path: 'body.stages', message: 'c' },
  ];
  assert.deepEqual(errorsForStage(errors, 1), [
    { path: 'body.requiredFields.0', message: 'a' },
    { path: 'body', message: 'c' },
  ]);
});

test('new stages go before the first won stage by default', () => {
  assert.equal(defaultStagePosition(basic()), 2);
  assert.equal(defaultStagePosition([stage('a'), stage('b')]), 2);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 1), ['a', 'x', 'b', 'c']);
  assert.deepEqual(insertAt(['a'], 'x', 99), ['a', 'x']);
  assert.deepEqual(insertAt(['a'], 'x', -3), ['x', 'a']);
});

test('a new order lists every active stage exactly once', () => {
  assert.deepEqual(stageOrderErrors(['a', 'b', 'c'], ['c', 'a', 'b']), []);
  assert.deepEqual(paths(stageOrderErrors(['a', 'b', 'c'], ['c', 'a', 'a'])), ['body.stageIds.2', 'body.stageIds']);
  assert.deepEqual(paths(stageOrderErrors(['a', 'b', 'c'], ['c', 'a', 'b', 'z'])), ['body.stageIds.3']);
});

test('archiving a stage: the last of its category is refused', () => {
  const rows = [
    { id: '1', name: 'New', category: 'open' },
    { id: '2', name: 'Enrolled', category: 'won' },
    { id: '3', name: 'Lost', category: 'lost' },
  ];
  assert.match(archiveStageBlocker(rows[1], rows), /only won stage/);
  assert.equal(archiveStageBlocker(rows[0], [...rows, { id: '4', name: 'Demo', category: 'open' }]), null);
});

test('archiving a stage removes its key from entry rules, unless that empties them', () => {
  const rows = [
    { id: '1', name: 'Fee proposed', entry_rules: { allowedFrom: ['demo_done', 'contacted'] } },
    { id: '2', name: 'Enrolled', entry_rules: { allowedFrom: ['demo_done'] } },
    { id: '3', name: 'Lost', entry_rules: {} },
  ];
  const result = entryRulesWithout(rows, 'demo_done');
  assert.deepEqual(result.updates, [{ id: '1', entryRules: { allowedFrom: ['contacted'] } }]);
  assert.deepEqual(result.blockedBy.map((row) => row.id), ['2']);
  assert.deepEqual(entryRulesWithout(rows, 'nothing'), { updates: [], blockedBy: [] });
});

test('required field choices follow the pipeline kind', () => {
  const all = requiredFieldChoices(fields).map((choice) => choice.key);
  assert.ok(all.includes('accountId') && all.includes('students') && all.includes('custom.grade') && all.includes('custom.student_count'));
  assert.ok(!all.includes('custom.old_field') && !all.includes('custom.heard_from'));
  const b2c = requiredFieldChoices(fields, 'b2c').map((choice) => choice.key);
  assert.ok(!b2c.includes('accountId') && !b2c.includes('custom.student_count') && b2c.includes('students'));
  const b2b = requiredFieldChoices(fields, 'b2b').map((choice) => choice.key);
  assert.ok(b2b.includes('accountId') && !b2b.includes('householdId') && b2b.includes('custom.student_count'));
});

test('request schemas: stage defaults, limits and strict bodies', () => {
  const parsed = schemas.stageInput.parse({ key: ' Demo_Done ', name: 'Demo done', category: 'open' });
  assert.deepEqual(parsed, {
    key: 'demo_done',
    name: 'Demo done',
    category: 'open',
    probability: 0,
    slaHours: null,
    requiredFields: [],
    entryRules: {},
    colour: null,
  });
  assert.equal(schemas.stageInput.safeParse({ key: 'a', name: 'A', category: 'open', slaHours: 0 }).success, false);
  assert.equal(schemas.stageInput.safeParse({ key: 'a', name: 'A', category: 'open', colour: 'blue' }).success, false);
  assert.equal(schemas.stageInput.safeParse({ key: '1a', name: 'A', category: 'open' }).success, false);
  assert.equal(schemas.stageInput.safeParse({ key: 'a', name: 'A', category: 'done' }).success, false);
  // A PATCH changes only what it names.
  assert.deepEqual(schemas.stagePatchBody.parse({ name: 'Renamed' }), { name: 'Renamed' });
  assert.equal(schemas.stagePatchBody.safeParse({ key: 'other' }).success, false);
  assert.equal(schemas.stagePatchBody.safeParse({ category: 'won' }).success, false);
  assert.equal(schemas.pipelinePatchBody.safeParse({ isDefault: false }).success, false);
  assert.equal(schemas.pipelinePatchBody.safeParse({ kind: 'b2b' }).success, false);
  const create = { companyId: crypto.randomUUID(), key: 'p', name: 'P', kind: 'b2c', stages: basic().slice(0, 2) };
  assert.equal(schemas.pipelineCreateBody.safeParse(create).success, false, 'at least three stages');
  assert.equal(schemas.pipelineListQuery.safeParse({}).success, false, 'unitId or companyId');
  assert.equal(schemas.pipelineListQuery.safeParse({ unitId: crypto.randomUUID(), companyId: crypto.randomUUID() }).success, false);
  assert.equal(schemas.pipelineListQuery.parse({ unitId: create.companyId, includeArchived: 'true' }).includeArchived, true);
});
