/**
 * Sample payloads. Shapes follow Exotel's published samples (support article 3000106308 for
 * StatusCallback events, 48283 for Passthru, developer docs for Connect / Call Details); numbers
 * and SIDs are fictional.
 */

export const SECRET = 'test-secret-0123456789abcdefghijklmnop';

export const baseConfig = Object.freeze({
  accountSid: 'phoenixedu1',
  apiKey: 'test-api-key-123',
  apiToken: 'test-api-token-456',
  region: 'mumbai',
  callerId: '08044556678',
  statusCallbackUrl: 'https://crm.phoenix.test/api/webhooks/exotel/status',
  webhookSecret: SECRET,
});

/** Connect API response (JSON, `.json` suffix). */
export const connectResponse = {
  Call: {
    Sid: '09c14403fb2a31097ba5ed64f9251646',
    ParentCallSid: null,
    DateCreated: '2026-11-05 10:44:40',
    DateUpdated: '2026-11-05 10:44:40',
    AccountSid: 'phoenixedu1',
    To: '09876543210',
    From: '09123456789',
    PhoneNumberSid: '08044556678',
    Status: 'in-progress',
    StartTime: '2026-11-05 10:44:40',
    EndTime: null,
    Duration: null,
    Price: null,
    Direction: 'outbound-api',
    AnsweredBy: null,
    ForwardedFrom: null,
    CallerName: null,
    Uri: '/v1/Accounts/phoenixedu1/Calls/09c14403fb2a31097ba5ed64f9251646.json',
    RecordingUrl: null,
  },
};

/** Call Details API response with details=true. */
export const callDetailsResponse = {
  Call: {
    Sid: 'b6cfaf5f5cef3ca0fc937749ef96d245',
    ParentCallSid: null,
    DateCreated: '2026-11-05 14:25:10',
    DateUpdated: '2026-11-05 14:31:02',
    AccountSid: 'phoenixedu1',
    To: '09876543210',
    From: '09123456789',
    PhoneNumberSid: '08044556678',
    Status: 'completed',
    StartTime: '2026-11-05 14:25:12',
    EndTime: '2026-11-05 14:30:45',
    Duration: '335',
    Price: '1.875',
    Direction: 'outbound-api',
    AnsweredBy: 'human',
    RecordingUrl: 'https://recordings.exotel.com/exotelrecordings/phoenixedu1/b6cfaf5f5cef3ca0fc937749ef96d245.mp3',
    CustomField: 'lead-42',
    Details: {
      ConversationDuration: 320,
      Leg1Status: 'completed',
      Leg2Status: 'completed',
      Legs: [{ Leg: { Id: 1, OnCallDuration: 335 } }, { Leg: { Id: 2, OnCallDuration: 320 } }],
    },
  },
};

/** Terminal StatusCallback, JSON (from the support article sample, with CustomField). */
export const terminalCallback = {
  CallSid: '054cfcd8910389ff64882d8e25211646',
  EventType: 'terminal',
  DateCreated: '2022-04-06 10:48:00',
  DateUpdated: '2022-04-06 10:48:16',
  Status: 'completed',
  To: '08780296135',
  From: '07874762218',
  PhoneNumberSid: '08044556678',
  StartTime: '2022-04-06 10:48:04',
  EndTime: '2022-04-06 10:48:16',
  EventTime: '2022-04-06 10:48:16',
  Direction: 'outbound-api',
  RecordingUrl: 'https://s3-us-west-2.amazonaws.com/exotel-us3-recordings/ree5e1us3/054cfcd8910389ff64882d8e25211646.mp3',
  ConversationDuration: 6,
  CustomField: 'lead-42',
  Legs: [
    { OnCallDuration: 12, RingingDuration: 4, Status: 'completed' },
    { OnCallDuration: 6, RingingDuration: 3, Status: 'completed' },
  ],
};

