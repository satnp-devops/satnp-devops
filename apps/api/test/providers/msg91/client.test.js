import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsg91Client, Msg91Error, Msg91ValidationError, Msg91ConfigError } from '../../../src/integrations/providers/msg91/index.js';
import { AUTH_KEY, NOON_IST, baseConfig, captureLogger, connectionRefused, fakeFetch, noSleep } from './helpers.js';

const reminder = {
  template: 'admission.counselling_reminder',
  to: '+91 98765-43210',
  variables: { name: 'Asha', date: '12 Nov 4pm', link: 'https://phoenix.edu.in/apply?id=42' },
  reference: '4f9c1e2a-0b7d-4c3e-9a51-2d6f8e7b1c90',
};

function client(responses, { config = {}, now = NOON_IST } = {}) {
  const fake = fakeFetch(responses);
  const { logger, entries } = captureLogger();
  const sms = createMsg91Client(baseConfig(config), { fetch: fake.fetch, now: () => now, logger, sleep: noSleep, random: () => 0.5 });
  return { sms, fake, entries };
}

const ok = (message = '5e1e93cad6fc054d8e759a5b') => ({ status: 200, body: { message, type: 'success' } });

// ---------------------------------------------------------------------------------------------
// Template send: request shape
// ---------------------------------------------------------------------------------------------

test('sendTemplate posts the Flow API request with authkey header, template id, mobiles, variables and CRQID', async () => {
  const { sms, fake } = client([ok()]);
  const result = await sms.sendTemplate(reminder);

  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.href, 'https://control.msg91.com/api/v5/flow');
  assert.deepEqual(call.headers, { authkey: AUTH_KEY, accept: 'application/json', 'content-type': 'application/json' });
  assert.deepEqual(call.body, {
    template_id: '669a29fbd6fc053066739b42',
    sender: 'PHXEDU',
    recipients: [
      { mobiles: '919876543210', name: 'Asha', date: '12 Nov 4pm', link: 'https://phoenix.edu.in/apply?id=42', CRQID: '4f9c1e2a0b7d4c3e9a512d6f8e7b1c90' },
    ],
  });
  assert.ok(call.signal instanceof AbortSignal, 'every request carries a timeout signal');

  assert.equal(result.requestId, '5e1e93cad6fc054d8e759a5b');
  assert.equal(result.status, 'accepted');
  assert.equal(result.dltTemplateId, '1307160975559044358');
  assert.deepEqual(result.recipients, [
    { to: '919876543210', reference: '4f9c1e2a0b7d4c3e9a512d6f8e7b1c90', providerMessageId: '5e1e93cad6fc054d8e759a5b:919876543210' },
  ]);
  assert.equal(result.estimate.segments, 1);
});

test('bulk send: per-recipient variables override shared ones and each gets its own CRQID', async () => {
  const { sms, fake } = client([ok()]);
  await sms.sendTemplate({
    template: 'admission.counselling_reminder',
    variables: { date: '12 Nov', link: 'https://phoenix.edu.in/apply?id=1' },
    recipients: [
      { to: '9876543210', variables: { name: 'Asha' }, reference: 'msg-1' },
      { to: '08123456789', variables: { name: 'Ravi', date: '13 Nov' }, reference: 'msg-2' },
    ],
  });
  assert.deepEqual(fake.calls[0].body.recipients, [
    { mobiles: '919876543210', name: 'Asha', date: '12 Nov', link: 'https://phoenix.edu.in/apply?id=1', CRQID: 'msg1' },
    { mobiles: '918123456789', name: 'Ravi', date: '13 Nov', link: 'https://phoenix.edu.in/apply?id=1', CRQID: 'msg2' },
  ]);
});

test('scheduleAt is sent as schtime in IST and the result is scheduled', async () => {
  const { sms, fake } = client([ok()]);
  const result = await sms.sendTemplate({ ...reminder, scheduleAt: '2026-11-06T04:30:00Z', shortUrl: true, shortUrlExpirySeconds: 86400, realTimeResponse: true });
  assert.equal(fake.calls[0].body.schtime, '2026-11-06 10:00:00');
  assert.equal(fake.calls[0].body.short_url, '1');
  assert.equal(fake.calls[0].body.short_url_expiry, '86400');
  assert.equal(fake.calls[0].body.realTimeResponse, '1');
  assert.equal(result.status, 'scheduled');
  assert.equal(result.scheduledFor, '2026-11-06T04:30:00.000Z');
});

