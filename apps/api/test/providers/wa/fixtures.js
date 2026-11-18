/**
 * Sample webhook payloads. The ones marked "official" are copied from Meta's webhook reference
 * pages (developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/...,
 * read 2026-11-05); the others follow the documented syntax with Indian sample data.
 * All ids, numbers and secrets are fake.
 */

export const APP_SECRET = 'test_app_secret_not_real_0001';
export const OLD_APP_SECRET = 'test_app_secret_not_real_0000';
export const VERIFY_TOKEN = 'phoenix-verify-token-test';
export const ACCESS_TOKEN = 'EAAtestTOKENnotREAL1234567890abcdef';

const metadata = { display_phone_number: '15550783881', phone_number_id: '106540352242922' };

/** @param {string} field @param {object} value @param {object} [entryExtra] */
export function wrap(field, value, entryExtra = {}) {
  return { object: 'whatsapp_business_account', entry: [{ id: '102290129340398', ...entryExtra, changes: [{ value, field }] }] };
}

/** Official: text message received (webhooks/overview). */
export const inboundTextOfficial = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234' }],
  messages: [
    {
      from: '16505551234',
      id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
      timestamp: '1749416383',
      type: 'text',
      text: { body: 'Does it come in another color?' },
    },
  ],
});

/** Text from a parent who came through a Click to WhatsApp ad. */
export const inboundTextFromAd = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Asha Verma' }, wa_id: '919876543210' }],
  messages: [
    {
      from: '919876543210',
      id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0FBRDE=',
      timestamp: '1762300800',
      type: 'text',
      text: { body: 'What are the admission fees for Class 6?' },
      referral: {
        source_url: 'https://fb.me/abc123',
        source_id: '120210000000000001',
        source_type: 'ad',
        body: 'Admissions open for 2027-28',
        headline: 'Phoenix Public School',
        media_type: 'image',
        image_url: 'https://example.invalid/ad.jpg',
        ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a',
        welcome_message: { text: 'Hi! How can we help?' },
      },
    },
  ],
});

export const inboundImage = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: '919812345678' }],
  messages: [
    {
      from: '919812345678',
      id: 'wamid.IMAGE1',
      timestamp: '1762300900',
      type: 'image',
      image: {
        caption: 'Marksheet attached',
        mime_type: 'image/jpeg',
        sha256: 'zbFxLoZJmL2Nv/vu6+6xNSRz7D7lZ6GsRtbD6TlxDYk=',
        id: '1003383421387256',
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256',
      },
      context: { forwarded: true },
    },
  ],
});

/** Reply-button tap on an interactive message, and a template quick-reply tap, in one batch. */
export const inboundReplies = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Asha Verma' }, wa_id: '919876543210' }],
  messages: [
    {
      context: { from: '15550783881', id: 'wamid.OUTBOUND1' },
      from: '919876543210',
      id: 'wamid.REPLY1',
      timestamp: '1762301000',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'book_visit', title: 'Book a campus visit' } },
    },
    {
      context: { from: '15550783881', id: 'wamid.OUTBOUND2' },
      from: '919876543210',
      id: 'wamid.REPLY2',
      timestamp: '1762301005',
      type: 'button',
      button: { payload: 'STOP_PROMOS', text: 'Stop promotions' },
    },
    {
      from: '919876543210',
      id: 'wamid.LIST1',
      timestamp: '1762301010',
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'grade_6', title: 'Class 6', description: 'Age 11+' } },
    },
  ],
});

export const inboundReactionAndLocation = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Asha Verma' }, wa_id: '919876543210' }],
  messages: [
    { from: '919876543210', id: 'wamid.REACT1', timestamp: '1762301100', type: 'reaction', reaction: { message_id: 'wamid.OUTBOUND1', emoji: '\u{1F44D}' } },
    { from: '919876543210', id: 'wamid.REACT2', timestamp: '1762301101', type: 'reaction', reaction: { message_id: 'wamid.OUTBOUND1' } },
    {
      from: '919876543210',
      id: 'wamid.LOC1',
      timestamp: '1762301200',
      type: 'location',
      location: { address: 'Sector 21, Gurugram', latitude: 28.4595, longitude: 77.0266, name: 'Home', url: 'https://example.invalid' },
    },
  ],
});

/** Unsupported message type (documented under webhooks/reference/messages/unsupported). */
export const inboundUnsupported = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Asha Verma' }, wa_id: '919876543210' }],
  messages: [
    {
      from: '919876543210',
      id: 'wamid.UNSUP1',
      timestamp: '1762301300',
      errors: [{ code: 131051, title: 'Message type unknown', message: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }],
      type: 'unsupported',
      unsupported: { type: 'edit' },
    },
  ],
});

