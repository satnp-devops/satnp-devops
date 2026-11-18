import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_TYPES, attributionFromUrl, enquirySchema, toEnquiry } from '../../src/core/intake/enquiry.js';

const NOW = Date.UTC(2026, 10, 5, 4, 30);
const base = (over = {}) => ({
  source: { channel: { type: 'website_form', identity: 'satnpaper.com' } },
  contact: { name: 'rahul sharma', phone: '98765 43210' },
  ...over,
});

test('a web form enquiry is normalised', () => {
  const result = toEnquiry(
    base({
      contact: { name: ' RAHUL SHARMA ', phone: '098765 43210', email: ' Rahul.Sharma@Gmail.com ', relation: 'parent', language: 'HI', country: 'in' },
      student: { name: 'aarav sharma', grade: '11', targetExam: 'SAT' },
      interest: { course: 'SAT prep', message: 'Weekend batch?' },
    }),
    { now: NOW },
  );
  assert.equal(result.ok, true);
  const { enquiry } = result;
  assert.deepEqual(enquiry.contact, {
    name: 'Rahul Sharma',
    phone: '+919876543210',
    email: 'rahul.sharma@gmail.com',
    relation: 'parent',
    language: 'hi',
    country: 'IN',
  });
  assert.equal(enquiry.student.name, 'Aarav Sharma');
  assert.equal(enquiry.receivedAt, new Date(NOW).toISOString());
  assert.equal(enquiry.audience, 'b2c');
  assert.deepEqual(result.warnings, []);
});

test('the source keeps full attribution, and UTM tags come from the landing URL', () => {
  const result = toEnquiry(
    base({
      source: {
        channel: { type: 'landing_page', identity: 'https://satnpaper.com/sat' },
        landingUrl: 'https://satnpaper.com/sat?utm_source=facebook&utm_medium=cpc&utm_campaign=diwali-sat&utm_content=video&fbclid=FB123',
        referrer: 'https://www.facebook.com/',
        partnerId: 'partner-77',
        campaignId: 'cmp-9',
      },
    }),
    { now: NOW },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.enquiry.source, {
    channel: { type: 'landing_page', identity: 'https://satnpaper.com/sat' },
    landingUrl: 'https://satnpaper.com/sat?utm_source=facebook&utm_medium=cpc&utm_campaign=diwali-sat&utm_content=video&fbclid=FB123',
    referrer: 'https://www.facebook.com/',
    partnerId: 'partner-77',
    campaignId: 'cmp-9',
    utm: { source: 'facebook', medium: 'cpc', campaign: 'diwali-sat', content: 'video' },
    clickIds: { fbclid: 'FB123' },
    campaign: 'diwali-sat',
  });
});

test('explicit UTM tags win over the landing URL', () => {
  const result = toEnquiry(
    base({ source: { channel: { type: 'landing_page' }, landingUrl: 'https://x.in/?utm_source=google&utm_medium=cpc', utm: { source: 'newsletter' }, campaign: 'Back to school' } }),
    { now: NOW },
  );
  assert.deepEqual(result.enquiry.source.utm, { source: 'newsletter', medium: 'cpc' });
  assert.equal(result.enquiry.source.campaign, 'Back to school');
});

test('attributionFromUrl ignores bad URLs and blank tags', () => {
  assert.deepEqual(attributionFromUrl('not a url'), { utm: {}, clickIds: {} });
  assert.deepEqual(attributionFromUrl(undefined), { utm: {}, clickIds: {} });
  assert.deepEqual(attributionFromUrl('https://x.in/?utm_source=&gclid=G1'), { utm: {}, clickIds: { gclid: 'G1' } });
});

