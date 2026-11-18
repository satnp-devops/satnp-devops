import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExotelWebhookError,
  decodePayload,
  normaliseCall,
  parseWebhook,
  toMoney,
  toUtcIso,
} from '../../../src/integrations/providers/exotel/index.js';
import {
  answeredLeg2Callback,
  callDetailsResponse,
  connectAppletQuery,
  defaultCallbackForm,
  passthruAfterConnectQuery,
  passthruIncomingQuery,
  ringingLeg1Callback,
  terminalCallback,
} from './fixtures.js';

test('terminal status callback (JSON) normalises status, duration, legs, recording and ref', () => {
  const [event] = parseWebhook(JSON.stringify(terminalCallback), { contentType: 'application/json' });
  assert.equal(event.provider, 'exotel');
  assert.equal(event.type, 'call.ended');
  assert.equal(event.source, 'status_callback');
  assert.equal(event.eventId, '054cfcd8910389ff64882d8e25211646:terminal');
  assert.equal(event.callId, '054cfcd8910389ff64882d8e25211646');
  assert.equal(event.status, 'completed');
  assert.equal(event.direction, 'outbound');
  assert.equal(event.providerDirection, 'outbound-api');
  assert.equal(event.durationSeconds, 6);
  assert.equal(event.outcome, 'connected');
  assert.equal(event.from, '+917874762218');
  assert.equal(event.to, '+918780296135');
  assert.equal(event.callerId, '+918044556678');
  assert.equal(event.ref, 'lead-42');
  assert.match(event.recordingUrl, /054cfcd8910389ff64882d8e25211646\.mp3$/);
  // IST 10:48:16 is 05:18:16 UTC.
  assert.equal(event.occurredAt, '2022-04-06T05:18:16.000Z');
  assert.equal(event.startedAt, '2022-04-06T05:18:04.000Z');
  assert.equal(event.endedAt, '2022-04-06T05:18:16.000Z');
  assert.deepEqual(
    event.legs.map((l) => [l.index, l.role, l.status, l.onCallDurationSeconds, l.ringingDurationSeconds]),
    [
      [1, 'agent', 'completed', 12, 4],
      [2, 'customer', 'completed', 6, 3],
    ],
  );
});

test('answered and ringing events identify the leg and get distinct, retry-stable ids', () => {
  const [answered] = parseWebhook(answeredLeg2Callback);
  assert.equal(answered.type, 'call.answered');
  assert.equal(answered.status, 'in_progress');
  assert.equal(answered.leg.index, 2);
  assert.equal(answered.leg.role, 'customer');
  assert.equal(answered.eventId, '054cfcd8910389ff64882d8e25211646:answered:leg2');
  assert.equal(answered.endedAt, null, '"null" strings become null');
  assert.equal(answered.durationSeconds, null);

  const [ringing] = parseWebhook(JSON.stringify(ringingLeg1Callback));
  assert.equal(ringing.type, 'call.ringing');
  assert.equal(ringing.status, 'ringing');
  assert.equal(ringing.leg.index, 1);
  assert.equal(ringing.leg.role, 'agent');
  assert.equal(ringing.eventId, '09c14403fb2a31097ba5ed64f9251646:ringing:leg1');

  const [again] = parseWebhook(JSON.stringify(ringingLeg1Callback));
  assert.equal(again.eventId, ringing.eventId, 'a retried delivery dedupes to the same id');
});

test('default form-encoded status callback (no events subscribed) is a terminal event', () => {
  const [event] = parseWebhook(defaultCallbackForm, { contentType: 'application/x-www-form-urlencoded' });
  assert.equal(event.type, 'call.ended');
  assert.equal(event.status, 'no_answer');
  assert.equal(event.recordingUrl, null);
  assert.equal(event.occurredAt, '2026-11-05T12:32:11.000Z');
  assert.equal(event.legs.length, 0);
});

test('multipart/form-data status callback with bracketed Legs', () => {
  const boundary = '----exotelBoundary42';
  const fields = {
    CallSid: 'c0ffee00c0ffee00c0ffee00c0ffee00',
    EventType: 'terminal',
    Status: 'busy',
    Direction: 'outbound-api',
    'Legs[0][Status]': 'completed',
    'Legs[0][OnCallDuration]': '9',
    'Legs[1][Status]': 'busy',
    'Legs[1][OnCallDuration]': '0',
    DateUpdated: '2026-11-05 09:00:00',
  };
  const body =
    Object.entries(fields)
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('') + `--${boundary}--\r\n`;
  const [event] = parseWebhook(Buffer.from(body), { contentType: `multipart/form-data; boundary=${boundary}` });
  assert.equal(event.status, 'busy');
  assert.equal(event.outcome, 'customer_missed');
  assert.deepEqual(
    event.legs.map((l) => [l.role, l.status]),
    [
      ['agent', 'completed'],
      ['customer', 'busy'],
    ],
  );
});

test('agent who never answers is reported as agent_missed', () => {
  const [event] = parseWebhook({
    CallSid: 'abcabcabcabcabcabcabcabcabcabcab',
    EventType: 'terminal',
    Status: 'no-answer',
    Direction: 'outbound-api',
    ConversationDuration: 0,
    Legs: [
      { OnCallDuration: 0, Status: 'no-answer' },
      { OnCallDuration: 0, Status: null },
    ],
  });
  assert.equal(event.outcome, 'agent_missed');
});

