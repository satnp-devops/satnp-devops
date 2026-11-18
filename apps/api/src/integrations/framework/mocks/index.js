import { createCalendarMock, createCallingMock, createMeetingsMock } from './scheduling.js';
import { createEmailMock, createSmsMock, createWhatsappMock } from './messaging.js';
import { createEsignMock, createPaymentsMock } from './money.js';
import { createAiMock, createStorageMock } from './platform.js';

/** The mock adapter factory for each kind: (ctx) => adapter. See mocks/common.js for the rules. */
export const MOCK_FACTORIES = Object.freeze({
  'messaging.whatsapp': createWhatsappMock,
  'messaging.email': createEmailMock,
  'messaging.sms': createSmsMock,
  calling: createCallingMock,
  meetings: createMeetingsMock,
  calendar: createCalendarMock,
  payments: createPaymentsMock,
  esign: createEsignMock,
  ai: createAiMock,
  storage: createStorageMock,
});

export { buildMockWebhook, MOCK_SIGNATURE_HEADER, SIMULATE_OPTIONS } from './common.js';
export { MOCK_WHATSAPP_TEMPLATES } from './messaging.js';