test('a phone or an email is required', () => {
  const result = toEnquiry(base({ contact: { name: 'Rahul' } }), { now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ['contact_point_required']);
});

test('an unusable phone is dropped with a warning when an email remains', () => {
  const result = toEnquiry(base({ contact: { name: 'Rahul', phone: '12345', email: 'rahul@example.in' } }), { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.enquiry.contact.phone, undefined);
  assert.deepEqual(result.warnings.map((w) => [w.path, w.code]), [['contact.phone', 'invalid_phone']]);
});

test('when nothing usable remains, the invalid contact points become the errors', () => {
  const result = toEnquiry(base({ contact: { name: 'Rahul', phone: '12345', email: 'nope' } }), { now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.code), ['invalid_phone', 'invalid_email', 'contact_point_required']);
  assert.deepEqual(result.warnings, []);
});

test('the alternate phone steps in when the main one is invalid, and duplicates collapse', () => {
  const a = toEnquiry(base({ contact: { phone: 'n/a', altPhone: '9876543210' } }), { now: NOW });
  assert.equal(a.enquiry.contact.phone, '+919876543210');
  assert.equal(a.enquiry.contact.altPhone, undefined);
  const b = toEnquiry(base({ contact: { phone: '9876543210', altPhone: '+91 98765 43210' } }), { now: NOW });
  assert.equal(b.enquiry.contact.altPhone, undefined);
});

test('the contact country sets the phone default country', () => {
  const result = toEnquiry(base({ contact: { phone: '050 123 4567', country: 'AE' } }), { now: NOW });
  assert.equal(result.enquiry.contact.phone, '+971501234567');
});

test('first and last name make the name when it is missing', () => {
  const result = toEnquiry(base({ contact: { firstName: 'PRIYA', lastName: 'IYER', email: 'p@x.in' } }), { now: NOW });
  assert.equal(result.enquiry.contact.name, 'Priya Iyer');
  assert.equal(result.enquiry.contact.firstName, 'Priya');
});

test('blank strings and nulls count as not given', () => {
  const result = toEnquiry(
    base({ contact: { name: '', phone: '9876543210', email: '   ', city: null }, student: { name: '' }, interest: { message: '' } }),
    { now: NOW },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.enquiry.contact, { phone: '+919876543210' });
  assert.equal(result.enquiry.student, undefined);
  assert.equal(result.enquiry.interest, undefined);
});

test('a B2B enquiry from an institute', () => {
  const result = toEnquiry(
    {
      source: { channel: { type: 'email', identity: 'sales@scholiq.in' } },
      contact: { name: 'Anita Rao', email: 'anita@brightcoaching.in', relation: 'staff' },
      institute: { name: 'Bright Coaching', city: 'Pune', studentCount: '1,200'.replace(',', ''), website: 'https://brightcoaching.in' },
      interest: { product: 'Test platform' },
    },
    { now: NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.enquiry.audience, 'b2b');
  assert.equal(result.enquiry.institute.studentCount, 1200);
});

test('a learner enquiring with a parent', () => {
  const result = toEnquiry(
    base({ contact: { name: 'Aarav Sharma', phone: '9876500000', relation: 'self' }, parent: { name: 'rahul sharma', phone: '09876543210', relation: 'father' } }),
    { now: NOW },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.enquiry.parent, { name: 'Rahul Sharma', phone: '+919876543210', relation: 'father' });
});

test('schema errors carry the field path', () => {
  const cases = [
    [{ ...base(), source: { channel: { type: 'pigeon' } } }, 'source.channel.type'],
    [base({ contact: { phone: '9876543210', timeZone: 'Mars/Olympus' } }), 'contact.timeZone'],
    [base({ contact: { phone: '9876543210', language: 'Hindi' } }), 'contact.language'],
    [base({ contact: { phone: '9876543210', country: 'India' } }), 'contact.country'],
    [base({ source: { channel: { type: 'landing_page' }, landingUrl: 'javascript:alert(1)' } }), 'source.landingUrl'],
    [base({ receivedAt: '5 Nov 2026' }), 'receivedAt'],
    [base({ contact: { phone: '9876543210', nickname: 'Bunty' } }), 'contact'],
    [base({ student: { name: 'A', dateOfBirth: '31-12-2010' } }), 'student.dateOfBirth'],
  ];
  for (const [input, path] of cases) {
    const result = toEnquiry(input, { now: NOW });
    assert.equal(result.ok, false, path);
    assert.ok(result.errors.some((e) => e.path === path), `${path}: ${JSON.stringify(result.errors)}`);
  }
});

test('an explicit receivedAt is kept as a UTC instant', () => {
  const result = toEnquiry(base({ receivedAt: '2026-11-05T10:30:00+05:30' }), { now: NOW });
  assert.equal(result.enquiry.receivedAt, '2026-11-05T10:30:00+05:30');
  const asDate = toEnquiry(base({ receivedAt: new Date(NOW) }), { now: 0 });
  assert.equal(asDate.enquiry.receivedAt, new Date(NOW).toISOString());
});

test('the raw payload is kept for history', () => {
  const raw = { formField7: 'JEE', page: 3 };
  const result = toEnquiry(base({ raw }), { now: NOW });
  assert.deepEqual(result.enquiry.raw, raw);
});

test('injected normalisers are used', () => {
  const result = toEnquiry(base(), {
    now: NOW,
    normalizers: { phone: (raw) => `+X${String(raw).replace(/\D/g, '')}`, name: (raw) => String(raw).toUpperCase() },
  });
  assert.equal(result.enquiry.contact.phone, '+X9876543210');
  assert.equal(result.enquiry.contact.name, 'RAHUL SHARMA');
});

test('every channel type is accepted by the schema', () => {
  for (const type of CHANNEL_TYPES) {
    const parsed = enquirySchema.safeParse({ source: { channel: { type } }, contact: { phone: '9876543210' } });
    assert.ok(parsed.success, type);
  }
});

test('input is not mutated', () => {
  const input = base({ contact: { name: 'rahul', phone: '98765 43210' } });
  const copy = structuredClone(input);
  toEnquiry(input, { now: NOW });
  assert.deepEqual(input, copy);
});
