import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyVariableOrder,
  cleanValue,
  placeholdersIn,
  renderTemplate,
  renderedText,
  standardVariables,
  templateVariables,
  toProviderText,
  validateTemplate,
} from '../../src/core/messaging/templates.js';

// Template variables, validation and rendering (core/messaging/templates.js).

const whatsapp = (overrides = {}) => ({
  channel: 'whatsapp',
  name: 'booking_link',
  language: 'en',
  header: { type: 'text', text: 'Hello {{first_name}}' },
  body: 'Hi {{first_name}}, book your demo with {{company_name}} here: {{booking_link}} and see you soon.',
  footer: 'SatnPaper admissions',
  buttons: [
    { type: 'url', text: 'Choose a slot', url: 'https://book.example.com/demo/{{booking_code}}' },
    { type: 'quick_reply', text: 'Call me' },
  ],
  ...overrides,
});

const paths = (issues) => issues.map((i) => i.path);

test('placeholders: named and positional variables, in order, with brace problems reported', () => {
  assert.deepEqual(placeholdersIn('Hi {{ first_name }}, {{1}} and {{first_name}}').names, ['first_name', '1', 'first_name']);
  assert.deepEqual(placeholdersIn('Hi {{First Name}}').issues.length, 1);
  assert.deepEqual(placeholdersIn('Hi {{}}').issues, ['Empty {{ }}: name the variable']);
  assert.equal(placeholdersIn('Hi {{name').issues.length, 1);
  assert.equal(placeholdersIn('Hi name}}').issues.length, 1);
  assert.deepEqual(placeholdersIn(null), { names: [], issues: [] });
});

test('variables across subject, header, body and link buttons; WhatsApp numbers the body by first appearance', () => {
  const template = whatsapp();
  assert.deepEqual(templateVariables(template), ['first_name', 'company_name', 'booking_link', 'booking_code']);
  assert.deepEqual(bodyVariableOrder(template.body), ['first_name', 'company_name', 'booking_link']);
  assert.equal(toProviderText(template.body), 'Hi {{1}}, book your demo with {{2}} here: {{3}} and see you soon.');
  assert.deepEqual(templateVariables({ channel: 'email', subject: 'For {{first_name}}', body: 'Dear {{contact_name}}' }), ['first_name', 'contact_name']);
});

test('a valid WhatsApp template has no issues; samples are required only on submit', () => {
  assert.deepEqual(validateTemplate(whatsapp()), []);
  const missing = validateTemplate(whatsapp(), { requireSamples: true });
  assert.deepEqual(paths(missing), ['body.samples.first_name', 'body.samples.company_name', 'body.samples.booking_link', 'body.samples.booking_code']);
  const samples = { first_name: 'Priya', company_name: 'SatnPaper', booking_link: 'https://x.example', booking_code: 'AB12' };
  assert.deepEqual(validateTemplate(whatsapp({ samples }), { requireSamples: true }), []);
});

test("WhatsApp rules: name format, body edges, header and footer limits, buttons", () => {
  assert.deepEqual(paths(validateTemplate(whatsapp({ name: 'Booking Link' }))), ['body.name']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ language: 'english' }))), ['body.language']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ body: '{{first_name}}, your demo is booked' }))), ['body.body']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ body: 'Your link: {{booking_link}}' }))), ['body.body']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ body: '   ' }))), ['body.body']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ header: { type: 'text', text: '{{a}} and {{b}}' } }))), ['body.header.text']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ footer: 'Hi {{first_name}}' }))), ['body.footer']);
  assert.deepEqual(paths(validateTemplate(whatsapp({ footer: 'x'.repeat(61) }))), ['body.footer']);
  const buttons = [
    { type: 'url', text: 'Open', url: 'https://example.com/{{a}}/page' },
    { type: 'url', text: 'Open', url: 'http://example.com' },
    { type: 'phone', text: 'Call', phone: '98765 43210' },
    { type: 'quick_reply', text: 'x'.repeat(26) },
  ];
  assert.deepEqual(paths(validateTemplate(whatsapp({ buttons }))), ['body.buttons.0.url', 'body.buttons.1.url', 'body.buttons.2.phone', 'body.buttons.3.text']);
  const many = Array.from({ length: 11 }, () => ({ type: 'quick_reply', text: 'Yes' }));
  assert.deepEqual(paths(validateTemplate(whatsapp({ buttons: many }))), ['body.buttons']);
  const tooManyVariables = `Hi ${Array.from({ length: 21 }, (_, i) => `{{v${i}}}`).join(' ')} thanks`;
  assert.ok(paths(validateTemplate(whatsapp({ body: tooManyVariables }))).includes('body.body'));
});