/** A user who adopted a username: BSUID instead of a phone number (business-scoped-user-ids, 2026). */
export const inboundFromBsuid = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Meera', username: 'meera.k' }, user_id: 'IN.13491208655302741918' }],
  messages: [{ from_user_id: 'IN.13491208655302741918', id: 'wamid.BSUID1', timestamp: '1762301400', type: 'text', text: { body: 'Hello' } }],
});

/** Official: marketing message sent, with conversation and pricing (webhooks/reference/messages/status). */
export const statusSentOfficial = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  statuses: [
    {
      id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=',
      status: 'sent',
      timestamp: '1750030073',
      recipient_id: '16505551234',
      conversation: { id: '72b14d6bd5407799e66f64d1b338e567', expiration_timestamp: '1750116480', origin: { type: 'marketing' } },
      pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' },
    },
  ],
});

/** Official: v24.0 sent status without conversation or pricing. */
export const statusSentV24Official = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  statuses: [{ id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=', status: 'sent', timestamp: '1750030073', recipient_id: '16505551234' }],
});

/** Official: failed status with error 131049. */
export const statusFailedOfficial = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  statuses: [
    {
      id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA',
      status: 'failed',
      timestamp: '1751142888',
      recipient_id: '16505551234',
      errors: [
        {
          code: 131049,
          title: 'This message was not delivered to maintain healthy ecosystem engagement.',
          message: 'This message was not delivered to maintain healthy ecosystem engagement.',
          error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' },
          href: '/documentation/business-messaging/whatsapp/support/error-codes',
        },
      ],
    },
  ],
});

/** Delivered + read for one of our sends, carrying our outbox id back. */
export const statusDeliveredRead = wrap('messages', {
  messaging_product: 'whatsapp',
  metadata,
  contacts: [{ profile: { name: 'Asha Verma' }, wa_id: '919876543210', user_id: 'IN.111' }],
  statuses: [
    {
      id: 'wamid.OUT9',
      status: 'delivered',
      timestamp: '1762302000',
      recipient_id: '919876543210',
      recipient_user_id: 'IN.111',
      biz_opaque_callback_data: 'outbox:01JBX7Q2',
      pricing: { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'utility' },
    },
    { id: 'wamid.OUT9', status: 'read', timestamp: '1762302060', recipient_id: '919876543210', biz_opaque_callback_data: 'outbox:01JBX7Q2' },
  ],
});

/** Template status updates (webhooks/reference/message_template_status_update). */
export const templateApproved = wrap(
  'message_template_status_update',
  {
    event: 'APPROVED',
    message_template_id: 1387372356726668,
    message_template_name: 'admission_followup',
    message_template_language: 'en',
    reason: 'NONE',
    message_template_category: 'UTILITY',
  },
  { time: 1762303000 },
);

export const templateRejected = wrap(
  'message_template_status_update',
  {
    event: 'REJECTED',
    message_template_id: 1166414785519855,
    message_template_name: 'fee_offer',
    message_template_language: 'hi',
    reason: 'INVALID_FORMAT',
    message_template_category: 'MARKETING',
    rejection_info: { reason: 'Variable at the end of the body', recommendation: 'Add text after the last variable' },
  },
  { time: 1762303100 },
);

/** A field we do not model (still verified, recorded and deduplicated). */
export const accountUpdate = wrap('account_update', { event: 'VERIFIED_ACCOUNT', waba_info: { waba_id: '102290129340398' } }, { time: 1762304000 });

/** Change-level errors (webhooks/reference/messages/errors). */
export const changeErrors = wrap(
  'messages',
  { messaging_product: 'whatsapp', metadata, errors: [{ code: 131000, title: 'Something went wrong', message: 'Something went wrong', error_data: { details: 'Unknown' } }] },
  { time: 1762305000 },
);

/**
 * Raw body exactly as bytes on the wire, with Meta-style \u escapes for non-ASCII text.
 * Re-serialising the parsed object would turn the escapes into UTF-8 and break the signature.
 */
export const RAW_ESCAPED_BODY = String.raw`{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[{"value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550783881","phone_number_id":"106540352242922"},"contacts":[{"profile":{"name":"\u0906\u0936\u093e"},"wa_id":"919876543210"}],"messages":[{"from":"919876543210","id":"wamid.TEST1","timestamp":"1762300800","type":"text","text":{"body":"\u092b\u0940\u0938?"}}]},"field":"messages"}]}]}`;

export const RAW_MINIMAL_BODY = '{"object":"whatsapp_business_account","entry":[]}';
