import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  createSendgridClient,
  parseInboundEmail,
  parseAddressList,
  decodeEncodedWords,
  addressTag,
  SendgridError,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../../../src/integrations/providers/sendgrid/index.js';

const BOUNDARY = '001a11447dc881e40b0537fe6d58';

/**
 * Build a multipart/form-data body the way Inbound Parse posts it (CRLF line endings).
 * @param {Array<{ name: string, value: string|Buffer, filename?: string, type?: string }>} parts
 */
function formBody(parts, boundary = BOUNDARY) {
  const chunks = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.type) head += `Content-Type: ${part.type}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`, 'utf8'), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// Binary content that contains CRLF and a near-boundary sequence, to prove the parser is byte-safe.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`\r\n--${BOUNDARY.slice(0, 10)}\r\n`), Buffer.from([0, 255, 13, 10, 0])]);
const PDF = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nfee structure', 'latin1');

const HEADERS = [
  'Received: by mx0047p1mdw1.sendgrid.net with SMTP id n02SRiHsLZ Tue, 27 Jul 2021 15:53:29 +0000 (UTC)',
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20210112;',
  '        h=mime-version:from:date:message-id:subject:to;',
  'MIME-Version: 1.0',
  'From: "Sharma, Priya" <priya.sharma@example.in>',
  'Date: Tue, 27 Jul 2021 15:53:29 +0000',
  'Message-ID: <CABQbZKGSEWPBtYVn3W_JUb70n-Oe=fykq@mail.gmail.com>',
  'In-Reply-To: <out_01HZX@phoenix.example>',
  'References: <thread-root@phoenix.example> <out_01HZX@phoenix.example>',
  'Reply-To: Priya <priya.reply@example.in>',
  'Subject: Re: Admission visit',
  'To: admissions+t_lead77@in.phoenix.example',
  'Content-Type: multipart/mixed; boundary="000000000000abcdef05c8c1c2d3"',
].join('\n');

const parsedParts = [
  { name: 'headers', value: HEADERS },
  { name: 'dkim', value: '{@gmail.com : pass}' },
  { name: 'content-ids', value: '{"ii_1562e2169c132d83":"attachment1"}' },
  { name: 'to', value: 'admissions+t_lead77@in.phoenix.example' },
  { name: 'cc', value: 'Rahul <rahul@example.in>, counsellor@phoenix.example' },
  { name: 'from', value: '"Sharma, Priya" <priya.sharma@example.in>' },
  { name: 'subject', value: 'Re: Admission visit' },
  { name: 'text', value: Buffer.from('Merci, à demain', 'latin1') },
  { name: 'html', value: '<div dir="ltr">Thanks, see you <b>tomorrow</b><img src="cid:ii_1562e2169c132d83"></div>' },
  { name: 'sender_ip', value: '209.85.223.169' },
  { name: 'envelope', value: '{"to":["admissions+t_lead77@in.phoenix.example"],"from":"priya.sharma@example.in"}' },
  { name: 'attachments', value: '2' },
  { name: 'charsets', value: '{"to":"UTF-8","from":"UTF-8","subject":"UTF-8","text":"iso-8859-1","html":"UTF-8"}' },
  { name: 'SPF', value: 'pass' },
  { name: 'spam_score', value: '0.011' },
  { name: 'spam_report', value: 'Spam detection software has NOT identified this incoming email as spam.' },
  {
    name: 'attachment-info',
    value: '{"attachment1":{"filename":"image.png","name":"image.png","type":"image/png","content-id":"ii_1562e2169c132d83"},"attachment2":{"filename":"fees.pdf","name":"fees.pdf","type":"application/pdf"}}',
  },
  { name: 'attachment1', value: PNG, filename: 'image.png', type: 'image/png' },
  { name: 'attachment2', value: PDF, filename: 'fees.pdf', type: 'application/pdf' },
];

