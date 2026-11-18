import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyClientState } from '../../../src/integrations/providers/msgraph/index.js';
import { MAILBOX, NOW, WEBHOOK_SECRET, baseConfig, fixture, graphError, makeClient, respond } from './helpers.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SUB_ID = '7f105c7d-2dc5-4530-97cd-4e7ae6534c07';

/** Echo the request back as Graph would, with an id. */
const echoSubscription = (call) => {
  const sent = JSON.parse(call.body);
  return respond(201, { id: SUB_ID, applicationId: baseConfig.clientId, creatorId: 'sp-1', ...sent });
};

test('createSubscription sends a verifiable clientState, both URLs and a bounded expiry', async () => {
  const { client, calls } = makeClient([echoSubscription]);
  const sub = await client.createSubscription({ mailbox: MAILBOX });
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${GRAPH}/subscriptions`);
  assert.equal(call.headers.prefer, 'IdType="ImmutableId"');
  const body = JSON.parse(call.body);
  assert.equal(body.changeType, 'created,updated,deleted');
  assert.equal(body.resource, `users/${MAILBOX}/events`);
  assert.equal(body.notificationUrl, baseConfig.notificationUrl);
  assert.equal(body.lifecycleNotificationUrl, baseConfig.lifecycleNotificationUrl);
  assert.equal(body.latestSupportedTlsVersion, 'v1_2');
  assert.equal(body.expirationDateTime, new Date(NOW + 10_000 * 60_000).toISOString());
  assert.ok(body.clientState.length <= 128);
  assert.ok(verifyClientState(body.clientState, WEBHOOK_SECRET));
  assert.equal(sub.id, SUB_ID);
  assert.deepEqual(sub.changeTypes, ['created', 'updated', 'deleted']);
  assert.equal(sub.expiresAt, body.expirationDateTime);
  assert.equal('clientState' in sub, false, 'clientState is not handed back to callers');
});

test('createSubscription validates its inputs', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(client.createSubscription({ mailbox: MAILBOX, expiresAt: new Date(NOW + 10_081 * 60_000) }), { code: 'invalid_expiry' });
  await assert.rejects(client.createSubscription({}), { code: 'invalid_input' });
  await assert.rejects(client.createSubscription({ mailbox: MAILBOX, changeTypes: ['moved'] }), { code: 'invalid_input' });
  const noUrl = makeClient([], { config: { notificationUrl: undefined } });
  await assert.rejects(noUrl.client.createSubscription({ mailbox: MAILBOX }), { kind: 'config', code: 'missing_notification_url' });
  assert.equal(calls.length + noUrl.calls.length, 0);
});

test('duplicate subscription surfaces the existing id from the 409', async () => {
  const existing = '0c7fd2a9-5d0e-4a8f-9b3c-2f1e6d4c8b7a';
  const { client } = makeClient([
    respond(409, graphError('ExtensionError', `Subscription Id ${existing} already exists for the requested combination`)),
  ]);
  await assert.rejects(client.createSubscription({ mailbox: MAILBOX }), (err) => {
    assert.equal(err.kind, 'conflict');
    assert.equal(err.details.existingSubscriptionId, existing);
    return true;
  });
});

test('failed endpoint validation is a permanent 400', async () => {
  const { client } = makeClient([
    respond(400, graphError('InvalidRequest', 'Subscription validation request failed. Response must exactly match validationToken query parameter.')),
  ]);
  await assert.rejects(client.createSubscription({ mailbox: MAILBOX }), { kind: 'validation', retryable: false });
});

test('renew PATCHes expirationDateTime; reauthorize and delete use the documented routes', async () => {
  const { client, calls } = makeClient([
    (call) => respond(200, { id: SUB_ID, resource: `users/${MAILBOX}/events`, changeType: 'created', ...JSON.parse(call.body) }),
    respond(200),
    respond(204),
    respond(404, graphError('ResourceNotFound', 'gone')),
  ]);
  const renewed = await client.renewSubscription(SUB_ID, { expiresAt: '2026-11-12T00:00:00Z' });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `${GRAPH}/subscriptions/${SUB_ID}`);
  assert.deepEqual(JSON.parse(calls[0].body), { expirationDateTime: '2026-11-12T00:00:00.000Z' });
  assert.equal(renewed.expiresAt, '2026-11-12T00:00:00.000Z');

  assert.deepEqual(await client.reauthorizeSubscription(SUB_ID), { reauthorized: true });
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, `${GRAPH}/subscriptions/${SUB_ID}/reauthorize`);

  assert.deepEqual(await client.deleteSubscription(SUB_ID), { deleted: true, alreadyDeleted: false });
  assert.deepEqual(await client.deleteSubscription(SUB_ID), { deleted: true, alreadyDeleted: true });
  assert.equal(calls[2].method, 'DELETE');
});

test('meeting attendance: join URL -> onlineMeeting -> reports -> records', async () => {
  const data = fixture('attendance.json');
  const joinUrl = data.onlineMeetings.value[0].joinWebUrl;
  const { client, calls } = makeClient([respond(200, data.onlineMeetings), respond(200, data.reports), respond(200, data.records)]);
  const result = await client.getMeetingAttendance(MAILBOX, { joinUrl });

  const filterUrl = new URL(calls[0].url);
  assert.equal(filterUrl.pathname, `/v1.0/users/${MAILBOX}/onlineMeetings`);
  assert.equal(filterUrl.searchParams.get('$filter'), `JoinWebUrl eq '${joinUrl}'`, 'join URL is encoded exactly once');
  assert.ok(calls[0].url.includes('?$filter='), 'the $ of the option name stays literal');
  assert.equal(calls[1].url, `${GRAPH}/users/${MAILBOX}/onlineMeetings/MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZ/attendanceReports`);
  assert.equal(
    calls[2].url,
    `${GRAPH}/users/${MAILBOX}/onlineMeetings/MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZ/attendanceReports/c9b6db1c-d5eb-427d-a5c0-20088d9b22d7/attendanceRecords`,
  );
  assert.equal(calls[0].headers.prefer, undefined, 'calendar Prefer headers are not sent to Teams endpoints');

  assert.equal(result.meeting.id, 'MSpkYzE3Njc0Yy04MWQ5LTRhZGItYmZ');
  const [report] = result.reports;
  assert.equal(report.totalParticipantCount, 2);
  assert.equal(report.meetingStartedAt, '2026-11-10T05:31:23.945Z');
  assert.equal(report.meetingEndedAt, '2026-11-10T06:02:49.770Z');
  const [organizer, guest] = report.records;
  assert.equal(organizer.role, 'Organizer');
  assert.equal(organizer.totalSeconds, 1886);
  assert.equal(guest.email, null, 'guests have an empty emailAddress');
  assert.equal(guest.name, 'Anita Sharma (Guest)');
  assert.deepEqual(guest.intervals, [
    { joinedAt: '2026-11-10T05:35:00.100Z', leftAt: '2026-11-10T05:50:00.200Z', durationSeconds: 900 },
    { joinedAt: '2026-11-10T05:52:00.000Z', leftAt: '2026-11-10T06:02:00.000Z', durationSeconds: 600 },
  ]);
});

test('attendance lookups escape quotes and handle unknown meetings', async () => {
  const { client, calls } = makeClient([respond(200, { value: [] })]);
  const result = await client.getMeetingAttendance(MAILBOX, { joinUrl: "https://teams.microsoft.com/l/meetup-join/it's" });
  assert.deepEqual(result, { meeting: null, reports: [] });
  assert.equal(new URL(calls[0].url).searchParams.get('$filter'), "JoinWebUrl eq 'https://teams.microsoft.com/l/meetup-join/it''s'");
  await assert.rejects(client.getMeetingAttendance(MAILBOX, {}), { code: 'invalid_input' });
});

test('missing application access policy shows up as a permission error', async () => {
  const { client } = makeClient([
    respond(403, graphError('Forbidden', 'No application access policy found for this app.')),
  ]);
  await assert.rejects(client.listAttendanceReports(MAILBOX, 'meeting-1'), { kind: 'permission', retryable: false, status: 403 });
});
