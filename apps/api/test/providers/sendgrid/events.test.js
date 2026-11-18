import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook, SendgridError } from '../../../src/integrations/providers/sendgrid/index.js';

// Event shapes from SendGrid's Event Webhook reference, with our custom arg added the way
// SendGrid posts custom_args (as top-level keys).
const MID = '14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0';
const payload = [
  { email: 'alex@example.com', timestamp: 1513299569, 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', event: 'delivered', category: 'cat facts', sg_event_id: 'rWVYmVk90MjZJ9iohOBa3w==', sg_message_id: MID, response: '250 OK', phoenix_message_id: 'msg_1', company_id: 'cmp_9' },
  { email: 'alex@example.com', timestamp: 1513299569, event: 'open', sg_machine_open: false, category: 'cat facts', sg_event_id: 'FOTFFO0ecsBE-zxFXfs6WA==', sg_message_id: MID, useragent: 'Mozilla/4.0 (compatible; MSIE 6.1; Windows XP)', ip: '255.255.255.255', phoenix_message_id: 'msg_1' },
  { sg_event_id: 'sendgrid_internal_event_id', sg_message_id: 'sendgrid_internal_message_id', ip: '255.255.255.255', useragent: 'Mozilla/5.0 (iPhone)', event: 'click', email: 'email@example.com', timestamp: 1249948800, url: 'http://example.com/blog/news.html', url_offset: { index: 0, type: 'html' }, unique_arg_key: 'unique_arg_value', category: ['category1', 'category2'], newsletter: { newsletter_user_list_id: '10557865', newsletter_id: '1943530', newsletter_send_id: '2308608' }, asm_group_id: 1 },
  { email: 'alex@example.com', timestamp: 1513299569, 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', bounce_classification: 'Invalid Address', event: 'bounce', category: 'cat facts', sg_event_id: '6g4ZI7SA-xmRDv57GoPIPw==', sg_message_id: MID, reason: '500 unknown recipient', status: '5.0.0', type: 'bounce' },
  { email: 'alex@example.com', timestamp: 1513299569, bounce_classification: 'Technical', event: 'bounce', sg_event_id: 'blk-1', sg_message_id: MID, reason: '421 try later', status: '4.0.0', type: 'blocked' },
  { email: 'alex@example.com', timestamp: 1513299569, 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', event: 'dropped', category: 'cat facts', sg_event_id: 'zmzJhfJgAfUSOW80yEbPyw==', sg_message_id: MID, reason: 'Bounced Address', status: '5.0.0' },
  { email: 'alex@example.com', timestamp: 1513299569, 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', event: 'spamreport', sg_event_id: '37nvH5QBz858KGVYCM4uOA==', sg_message_id: MID },
  { email: 'alex@example.com', timestamp: 1513299569, event: 'unsubscribe', category: 'cat facts', sg_event_id: 'zz_BjPgU_5pS-J8vlfB1sg==', sg_message_id: MID },
  { email: 'alex@example.com', domain: 'example.com', from: 'test@example.com', timestamp: 1513299569, event: 'deferred', category: 'cat facts', sg_event_id: 't7LEShmowp86DTdUW8M-GQ==', sg_message_id: ' 14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0', response: '400 try again later', attempt: '5' },
  { email: 'alex@example.com', timestamp: 1513299569, event: 'group_unsubscribe', sg_event_id: 'ahSCB7xYcXFb-hEaawsPRw==', sg_message_id: MID, useragent: 'Mozilla/4.0', ip: '255.255.255.255', url: 'http://www.example.com/', asm_group_id: 10 },
  { event: 'account_status_change', sg_event_id: 'MjEzNTg5OTcyOC10ZXJtaW5hdGUtMTcwNzg1MTUzMQ', timestamp: 1709142428, type: 'compliance_suspend' },
];

test('parses every documented event type from the raw body', () => {
  const events = parseWebhook(Buffer.from(JSON.stringify(payload) + '\r\n'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['delivered', 'opened', 'clicked', 'bounced', 'bounced', 'dropped', 'spam_reported', 'unsubscribed', 'deferred', 'group_unsubscribed', 'account_status_changed'],
  );
  assert.deepEqual(events.map((e) => e.providerEventId).slice(0, 2), ['rWVYmVk90MjZJ9iohOBa3w==', 'FOTFFO0ecsBE-zxFXfs6WA==']);
});

test('delivered event: ids, our message id, custom args, UTC time', () => {
  const [delivered] = parseWebhook(JSON.stringify(payload));
  assert.equal(delivered.provider, 'sendgrid');
  assert.equal(delivered.messageId, 'msg_1');
  assert.equal(delivered.providerMessageId, MID);
  assert.equal(delivered.xMessageId, '14c5d75ce93');
  assert.equal(delivered.occurredAt, '2017-12-15T00:59:29.000Z');
  assert.deepEqual(delivered.categories, ['cat facts']);
  assert.deepEqual(delivered.customArgs, { phoenix_message_id: 'msg_1', company_id: 'cmp_9' });
  assert.equal(delivered.response, '250 OK');
  assert.equal(delivered.suppressRecipient, false);
  assert.equal(delivered.syntheticId, false);
  assert.equal(delivered.raw.event, 'delivered');
});

test('engagement events keep url, user agent, ip, machine-open flag and group id', () => {
  const events = parseWebhook(payload);
  const open = events[1];
  assert.equal(open.machineOpen, false);
  assert.equal(open.ip, '255.255.255.255');
  const click = events[2];
  assert.equal(click.url, 'http://example.com/blog/news.html');
  assert.deepEqual(click.categories, ['category1', 'category2']);
  assert.deepEqual(click.customArgs, { unique_arg_key: 'unique_arg_value' });
  assert.equal(click.messageId, null);
  assert.equal(click.asmGroupId, 1);
  assert.equal(events[9].asmGroupId, 10);
  assert.equal(events[9].suppressRecipient, true);
});

test('bounce vs blocked, dropped, spam report and unsubscribe drive suppression', () => {
  const events = parseWebhook(payload);
  assert.deepEqual(events[3].bounce, { kind: 'hard', classification: 'Invalid Address', reason: '500 unknown recipient', status: '5.0.0' });
  assert.equal(events[3].suppressRecipient, true);
  assert.equal(events[4].bounce?.kind, 'soft');
  assert.equal(events[4].suppressRecipient, false);
  assert.equal(events[5].reason, 'Bounced Address');
  assert.equal(events[5].suppressRecipient, true);
  assert.equal(events[6].suppressRecipient, true);
  assert.equal(events[7].suppressRecipient, true);
});

test('deferred: trims the leading space in sg_message_id and reads attempt as a number', () => {
  const deferred = parseWebhook(payload)[8];
  assert.equal(deferred.providerMessageId, MID);
  assert.equal(deferred.attempt, 5);
  assert.deepEqual(deferred.customArgs, {}); // domain/from are documented fields, not custom args
});

test('account status change keeps the status', () => {
  const status = parseWebhook(payload)[10];
  assert.equal(status.accountStatus, 'compliance_suspend');
  assert.equal(status.email, null);
  assert.equal(status.providerMessageId, null);
});

test('events without sg_event_id get a stable synthetic id; unknown events are kept', () => {
  const curlTest = [
    { email: 'alex@example.com', timestamp: 1337197600, 'smtp-id': '<4FB4041F.6080505@example.com>', event: 'processed' },
    { email: 'alex@example.com', timestamp: 1337966815, category: 'newuser', event: 'click', url: 'https://example.com' },
    { event: 'brand_new_event', sg_event_id: 'x1' },
  ];
  const a = parseWebhook(curlTest);
  const reordered = parseWebhook([{ event: 'processed', 'smtp-id': '<4FB4041F.6080505@example.com>', timestamp: 1337197600, email: 'alex@example.com' }]);
  assert.match(a[0].providerEventId, /^synthetic:[0-9a-f]{64}$/);
  assert.equal(a[0].syntheticId, true);
  assert.equal(a[0].providerEventId, reordered[0].providerEventId);
  assert.notEqual(a[0].providerEventId, a[1].providerEventId);
  assert.equal(a[2].type, 'unknown');
  assert.equal(a[2].providerType, 'brand_new_event');
});

test('unique_args objects are read as custom args and the message id key is configurable', () => {
  const [event] = parseWebhook([{ event: 'delivered', sg_event_id: 'e', unique_args: { crm_id: 'm9' } }], { messageIdArg: 'crm_id' });
  assert.equal(event.messageId, 'm9');
});

test('invalid bodies raise a permanent invalid_payload error', () => {
  for (const body of ['not json', '{"event":"open"}']) {
    assert.throws(() => parseWebhook(body), (e) => e instanceof SendgridError && e.code === 'invalid_payload' && e.retryable === false);
  }
  assert.deepEqual(parseWebhook('[null, 1, "x"]'), []);
});