/** Answered event when the second (customer) leg picks up. */
export const answeredLeg2Callback = {
  CallSid: '054cfcd8910389ff64882d8e25211646',
  EventType: 'answered',
  DateCreated: '2022-04-06 10:48:00',
  DateUpdated: '2022-04-06 10:48:09',
  EventTime: '2022-04-06 10:48:09',
  Status: 'in-progress',
  To: '08780296135',
  From: '07874762218',
  PhoneNumberSid: '08044556678',
  StartTime: '2022-04-06 10:48:04',
  EndTime: 'null',
  Direction: 'outbound-api',
  RecordingUrl: null,
  ConversationDuration: null,
  CustomField: 'lead-42',
  Legs: [
    { OnCallDuration: null, Status: 'in-progress' },
    { OnCallDuration: null, Status: 'in-progress' },
  ],
};

/** Ringing event for the first (agent) leg. */
export const ringingLeg1Callback = {
  CallSid: '09c14403fb2a31097ba5ed64f9251646',
  EventType: 'ringing',
  DateCreated: '2022-04-06 10:44:40',
  DateUpdated: '2022-04-06 10:44:41',
  Status: 'in-progress',
  To: '08780296135',
  From: '07874762218',
  PhoneNumberSid: '08044556678',
  StartTime: '2022-04-06 10:44:41',
  EndTime: null,
  EventTime: '2022-04-06 10:44:41',
  Direction: 'outbound-api',
  RecordingUrl: null,
  ConversationDuration: null,
  Legs: [
    { OnCallDuration: null, Status: 'in-progress' },
    { OnCallDuration: null, Status: null },
  ],
};

/** Default StatusCallback (no StatusCallbackEvents subscribed), form-encoded. */
export const defaultCallbackForm =
  'CallSid=80bfbec2d78bbbf10fb851f4fa165211&Status=no-answer&RecordingUrl=&DateUpdated=2026-11-05+18%3A02%3A11';

/** Passthru GET query for an incoming call that went through an IVR (Gather) applet. */
export const passthruIncomingQuery =
  '?CallSid=a1b2c3d4e5f60718293a4b5c6d7e8f90&CallFrom=09876543210&CallTo=08044556678' +
  '&CallStatus=ringing&Direction=incoming&Created=Thu%2C+05+Nov+2026+18%3A10%3A03' +
  '&DialCallDuration=0&StartTime=2026-11-05+18%3A10%3A03&EndTime=1970-01-01+05%3A30%3A00' +
  '&CallType=call-attempt&DialWhomNumber=&From=09876543210&To=08044556678' +
  '&CurrentTime=2026-11-05+18%3A10%3A09&digits=%222%22';

/** Passthru after a Connect applet (form keys with brackets), outgoing flow call. */
export const passthruAfterConnectQuery =
  'CallSid=f0e1d2c3b4a5968778695a4b3c2d1e0f&CallFrom=09123456789&CallTo=09876543210' +
  '&CallStatus=completed&Direction=outbound-dial&StartTime=2026-11-05+11%3A00%3A00' +
  '&EndTime=1970-01-01+05%3A30%3A00&CallType=completed&DialWhomNumber=09123456789' +
  '&DialCallStatus=completed&DialCallDuration=48&CustomField=lead-77&OutgoingPhoneNumber=08044556678' +
  '&RecordingUrl=https%3A%2F%2Frecordings.exotel.com%2Fexotelrecordings%2Fphoenixedu1%2Ff0e1.mp3' +
  '&Legs%5B0%5D%5BCauseCode%5D=NORMAL_CLEARING&Legs%5B0%5D%5BCause%5D=16&Legs%5B0%5D%5BType%5D=single' +
  '&Legs%5B0%5D%5BOnCallDuration%5D=21&Legs%5B0%5D%5BNumber%5D=07200498123' +
  '&CurrentTime=2026-11-05+11%3A01%3A10';

/** Connect applet agent pass-through (GET). */
export const connectAppletQuery =
  'CallSid=a1b2c3d4e5f60718293a4b5c6d7e8f90&CallFrom=09876543210&CallTo=08044556678&Direction=outbound-dial' +
  '&Created=2026-11-05+18%3A10%3A15&From=09876543210&To=08044556678&CurrentTime=2026-11-05+18%3A10%3A16' +
  '&DialWhomNumber=09123456789&Status=busy&EventType=Dial';