test('email needs a subject; SMS and email take no header, footer or buttons', () => {
  assert.deepEqual(paths(validateTemplate({ channel: 'email', body: 'Hello' })), ['body.subject']);
  assert.deepEqual(validateTemplate({ channel: 'email', subject: 'Hi {{first_name}}', body: '{{first_name}}, welcome' }), []);
  assert.deepEqual(paths(validateTemplate({ channel: 'sms', body: 'Hi', header: { type: 'text', text: 'X' }, footer: 'F', buttons: [{ type: 'quick_reply', text: 'A' }], subject: 'S' })), [
    'body.header',
    'body.footer',
    'body.buttons',
    'body.subject',
  ]);
  // SMS may start with a variable (verification codes do).
  assert.deepEqual(validateTemplate({ channel: 'sms', body: '{{code}} is your code' }), []);
  assert.deepEqual(paths(validateTemplate({ channel: 'fax', body: 'x' })), ['body.channel']);
});

test('render fills every variable and gives the adapter positional parameters', () => {
  const rendered = renderTemplate(whatsapp(), { first_name: 'Priya', company_name: 'SatnPaper', booking_link: 'https://b.example/1', booking_code: 'AB12', unused: 'x' });
  assert.deepEqual(rendered.missing, []);
  assert.equal(rendered.header.text, 'Hello Priya');
  assert.equal(rendered.body, 'Hi Priya, book your demo with SatnPaper here: https://b.example/1 and see you soon.');
  assert.equal(rendered.buttons[0].url, 'https://book.example.com/demo/AB12');
  assert.deepEqual(rendered.parameters, { body: ['Priya', 'SatnPaper', 'https://b.example/1'], header: ['Priya'], buttons: ['AB12'] });
  assert.deepEqual(Object.keys(rendered.values), ['first_name', 'company_name', 'booking_link', 'booking_code']);
  assert.equal(renderedText(rendered), `Hello Priya\n\n${rendered.body}\n\nSatnPaper admissions`);
});

test('render reports missing variables and keeps their placeholders', () => {
  const rendered = renderTemplate(whatsapp(), { first_name: 'Priya', company_name: '  ' });
  assert.deepEqual(rendered.missing, ['company_name', 'booking_link', 'booking_code']);
  assert.match(rendered.body, /\{\{company_name\}\}/);
  assert.deepEqual(rendered.parameters.body, ['Priya', '', '']);
});

test('values are cleaned per channel: no new lines or tabs on WhatsApp, 160 characters on SMS', () => {
  assert.equal(cleanValue('  Line one\n\tline   two ', 'whatsapp'), 'Line one line two');
  assert.equal(cleanValue('Line one\nline two', 'email'), 'Line one\nline two');
  assert.equal(cleanValue('x'.repeat(200), 'sms').length, 160);
  assert.equal(cleanValue(42, 'whatsapp'), '42');
  assert.equal(cleanValue(null, 'whatsapp'), '');
});

test('standard variables come from the person, company, deal and owner', () => {
  const values = standardVariables({
    contact: { first_name: 'Priya', display_name: 'Priya Sharma' },
    company: { name: 'SatnPaper' },
    deal: { ref: 'SP-1042' },
    ownerName: 'Ritika Rao',
  });
  assert.deepEqual(values, { first_name: 'Priya', contact_name: 'Priya Sharma', company_name: 'SatnPaper', deal_ref: 'SP-1042', owner_name: 'Ritika Rao' });
  assert.deepEqual(standardVariables({ contact: { display_name: 'Unnamed contact' }, company: null }), {});
  assert.deepEqual(standardVariables({ contact: { first_name: null, display_name: 'Aarav Shah' } }), { first_name: 'Aarav', contact_name: 'Aarav Shah' });
  assert.deepEqual(standardVariables({ contact: { first_name: 'X', display_name: 'X Y', erased_at: new Date() } }), {});
});