test('incoming-call Passthru (GET query) becomes a call.inbound lead with trimmed IVR digits', () => {
  const [event] = parseWebhook('', { query: `${passthruIncomingQuery}&phx_token=abc` });
  assert.equal(event.type, 'call.inbound');
  assert.equal(event.source, 'passthru');
  assert.equal(event.direction, 'inbound');
  assert.equal(event.callId, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(event.from, '+919876543210');
  assert.equal(event.to, '+918044556678');
  assert.equal(event.callerId, '+918044556678');
  assert.equal(event.status, 'ringing');
  assert.equal(event.endedAt, null, 'the 1970-01-01 05:30:00 placeholder is not a real time');
  assert.equal(event.createdAt, '2026-11-05T12:40:03.000Z', 'RFC-2822 style Created is read as IST');
  assert.equal(event.occurredAt, '2026-11-05T12:40:09.000Z');
  assert.equal(event.extra.digits, '2');
  assert.equal(event.extra.flowOutcome, 'call_attempt');
  assert.deepEqual(event.lead, {
    phone: '+919876543210',
    calledNumber: '+918044556678',
    digits: '2',
    receivedAt: '2026-11-05T12:40:09.000Z',
  });
  assert.equal(event.raw.phx_token, undefined, 'our own auth params are stripped from raw');
  assert.match(event.eventId, /^a1b2c3d4e5f60718293a4b5c6d7e8f90:passthru:[0-9a-f]{16}$/);
  const [retry] = parseWebhook('', { query: passthruIncomingQuery.replace('18%3A10%3A09', '18%3A10%3A15') });
  assert.equal(retry.eventId, event.eventId, 'CurrentTime does not change the event id');
});

test('Passthru after a Connect applet parses bracketed Legs, recording and CustomField', () => {
  const [event] = parseWebhook(passthruAfterConnectQuery, { contentType: 'application/x-www-form-urlencoded' });
  assert.equal(event.type, 'call.flow_step');
  assert.equal(event.direction, 'outbound');
  assert.equal(event.callerId, '+918044556678');
  assert.equal(event.durationSeconds, 48);
  assert.equal(event.ref, 'lead-77');
  assert.equal(event.extra.dialCallStatus, 'completed');
  assert.equal(event.extra.agentNumber, '+919123456789');
  assert.equal(event.lead, null);
  assert.deepEqual(event.legs[0], {
    index: 1,
    role: null,
    status: null,
    onCallDurationSeconds: 21,
    ringingDurationSeconds: null,
    answeredBy: null,
    number: '+917200498123',
    causeCode: 'NORMAL_CLEARING',
    cause: 16,
  });
});

test('Connect applet agent pass-through becomes call.agent_leg', () => {
  const [event] = parseWebhook('', { query: connectAppletQuery });
  assert.equal(event.type, 'call.agent_leg');
  assert.equal(event.source, 'connect_applet');
  assert.equal(event.extra.agentEvent, 'dial');
  assert.equal(event.extra.agentBusy, true);
  assert.equal(event.extra.agentNumber, '+919123456789');
  assert.match(event.eventId, /:agent_dial:[0-9a-f]{16}$/);
});

test('express-parsed objects with bracketed keys are expanded too', () => {
  const [event] = parseWebhook({ CallSid: 'x1x2x3x4x5x6', Status: 'completed', 'Legs[0][Status]': 'completed' });
  assert.equal(event.legs[0].status, 'completed');
});

test('rejects payloads without CallSid, invalid JSON, and blocks prototype pollution', () => {
  assert.throws(() => parseWebhook({ Status: 'completed' }), ExotelWebhookError);
  assert.throws(() => parseWebhook('{"CallSid":', { contentType: 'application/json' }), ExotelWebhookError);
  assert.throws(() => parseWebhook({ CallSid: 'abc123abc123' }), ExotelWebhookError);
  const decoded = decodePayload('CallSid=1&__proto__[polluted]=yes&a[constructor][prototype][x]=1&Legs[99999999][x]=1');
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.equal(decoded.Legs, undefined);
});

test('time and money helpers', () => {
  assert.equal(toUtcIso('2026-11-05 00:10:00', '+05:30'), '2026-11-04T18:40:00.000Z');
  assert.equal(toUtcIso('2026-11-05T10:30:00+05:30', '+00:00'), '2026-11-05T05:00:00.000Z');
  assert.equal(toUtcIso('1970-01-01 05:30:00', '+05:30'), null);
  assert.equal(toUtcIso('0000-00-00 00:00:00', '+05:30'), null);
  assert.equal(toUtcIso('garbage', '+05:30'), null);
  assert.deepEqual(toMoney('1.875', 'INR'), { amountMinor: 188, currency: 'INR' });
  assert.deepEqual(toMoney('0.5', 'INR'), { amountMinor: 50, currency: 'INR' });
  assert.deepEqual(toMoney('12', 'INR'), { amountMinor: 1200, currency: 'INR' });
  assert.equal(toMoney(null, 'INR'), null);
  assert.equal(toMoney('abc', 'INR'), null);
});

test('normaliseCall maps Call Details (details=true) including price in minor units', () => {
  const call = normaliseCall(callDetailsResponse.Call, { timeZoneOffset: '+05:30', currency: 'INR' });
  assert.equal(call.callId, 'b6cfaf5f5cef3ca0fc937749ef96d245');
  assert.equal(call.status, 'completed');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.totalDurationSeconds, 335);
  assert.equal(call.talkDurationSeconds, 320);
  assert.deepEqual(call.price, { amountMinor: 188, currency: 'INR' });
  assert.equal(call.endedAt, '2026-11-05T09:00:45.000Z');
  assert.equal(call.ref, 'lead-42');
  assert.equal(call.outcome, 'connected');
  assert.deepEqual(
    call.legs.map((l) => [l.index, l.role, l.status, l.onCallDurationSeconds]),
    [
      [1, 'agent', 'completed', 335],
      [2, 'customer', 'completed', 320],
    ],
  );
});
