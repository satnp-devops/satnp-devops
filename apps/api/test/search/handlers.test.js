import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshPlan } from '../../src/modules/search/handlers.js';
import searchModule from '../../src/modules/search/module.js';

test('deal events refresh the deal', () => {
  assert.deepEqual(refreshPlan({ type: 'deal.stage_changed', aggregateId: 'd1', payload: { dealId: 'd1' } }), { deal: ['d1'] });
  assert.deepEqual(refreshPlan({ type: 'deal.archived', aggregateId: 'd2', payload: {} }), { deal: ['d2'] });
});

test('contact events refresh the contact, and edits and erasures its deals too', () => {
  assert.deepEqual(refreshPlan({ type: 'contact.company_linked', payload: { contactId: 'c1' } }), { contact: ['c1'], dealsWhere: [] });
  assert.deepEqual(refreshPlan({ type: 'contact.updated', payload: { contactId: 'c1', changes: ['displayName'] } }), {
    contact: ['c1'],
    dealsWhere: [{ column: 'primary_contact_id', value: 'c1' }],
  });
  assert.deepEqual(refreshPlan({ type: 'contact.erased', payload: { contactId: 'c1' } }).dealsWhere, [
    { column: 'primary_contact_id', value: 'c1' },
  ]);
});

test('a merge rebuilds the target and drops the source, with the deals of both', () => {
  assert.deepEqual(refreshPlan({ type: 'contact.merged', payload: { targetId: 't', sourceId: 's', companyIds: [] } }), {
    contact: ['t', 's'],
    dealsWhere: [
      { column: 'primary_contact_id', value: 't' },
      { column: 'primary_contact_id', value: 's' },
    ],
  });
});

test('institute and configuration events', () => {
  assert.deepEqual(refreshPlan({ type: 'account.updated', payload: { accountId: 'a1' } }), {
    account: ['a1'],
    dealsWhere: [{ column: 'account_id', value: 'a1' }],
  });
  assert.deepEqual(refreshPlan({ type: 'account.contact_added', payload: { accountId: 'a1' } }), { account: ['a1'], dealsWhere: [] });
  assert.deepEqual(refreshPlan({ type: 'pipeline_stage.updated', payload: { pipelineId: 'p', stageId: 's1' } }), {
    dealsWhere: [{ column: 'stage_id', value: 's1' }],
  });
  assert.deepEqual(refreshPlan({ type: 'pipeline_stage.archived', payload: { stageId: 's1' } }).dealsWhere[0].column, 'stage_id');
  assert.deepEqual(refreshPlan({ type: 'product_line.updated', payload: { productLineId: 'l1' } }), {
    dealsWhere: [{ column: 'product_line_id', value: 'l1' }],
  });
});

test('other events are ignored', () => {
  for (const type of ['task.created', 'pipeline_stage.created', 'household.updated', 'user.invited', 'product.updated']) {
    assert.equal(refreshPlan({ type, payload: {} }), null, type);
  }
  assert.equal(refreshPlan({ type: 'pipeline_stage.updated', payload: {} }), null);
});

test('the module registers one catch-all handler and its routes', () => {
  assert.equal(typeof searchModule.eventHandlers['*'], 'function');
  assert.equal(typeof searchModule.routes, 'function');
  assert.equal(searchModule.permissions, undefined, 'search has no permissions of its own');
});
