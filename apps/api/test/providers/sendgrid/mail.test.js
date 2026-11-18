import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailSendBody, parseSendgridConfig, SendgridError } from '../../../src/integrations/providers/sendgrid/index.js';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const config = parseSendgridConfig({
  apiKey: 'SG.fakeKeyId_0123456789.fakeSecret_abcdefghijklmnop',
  defaultFrom: { email: 'admissions@phoenix.example', name: 'Phoenix Admissions' },
  defaultReplyTo: { email: 'help@phoenix.example' },
  asmGroupId: 4242,
  defaultCategories: ['phoenix'],
  ipPoolName: 'transactional',
});
const build = (/** @type {any} */ message, cfg = config) => buildMailSendBody(message, cfg, { now: () => NOW });

/** @param {() => unknown} fn @returns {Array<{ path: string, message: string }>} */
function issuesOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SendgridError);
    assert.equal(error.code, 'validation');
    assert.equal(error.retryable, false);
    return error.issues;
  }
  assert.fail('expected a validation error');
}

test('dynamic template send with categories, custom args, reply-to and config defaults', () => {
  const { body, recipients, sandbox } = build({
    messageId: 'msg_01HZX',
    to: ['parent@example.in', { email: 'guardian@example.in', name: 'Rahul Sharma' }],
    cc: 'counsellor@phoenix.example',
    templateId: 'd-f43daeeaef504760851f727007e0b5d0',
    templateData: { studentName: 'Aarav', visitAt: '2026-11-07T04:30:00.000Z', fee: { amountMinor: 1250000, currency: 'INR' } },
    categories: ['admissions', 'visit-reminder'],
    customArgs: { company_id: 'cmp_9', lead_id: 'lead_77' },
  });
  assert.equal(recipients, 3);
  assert.equal(sandbox, false);
  assert.deepEqual(body, {
    personalizations: [
      {
        to: [{ email: 'parent@example.in' }, { email: 'guardian@example.in', name: 'Rahul Sharma' }],
        cc: [{ email: 'counsellor@phoenix.example' }],
        dynamic_template_data: { studentName: 'Aarav', visitAt: '2026-11-07T04:30:00.000Z', fee: { amountMinor: 1250000, currency: 'INR' } },
        custom_args: { company_id: 'cmp_9', lead_id: 'lead_77', phoenix_message_id: 'msg_01HZX' },
      },
    ],
    from: { email: 'admissions@phoenix.example', name: 'Phoenix Admissions' },
    reply_to: { email: 'help@phoenix.example' },
    template_id: 'd-f43daeeaef504760851f727007e0b5d0',
    categories: ['phoenix', 'admissions', 'visit-reminder'],
    ip_pool_name: 'transactional',
  });
});

