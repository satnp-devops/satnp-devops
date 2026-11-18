import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExotelError,
  ExotelRateLimitError,
  checkCallCompliance,
  classifyIndianNumber,
  isSipUri,
  toE164,
  toE164Safe,
} from '../../../src/integrations/providers/exotel/index.js';

test('toE164 normalises common Indian formats', () => {
  for (const input of ['9876543210', '09876543210', '919876543210', '+91 98765 43210', '0091-98765-43210', '(+91) 98765.43210']) {
    assert.equal(toE164(input), '+919876543210', input);
  }
  assert.equal(toE164('080 4455 6678'), '+918044556678');
  assert.equal(toE164('18001234567'), '+9118001234567');
  assert.equal(toE164('+14155550123'), '+14155550123');
  assert.equal(toE164('7712345678', { defaultCountryCode: '1' }), '+17712345678');
  for (const bad of ['12345', '+91 12345', '0123456789', 'abc9876543210', '', '+0123456789']) {
    assert.equal(toE164Safe(bad), null, bad);
  }
  assert.throws(() => toE164('12345'), (e) => e instanceof ExotelError && e.code === 'invalid_phone');
});

test('isSipUri', () => {
  assert.equal(isSipUri('sip:agent@phoenix.exotel.com'), true);
  assert.equal(isSipUri('sip:agent'), false);
  assert.equal(isSipUri('9876543210'), false);
});

test('classifyIndianNumber recognises TRAI series', () => {
  assert.equal(classifyIndianNumber('1401234567'), 'promotional_140');
  assert.equal(classifyIndianNumber('+911600123456'), 'bfsi_govt_1600');
  assert.equal(classifyIndianNumber('1601234567'), 'service_1601');
  assert.equal(classifyIndianNumber('18001234567'), 'toll_free');
  assert.equal(classifyIndianNumber('9876543210'), 'standard');
  assert.equal(classifyIndianNumber('08044556678'), 'standard');
  assert.equal(classifyIndianNumber('+14155550123'), 'non_indian');
  assert.equal(classifyIndianNumber('nope'), 'invalid');
});

test('checkCallCompliance: promotional needs 140-series; service calls get warnings only', () => {
  const promoFromLandline = checkCallCompliance({ purpose: 'promotional', callerId: '08044556678' });
  assert.equal(promoFromLandline.allowed, false);
  assert.deepEqual(promoFromLandline.reasons, ['promotional_calls_require_140_series_caller_id']);
  assert.equal(checkCallCompliance({ purpose: 'promotional', callerId: '1401234567' }).allowed, true);
  const service = checkCallCompliance({ callerId: '08044556678' });
  assert.equal(service.allowed, true);
  assert.equal(service.series, 'standard');
  const serviceFrom140 = checkCallCompliance({ purpose: 'service', callerId: '1401234567' });
  assert.ok(serviceFrom140.warnings.includes('service_call_from_140_series_is_treated_as_promotional'));
  assert.ok(checkCallCompliance({ callerId: '1600123456' }).warnings.includes('1600_series_is_reserved_for_bfsi_and_government'));
  assert.equal(checkCallCompliance({ callerId: 'x' }).allowed, false);
});

test('typed errors serialise without cause and expose kind', () => {
  const error = new ExotelRateLimitError('slow down', { status: 429, retryAfterMs: 1000, cause: new Error('inner') });
  assert.equal(error.kind, 'retryable');
  const json = error.toJSON();
  assert.equal(json.code, 'rate_limited');
  assert.equal(json.retryAfterMs, 1000);
  assert.equal('cause' in json, false);
});