test('parsed mode: addresses, threading headers, charsets, spam data and binary attachments', () => {
  const body = formBody(parsedParts);
  const email = parseInboundEmail(body, { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` });
  assert.equal(email.mode, 'parsed');
  assert.deepEqual(email.from, { email: 'priya.sharma@example.in', name: 'Sharma, Priya' });
  assert.deepEqual(email.to, [{ email: 'admissions+t_lead77@in.phoenix.example', name: null }]);
  assert.deepEqual(email.cc, [{ email: 'rahul@example.in', name: 'Rahul' }, { email: 'counsellor@phoenix.example', name: null }]);
  assert.deepEqual(email.replyTo, [{ email: 'priya.reply@example.in', name: 'Priya' }]);
  assert.equal(email.subject, 'Re: Admission visit');
  assert.equal(email.text, 'Merci, à demain');
  assert.match(email.html ?? '', /tomorrow/);
  assert.equal(email.messageIdHeader, '<CABQbZKGSEWPBtYVn3W_JUb70n-Oe=fykq@mail.gmail.com>');
  assert.equal(email.dedupeKey, 'message-id:<CABQbZKGSEWPBtYVn3W_JUb70n-Oe=fykq@mail.gmail.com>');
  assert.equal(email.inReplyTo, '<out_01HZX@phoenix.example>');
  assert.deepEqual(email.references, ['<thread-root@phoenix.example>', '<out_01HZX@phoenix.example>']);
  assert.equal(email.date, '2021-07-27T15:53:29.000Z');
  assert.deepEqual(email.envelope, { from: 'priya.sharma@example.in', to: ['admissions+t_lead77@in.phoenix.example'] });
  assert.deepEqual(email.recipientTags, ['t_lead77']);
  assert.equal(email.headers['dkim-signature'], 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20210112; h=mime-version:from:date:message-id:subject:to;');
  assert.deepEqual(email.spam, { score: 0.011, report: 'Spam detection software has NOT identified this incoming email as spam.' });
  assert.equal(email.spf, 'pass');
  assert.equal(email.dkim, '{@gmail.com : pass}');
  assert.equal(email.senderIp, '209.85.223.169');
  assert.equal(email.attachments.length, 2);
  const [image, pdf] = email.attachments;
  assert.deepEqual({ ...image, content: undefined }, { filename: 'image.png', contentType: 'image/png', contentId: 'ii_1562e2169c132d83', disposition: 'inline', size: PNG.length, content: undefined });
  assert.ok(image.content.equals(PNG));
  assert.equal(pdf.disposition, 'attachment');
  assert.equal(pdf.contentId, null);
  assert.ok(pdf.content.equals(PDF));
});

const RAW_MIME = [
  'From: =?UTF-8?B?4KSq4KWN4KSw4KS/4KSv4KS+?= <priya@example.in>',
  'To: admissions@in.phoenix.example',
  'Subject: =?UTF-8?Q?Fees_for_Class_=E0=A5=AB?= =?UTF-8?Q?_query?=',
  'Message-ID: <raw-1@mail.example.in>',
  'Date: Wed, 05 Nov 2026 15:30:00 +0530',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mixed"',
  '',
  '--mixed',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Namaste, what are the fees for Class 5? =E2=82=B9 amount=',
  ' please.',
  '--alt',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<p>Namaste, fees for Class 5?</p>').toString('base64'),
  '--alt--',
  '--mixed',
  'Content-Type: application/pdf; name="marksheet.pdf"',
  'Content-Disposition: attachment; filename="marksheet.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  PDF.toString('base64'),
  '--mixed--',
  '',
].join('\r\n');

test('raw mode: walks the MIME message and decodes encoded words, QP and base64', () => {
  const body = formBody(
    [
      { name: 'dkim', value: '{@example.in : pass}' },
      { name: 'email', value: RAW_MIME },
      { name: 'to', value: 'admissions@in.phoenix.example' },
      { name: 'from', value: 'प्रिया <priya@example.in>' },
      { name: 'subject', value: 'Fees for Class ५ query' },
      { name: 'envelope', value: '{"to":["admissions@in.phoenix.example"],"from":"priya@example.in"}' },
      { name: 'charsets', value: '{"to":"UTF-8","from":"UTF-8","subject":"UTF-8"}' },
      { name: 'SPF', value: 'pass' },
    ],
    'xYzZY',
  );
  const email = parseInboundEmail(body, 'multipart/form-data; boundary=xYzZY');
  assert.equal(email.mode, 'raw');
  assert.deepEqual(email.from, { email: 'priya@example.in', name: 'प्रिया' });
  assert.equal(email.subject, 'Fees for Class ५ query');
  assert.equal(email.text, 'Namaste, what are the fees for Class 5? ₹ amount please.');
  assert.equal(email.html, '<p>Namaste, fees for Class 5?</p>');
  assert.equal(email.messageIdHeader, '<raw-1@mail.example.in>');
  assert.equal(email.date, '2026-11-05T10:00:00.000Z');
  assert.equal(email.attachments.length, 1);
  assert.equal(email.attachments[0].filename, 'marksheet.pdf');
  assert.ok(email.attachments[0].content.equals(PDF));
});

test('signed Inbound Parse: signature is checked on the raw multipart bytes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const client = createSendgridClient({ apiKey: 'SG.aaaaaaaaaa.bbbbbbbbbb', defaultFrom: { email: 'a@phoenix.example' }, inboundParsePublicKey: key });
  const body = formBody(parsedParts);
  const ts = '1762335000';
  const headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    [SIGNATURE_HEADER]: sign('sha256', Buffer.concat([Buffer.from(ts), body]), privateKey).toString('base64'),
    [TIMESTAMP_HEADER]: ts,
  };
  assert.equal(client.verifyInbound(body, headers).ok, true);
  const tampered = Buffer.from(body);
  tampered[tampered.indexOf('fee structure')] ^= 1;
  assert.equal(client.verifyInbound(tampered, headers).ok, false);
  assert.equal(client.parseInbound(body, headers).from?.email, 'priya.sharma@example.in');
});

test('messages without Message-ID dedupe on a body hash; LF-only bodies parse', () => {
  const body = Buffer.from(formBody([{ name: 'from', value: 'a@b.in' }, { name: 'subject', value: 'hi' }]).toString('utf8').replace(/\r\n/g, '\n'));
  const email = parseInboundEmail(body, `multipart/form-data; boundary="${BOUNDARY}"`);
  assert.match(email.dedupeKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(email.subject, 'hi');
  assert.equal(email.text, null);
  assert.deepEqual(email.attachments, []);
});

test('malformed or oversized bodies are permanent invalid_payload errors', () => {
  const check = (/** @type {() => unknown} */ fn) => assert.throws(fn, (e) => e instanceof SendgridError && e.code === 'invalid_payload' && !e.retryable);
  check(() => parseInboundEmail(Buffer.from('from=a'), 'application/x-www-form-urlencoded'));
  check(() => parseInboundEmail(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nno end`), `multipart/form-data; boundary=${BOUNDARY}`));
  check(() => parseInboundEmail(/** @type {any} */ ('string body'), `multipart/form-data; boundary=${BOUNDARY}`));
  check(() => parseInboundEmail(formBody(parsedParts), `multipart/form-data; boundary=${BOUNDARY}`, { maxBytes: 100 }));
});

test('address and header helpers', () => {
  assert.deepEqual(parseAddressList('"Iyer, K." <k.iyer@example.in>, plain@example.com, Team: a@x.in, b@y.in;, bogus'), [
    { email: 'k.iyer@example.in', name: 'Iyer, K.' },
    { email: 'plain@example.com', name: null },
    { email: 'a@x.in', name: null },
    { email: 'b@y.in', name: null },
  ]);
  assert.equal(decodeEncodedWords('=?ISO-8859-1?Q?Andr=E9?= Pirard'), 'André Pirard');
  assert.equal(decodeEncodedWords('=?UTF-8?B?4KSo4KSu4KS44KWN4KSk4KWH?='), 'नमस्ते');
  assert.equal(addressTag('reply+abc_123@in.phoenix.example'), 'abc_123');
  assert.equal(addressTag('reply@in.phoenix.example'), null);
});