test('personalizations carry per-recipient message ids, data, unsubscribe headers and send_at', () => {
  const sendAt = new Date(NOW + 3600_000);
  const { body } = build({
    messageId: 'batch_1',
    templateId: 'd-0123456789abcdef0123456789abcdef',
    templateData: { term: '2027' },
    personalizations: [
      { messageId: 'out_1', to: 'a@example.in', templateData: { name: 'A' }, unsubscribe: { url: 'https://crm.phoenix.example/u/tok1' } },
      { messageId: 'out_2', to: 'b@example.in', templateData: { name: 'B', term: '2028' }, sendAt },
    ],
    asm: { groupsToDisplay: [4242, 4343] },
    replyToList: ['x@phoenix.example', { email: 'y@phoenix.example', name: 'Y' }],
  });
  assert.equal(body.personalizations.length, 2);
  assert.deepEqual(body.personalizations[0], {
    to: [{ email: 'a@example.in' }],
    dynamic_template_data: { term: '2027', name: 'A' },
    custom_args: { phoenix_message_id: 'out_1' },
    headers: { 'List-Unsubscribe': '<https://crm.phoenix.example/u/tok1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  assert.deepEqual(body.personalizations[1], {
    to: [{ email: 'b@example.in' }],
    dynamic_template_data: { term: '2028', name: 'B' },
    custom_args: { phoenix_message_id: 'out_2' },
    send_at: Math.floor(sendAt.getTime() / 1000),
  });
  assert.deepEqual(body.asm, { group_id: 4242, groups_to_display: [4242, 4343] });
  assert.deepEqual(body.reply_to_list, [{ email: 'x@phoenix.example' }, { email: 'y@phoenix.example', name: 'Y' }]);
  assert.equal(body.reply_to, undefined);
  assert.deepEqual(body.tracking_settings, { subscription_tracking: { enable: false } });
});

test('attachments: Buffers are base64-encoded, base64 strings pass through, inline needs content id', () => {
  const pdf = Buffer.from('%PDF-1.7 fee receipt');
  const { body } = build({
    messageId: 'm1',
    to: 'parent@example.in',
    subject: 'Fee receipt',
    html: '<p>Receipt attached <img src="cid:logo"></p>',
    text: 'Receipt attached',
    attachments: [
      { filename: 'receipt.pdf', content: pdf, contentType: 'application/pdf' },
      { filename: 'logo.png', content: 'iVBORw0KGgo=', contentType: 'image/png', disposition: 'inline', contentId: 'logo' },
    ],
  });
  assert.deepEqual(body.content, [
    { type: 'text/plain', value: 'Receipt attached' },
    { type: 'text/html', value: '<p>Receipt attached <img src="cid:logo"></p>' },
  ]);
  assert.deepEqual(body.attachments, [
    { content: pdf.toString('base64'), filename: 'receipt.pdf', disposition: 'attachment', type: 'application/pdf' },
    { content: 'iVBORw0KGgo=', filename: 'logo.png', disposition: 'inline', type: 'image/png', content_id: 'logo' },
  ]);
  const issues = issuesOf(() =>
    build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', attachments: [{ filename: 'x.png', content: 'not base64!', disposition: 'inline' }] }),
  );
  assert.deepEqual(issues.map((i) => i.path).sort(), ['attachments.0.content', 'attachments.0.contentId']);
});

test('sandbox, tracking and explicit subscription tracking', () => {
  const { body, sandbox } = build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', sandbox: true, tracking: { opens: false, clicks: false, subscription: true } });
  assert.equal(sandbox, true);
  assert.deepEqual(body.mail_settings, { sandbox_mode: { enable: true } });
  assert.deepEqual(body.tracking_settings, {
    open_tracking: { enable: false },
    click_tracking: { enable: false, enable_text: false },
    subscription_tracking: { enable: true },
  });
});

test('SendGrid limits are enforced locally', () => {
  const many = Array.from({ length: 1001 }, (_, i) => `r${i}@example.in`);
  assert.ok(issuesOf(() => build({ messageId: 'm', to: many, subject: 's', text: 't' })).some((i) => /1000 recipients/.test(i.message)));

  const cats = Array.from({ length: 10 }, (_, i) => `c${i}`); // plus the default 'phoenix' = 11
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', categories: cats })).some((i) => i.path === 'categories'));
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', categories: ['प्रवेश'] })).some((i) => /ASCII/.test(i.message)));

  const big = { blob: 'x'.repeat(10_000) };
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', customArgs: big })).some((i) => i.path === 'customArgs'));

  const late = new Date(NOW + 73 * 3600_000).toISOString();
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', sendAt: late })).some((i) => /72 hours/.test(i.message)));

  const dup = issuesOf(() => build({ messageId: 'm', to: 'a@b.in', bcc: 'A@B.in', subject: 's', text: 't' }));
  assert.ok(dup.some((i) => /more than once/.test(i.message)));

  const huge = Buffer.alloc(23 * 1024 * 1024); // ~30.7 MB once base64-encoded
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', attachments: [{ filename: 'big.bin', content: huge }] })).some((i) => /30 MB/.test(i.message)));
});

test('headers: reserved names, line breaks and bad names are rejected', () => {
  const issues = issuesOf(() =>
    build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', headers: { 'Reply-To': 'x@y.z', 'X-Bad Name': '1', 'X-Inject': 'a\r\nBcc: evil@x.com', 'X-Campaign': 'ok' } }),
  );
  assert.deepEqual(issues.map((i) => i.path).sort(), ['headers.Reply-To', 'headers.X-Bad Name', 'headers.X-Inject']);
  const { body } = build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', headers: { 'X-Campaign': 'diwali-2026' } });
  assert.deepEqual(body.headers, { 'X-Campaign': 'diwali-2026' });
});

test('message shape errors: both to and personalizations, missing content, our id reserved', () => {
  const shape = issuesOf(() => build({ messageId: 'm', to: 'a@b.in', personalizations: [{ to: 'c@d.in' }], subject: 's', text: 't' }));
  assert.ok(shape.some((i) => /either to/.test(i.message)));
  const content = issuesOf(() => build({ messageId: 'm', to: 'a@b.in' }));
  assert.deepEqual(content.map((i) => i.path).sort(), ['subject', 'text']);
  const reserved = issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', customArgs: { phoenix_message_id: 'other' } }));
  assert.ok(reserved.some((i) => i.path === 'customArgs.phoenix_message_id'));
  const schema = issuesOf(() => build({ messageId: '', to: 'not-an-email', subject: 's', text: 't', bogus: true }));
  assert.ok(schema.length >= 2);
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', templateId: '13b8f94f-bcae-4ec6-b752-70d6cb59f932' })).some((i) => i.path === 'templateId'));
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', unsubscribe: { url: 'http://insecure.example/u' } })).some((i) => i.path === 'unsubscribe'));
  assert.ok(issuesOf(() => build({ messageId: 'm', to: 'a@b.in', subject: 's', text: 't', asm: {} }, parseSendgridConfig({ apiKey: 'SG.aaaaaaaaaa.bbbbbbbbbb', defaultFrom: { email: 'a@b.in' } }))).some((i) => i.path === 'asm.groupId'));
});