test('typed DLT tags are enforced: numeric, alphanumeric and whitelisted callback numbers', async () => {
  const { sms, fake } = client([ok()]);
  await sms.sendTemplate({ template: 'admission.fee_due', to: '9876543210', variables: { amount: 15000, student: 'Asha Rao', helpline: '1800 123 4567' } });
  assert.equal(fake.calls[0].body.recipients[0].amount, '15000');

  const bad = sms.validateTemplateSend({ template: 'admission.fee_due', to: '9876543210', variables: { amount: '15,000', student: 'Asha-Rao', helpline: '1800999999' } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues.map((i) => [i.code, i.path]), [
    ['invalid_variable', 'variables.amount'],
    ['invalid_variable', 'variables.student'],
    ['callback_not_whitelisted', 'variables.helpline'],
  ]);
});

// ---------------------------------------------------------------------------------------------
// Template send: client-side DLT validation (nothing is sent)
// ---------------------------------------------------------------------------------------------

test('validation failures throw Msg91ValidationError and never call MSG91', async () => {
  const { sms, fake } = client([]);
  const cases = [
    [{ ...reminder, template: 'nope' }, 'unknown_template'],
    [{ ...reminder, to: '12345' }, 'invalid_mobile'],
    [{ ...reminder, to: '+1 415 555 0100' }, 'invalid_mobile'],
    [{ ...reminder, variables: { ...reminder.variables, name: 'x'.repeat(41) } }, 'variable_too_long'],
    [{ ...reminder, variables: { ...reminder.variables, name: undefined } }, 'missing_variable'],
    [{ ...reminder, variables: { ...reminder.variables, extra: 'x' } }, 'unknown_variable'],
    [{ ...reminder, variables: { ...reminder.variables, name: 'Asha\nRao' } }, 'invalid_variable'],
    [{ ...reminder, variables: { ...reminder.variables, link: 'https://bit.ly/abc' } }, 'url_not_whitelisted'],
    [{ ...reminder, variables: { ...reminder.variables, link: 'http://10.1.2.3/apply' } }, 'ip_url_not_allowed'],
    [{ ...reminder, variables: { ...reminder.variables, date: 'see www.example.com' } }, 'url_not_whitelisted'],
    [{ ...reminder, reference: 'x'.repeat(53) }, 'invalid_reference'],
    [{ ...reminder, to: ['9876543210', '+919876543210'], reference: undefined }, 'duplicate_recipient'],
    [{ ...reminder, scheduleAt: '2026-11-01T00:00:00Z' }, 'invalid_schedule'],
    [{ ...reminder, scheduleAt: '2026-12-01T06:00:00Z' }, 'invalid_schedule'],
    [{ ...reminder, shortUrlExpirySeconds: 3600 }, 'invalid_request'],
    [{ template: reminder.template, variables: reminder.variables }, 'invalid_recipients'],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(sms.sendTemplate(input), (err) => {
      assert.ok(err instanceof Msg91ValidationError, `${code}: ${err}`);
      assert.equal(err.retryable, false);
      assert.equal(err.delivery, 'not_sent');
      assert.ok(err.issues.some((i) => i.code === code), `expected ${code}, got ${JSON.stringify(err.issues)}`);
      return true;
    });
  }
  assert.equal(fake.calls.length, 0);
});

test('short URLs need https://m.9m.io/<HEADER>/ whitelisted and are refused for numeric headers', () => {
  const { sms } = client([], { config: { dlt: { whitelistedUrls: ['https://phoenix.edu.in/apply?'] } } });
  const missing = sms.validateTemplateSend({ ...reminder, shortUrl: true, variables: { ...reminder.variables, link: 'https://anything.example/x' } });
  assert.equal(missing.ok, false);
  assert.match(missing.issues[0].message, /https:\/\/m\.9m\.io\/PHXEDU\//);

  const { sms: withPrefix } = client([]);
  const okShort = withPrefix.validateTemplateSend({ ...reminder, shortUrl: true, variables: { ...reminder.variables, link: 'https://anything.example/x' } });
  assert.equal(okShort.ok, true, JSON.stringify(okShort.issues));

  const promo = withPrefix.validateTemplateSend({ template: 'marketing.open_day', to: '9876543210', variables: { date: 'https://phoenix.edu.in/apply?x' }, shortUrl: true });
  assert.ok(promo.issues.some((i) => i.code === 'short_url_numeric_header'));
});

test('promotional templates are refused outside 10:00–21:00 IST with the next opening time', async () => {
  const lateEvening = new Date('2026-11-05T16:00:00Z'); // 21:30 IST
  const { sms, fake } = client([], { now: lateEvening });
  await assert.rejects(sms.sendTemplate({ template: 'marketing.open_day', to: '9876543210', variables: { date: '9 Nov' } }), (err) => {
    const issue = err.issues.find((i) => i.code === 'outside_promotional_window');
    assert.ok(issue);
    assert.equal(issue.nextAllowedAt, '2026-11-06T04:30:00.000Z'); // 10:00 IST next day
    return true;
  });
  assert.equal(fake.calls.length, 0);
  // Service-implicit (transactional-like) templates are not window restricted.
  assert.equal(sms.validateTemplateSend(reminder).ok, true);
});

test("dlt.outsideWindow = 'schedule' defers promotional sends to the next window opening", async () => {
  const { sms, fake } = client([ok()], { now: new Date('2026-11-05T20:00:00Z'), config: { dlt: { outsideWindow: 'schedule' } } }); // 01:30 IST
  const result = await sms.sendTemplate({ template: 'marketing.open_day', to: '9876543210', variables: { date: '9 Nov' } });
  assert.equal(fake.calls[0].body.schtime, '2026-11-06 10:00:00');
  assert.equal(fake.calls[0].body.sender, '567890');
  assert.equal(result.scheduledFor, '2026-11-06T04:30:00.000Z');
});

test('inline template definitions are validated like registered ones', async () => {
  const { sms, fake } = client([ok()]);
  const inline = { templateId: '669a29fbd6fc053066739b99', dltTemplateId: '1307160975559044399', category: 'service_implicit', body: 'Hi ##name## -Phoenix' };
  await sms.sendTemplate({ template: inline, to: '9876543210', variables: { name: 'Asha' } });
  assert.equal(fake.calls[0].body.template_id, '669a29fbd6fc053066739b99');
  await assert.rejects(sms.sendTemplate({ template: { ...inline, dltTemplateId: '123' }, to: '9876543210', variables: { name: 'A' } }), Msg91ValidationError);
});

test('templates whose MSG91 body and DLT body disagree are a config error', () => {
  const config = baseConfig();
  config.templates['admission.counselling_reminder'].dltBody = 'Dear {#var#}, your session is on {#var#}. Apply: {#url#} -Phoenix Group';
  assert.throws(() => createMsg91Client(config, { fetch: async () => new Response('') }), (err) => {
    assert.ok(err instanceof Msg91ConfigError);
    assert.match(err.message, /dlt_body_mismatch|differ/);
    return true;
  });
});

test('config errors never echo the auth key', () => {
  assert.throws(() => createMsg91Client({ authKey: AUTH_KEY, baseUrl: 'not a url' }), (err) => {
    assert.ok(err instanceof Msg91ConfigError);
    assert.ok(!err.message.includes(AUTH_KEY));
    assert.ok(err.issues.some((i) => i.path === 'baseUrl'));
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// Template send: provider error mapping and retries
// ---------------------------------------------------------------------------------------------

test('provider errors map to typed, permanent errors with delivery not_sent', async () => {
  const cases = [
    [{ status: 200, body: { type: 'error', message: 'IP not whitelisted', code: '418' } }, 'ip_not_allowed', false],
    [{ status: 200, body: { type: 'error', message: 'Flow Not Yet Approved', code: '401' } }, 'template_not_approved', false],
    [{ status: 200, body: { type: 'error', message: 'Insufficient balance', code: '301' } }, 'insufficient_balance', false],
    [{ status: 200, body: { type: 'error', message: 'This route is currently unavailable', code: 306 } }, 'route_unavailable', true],
    [{ status: 400, body: { type: 'error', message: 'The provided flow ID or template ID is invalid.' } }, 'template_invalid', false],
    [{ status: 401, body: { type: 'error', message: 'Invalid authkey', code: '201' } }, 'auth_failed', false],
    [{ status: 401, body: { status: 'fail', hasError: true, errors: 'Unauthorized', code: '401' } }, 'auth_failed', false],
    [{ status: 200, body: { type: 'success' } }, 'unexpected_response', false],
  ];
  for (const [response, code, retryable] of cases) {
    const { sms, fake } = client([response]);
    await assert.rejects(sms.sendTemplate(reminder), (err) => {
      assert.ok(err instanceof Msg91Error);
      assert.equal(err.code, code, JSON.stringify(response));
      assert.equal(err.retryable, retryable);
      assert.equal(err.delivery, 'not_sent');
      return true;
    });
    assert.equal(fake.calls.length, 1, 'provider rejections are never retried by the client');
  }
});

test('5xx and timeouts on a send are not retried (no idempotency key) and report delivery unknown', async () => {
  const { sms, fake } = client([{ status: 502, body: '<html>Bad gateway</html>' }]);
  await assert.rejects(sms.sendTemplate(reminder), (err) => {
    assert.equal(err.code, 'provider_unavailable');
    assert.equal(err.retryable, true);
    assert.equal(err.delivery, 'unknown');
    assert.equal(err.status, 502);
    return true;
  });
  assert.equal(fake.calls.length, 1);

  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const slow = client([hang], { config: { http: { timeoutMs: 500, maxRetries: 2 } } });
  await assert.rejects(slow.sms.sendTemplate(reminder), (err) => {
    assert.equal(err.code, 'timeout');
    assert.equal(err.delivery, 'unknown');
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(slow.fake.calls.length, 1);
});

test('429 and refused connections are retried even for sends (MSG91 never saw them)', async () => {
  const { sms, fake } = client([
    { status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '1' } },
    () => {
      throw connectionRefused();
    },
    ok('6a1e93cad6fc054d8e759a5c'),
  ]);
  const result = await sms.sendTemplate(reminder);
  assert.equal(result.requestId, '6a1e93cad6fc054d8e759a5c');
  assert.equal(fake.calls.length, 3);
});

test('retries stop after maxRetries and surface a retryable rate_limited error', async () => {
  const limited = { status: 429, body: { message: 'Too many requests' } };
  const { sms, fake } = client([limited, limited, limited]);
  await assert.rejects(sms.sendTemplate(reminder), (err) => err.code === 'rate_limited' && err.retryable && err.delivery === 'not_sent');
  assert.equal(fake.calls.length, 3);
});

test('a caller abort is not retried', async () => {
  const controller = new AbortController();
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const { sms, fake } = client([hang, hang]);
  const pending = sms.listTemplates({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'aborted' && err.retryable === false);
  assert.equal(fake.calls.length, 1);
});

test('errors and logs never contain the auth key, and logs never contain phone numbers or OTPs', async () => {
  const echo = { status: 400, body: { type: 'error', message: `Invalid key ${AUTH_KEY} for 919876543210` } };
  const { sms, entries } = client([echo, { status: 200, body: { type: 'error', message: 'OTP not match' } }]);
  await assert.rejects(sms.sendTemplate(reminder), (err) => {
    assert.ok(!err.message.includes(AUTH_KEY));
    assert.ok(!JSON.stringify(err).includes(AUTH_KEY));
    assert.match(err.message, /\[REDACTED\]/);
    return true;
  });
  await sms.verifyOtp({ to: '9876543210', otp: '482913' });
  const logged = JSON.stringify(entries);
  assert.ok(entries.length >= 2);
  assert.ok(!logged.includes(AUTH_KEY));
  assert.ok(!logged.includes('9876543210'));
  assert.ok(!logged.includes('482913'));
});

test('dry_run validates and returns a synthetic id without calling MSG91', async () => {
  const { sms, fake, entries } = client([], { config: { mode: 'dry_run', dryRunOtp: '123456' } });
  const result = await sms.sendTemplate(reminder);
  assert.equal(result.dryRun, true);
  assert.match(result.requestId, /^dryrun_[0-9a-f]{24}$/);
  assert.equal((await sms.verifyOtp({ to: '9876543210', otp: '123456' })).verified, true);
  assert.equal((await sms.verifyOtp({ to: '9876543210', otp: '000000' })).verified, false);
  await assert.rejects(sms.sendTemplate({ ...reminder, to: 'abc' }), Msg91ValidationError);
  assert.equal(fake.calls.length, 0);
  assert.ok(entries.some((e) => e.obj.dryRun && e.obj.recipients[0] === '91******3210'));
});

// ---------------------------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------------------------

test('sendOtp posts template_id, mobile, otp_length and otp_expiry as query and extra params as JSON', async () => {
  const { sms, fake } = client([{ status: 200, body: { type: 'success', request_id: '34676b6d426b303131363537' } }]);
  const result = await sms.sendOtp({ to: '9876543210', variables: { Param1: 'Phoenix' } });
  const [call] = fake.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/api/v5/otp');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { template_id: '64f0c0ffee0c0ffee0c0ffee', mobile: '919876543210', otp_length: '6', otp_expiry: '10' });
  assert.equal(call.headers.authkey, AUTH_KEY);
  assert.deepEqual(call.body, { Param1: 'Phoenix' });
  assert.deepEqual(result, { provider: 'msg91', requestId: '34676b6d426b303131363537', to: '919876543210', dryRun: false });
});

test('sendOtp with a caller-supplied code sends otp instead of otp_length; bad input is rejected locally', async () => {
  const { sms, fake } = client([{ status: 200, body: { type: 'success', request_id: 'abc123abc123' } }]);
  await sms.sendOtp({ to: '9876543210', otp: '482913', realTimeResponse: true });
  const q = Object.fromEntries(fake.calls[0].url.searchParams);
  assert.equal(q.otp, '482913');
  assert.equal(q.otp_length, undefined);
  assert.equal(q.realTimeResponse, '1');
  await assert.rejects(sms.sendOtp({ to: '9876543210', otp: '12' }), Msg91ValidationError);
  await assert.rejects(sms.sendOtp({ to: '9876543210', expiryMinutes: 20000 }), Msg91ValidationError);
  assert.equal(fake.calls.length, 1);
});

test('sendOtp maps an invalid template error response', async () => {
  const { sms } = client([{ status: 200, body: { message: 'The provided flow ID or template ID is invalid.', type: 'error' } }]);
  await assert.rejects(sms.sendOtp({ to: '9876543210' }), (err) => err.code === 'template_invalid' && err.delivery === 'not_sent');
});

test('verifyOtp: GET with otp and mobile; wrong or expired codes are results, not exceptions', async () => {
  const { sms, fake } = client([
    { status: 200, body: { message: 'OTP verified success', type: 'success' } },
    { status: 200, body: { message: 'OTP not match', type: 'error' } },
    { status: 200, body: { message: 'OTP expired', type: 'error' } },
    { status: 200, body: { message: 'Mobile no. already verified', type: 'error' } },
    { status: 401, body: { message: 'Invalid authkey', type: 'error', code: '201' } },
  ]);
  assert.deepEqual(await sms.verifyOtp({ to: '9876543210', otp: '4829' }), { verified: true, reason: 'verified', message: 'OTP verified success' });
  assert.equal(fake.calls[0].method, 'GET');
  assert.equal(fake.calls[0].url.pathname, '/api/v5/otp/verify');
  assert.deepEqual(Object.fromEntries(fake.calls[0].url.searchParams), { otp: '4829', mobile: '919876543210' });
  assert.equal((await sms.verifyOtp({ to: '9876543210', otp: '4829' })).reason, 'mismatch');
  assert.equal((await sms.verifyOtp({ to: '9876543210', otp: '4829' })).reason, 'expired');
  assert.equal((await sms.verifyOtp({ to: '9876543210', otp: '4829' })).reason, 'already_verified');
  await assert.rejects(sms.verifyOtp({ to: '9876543210', otp: '4829' }), (err) => err.code === 'auth_failed' && !err.retryable);
  await assert.rejects(sms.verifyOtp({ to: '9876543210', otp: 'abcd' }), Msg91ValidationError);
});

test('resendOtp uses retrytype text|voice and reports the retry limit as a result', async () => {
  const { sms, fake } = client([
    { status: 200, body: { message: 'retry send successfully', type: 'success' } },
    { status: 200, body: { message: 'OTP retry count maxed out', type: 'error' } },
  ]);
  assert.equal((await sms.resendOtp({ to: '9876543210', channel: 'voice' })).sent, true);
  assert.deepEqual(Object.fromEntries(fake.calls[0].url.searchParams), { mobile: '919876543210', retrytype: 'voice' });
  assert.equal(fake.calls[0].url.pathname, '/api/v5/otp/retry');
  assert.ok(!fake.calls[0].url.search.includes('authkey'), 'the auth key stays in the header, never in the URL');
  assert.deepEqual(await sms.resendOtp({ to: '9876543210' }), { sent: false, reason: 'retry_limit', message: 'OTP retry count maxed out' });
});

// ---------------------------------------------------------------------------------------------
// Reads (idempotent: retried on 5xx)
// ---------------------------------------------------------------------------------------------

test('listTemplates is retried on 503 and maps flows', async () => {
  const { sms, fake } = client([
    { status: 503, body: 'unavailable' },
    { status: 200, body: { msg_type: 'Success', data: [{ flow_id: '645b6443d6fc0503960dff32', flow_name: 'Multipart' }] } },
  ]);
  assert.deepEqual(await sms.listTemplates(), [{ templateId: '645b6443d6fc0503960dff32', name: 'Multipart' }]);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].method, 'GET');
  assert.equal(fake.calls[1].url.pathname, '/api/v5/flows');
});

test('checkCredentials surfaces auth failures', async () => {
  const { sms } = client([{ status: 401, body: { status: 'fail', hasError: true, errors: 'Unauthorized', code: '401' } }]);
  await assert.rejects(sms.checkCredentials(), (err) => err.code === 'auth_failed');
});

test('getDeliveryLogs sends IST dates, enforces the 3-day window and maps 200-with-error', async () => {
  const { sms, fake } = client([
    { status: 200, body: { data: [{ requestId: 'r1', status: 'Delivered' }] } },
    { status: 200, body: { error: "Date must be provided in 'yyyy-MM-dd' format" } },
  ]);
  const logs = await sms.getDeliveryLogs({ startDate: '2026-11-03', endDate: new Date('2026-11-04T20:00:00Z'), requestId: '5e1e93cad6fc054d8e759a5b' });
  assert.deepEqual(logs.rows, [{ requestId: 'r1', status: 'Delivered' }]);
  const [call] = fake.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/api/v5/report/logs/p/sms');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { startDate: '2026-11-03', endDate: '2026-11-05', requestId: '5e1e93cad6fc054d8e759a5b' });
  await assert.rejects(sms.getDeliveryLogs({ startDate: '2026-11-04', endDate: '2026-11-05' }), (err) => err.code === 'invalid_request' && err.delivery === 'not_sent');
  await assert.rejects(sms.getDeliveryLogs({ startDate: '2026-10-01', endDate: '2026-10-02' }), Msg91ValidationError);
  await assert.rejects(sms.getDeliveryLogs({ startDate: '2026-11-01', endDate: '2026-11-05' }), Msg91ValidationError);
});

test('getTemplateVersions posts template_id and maps hasError responses', async () => {
  const { sms, fake } = client([
    { status: 200, body: { data: [{ id: 'v1', DLT_TE_ID: '1307160975559044358', status: 'approved' }], status: 'success', hasError: false, errors: [] } },
    { status: 200, body: { data: [], status: 'error', hasError: true, errors: ['Template Id Missing or Invalid'] } },
  ]);
  const versions = await sms.getTemplateVersions({ templateId: '669a29fbd6fc053066739b42' });
  assert.equal(versions[0].DLT_TE_ID, '1307160975559044358');
  assert.deepEqual(fake.calls[0].body, { template_id: '669a29fbd6fc053066739b42' });
  await assert.rejects(sms.getTemplateVersions({ templateId: '669a29fbd6fc053066739b42' }), (err) => err.code === 'template_invalid');
});
