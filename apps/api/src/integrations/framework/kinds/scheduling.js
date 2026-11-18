import { z } from 'zod';
import { defineKind, e164, email, isoTime, optionalReference, timeZone } from './common.js';

// Calls, meetings and calendars.

const callStatus = z.enum(['queued', 'ringing', 'in_progress', 'completed', 'busy', 'no_answer', 'failed', 'canceled']);

export const calling = defineKind({
  key: 'calling',
  label: 'Calls',
  description: 'Click-to-call (rings the counsellor first, then the customer), call records and recordings, incoming call events.',
  methods: {
    startCall: {
      description: 'Connect an agent to a customer. The agent phone rings first; the customer sees the connection caller id.',
      input: z.strictObject({
        agentPhone: e164,
        customerPhone: e164,
        callerId: z.string().min(5).max(20).optional().describe("Defaults to the connection's number"),
        record: z.boolean().optional(),
        reference: optionalReference,
      }),
      output: z.object({ providerCallId: z.string().min(1), status: callStatus, startedAt: isoTime }),
    },
    getCall: {
      description: 'The current state of a call.',
      input: z.strictObject({ providerCallId: z.string().min(1).max(200) }),
      output: z.object({
        providerCallId: z.string(),
        status: callStatus,
        direction: z.enum(['outbound', 'inbound']),
        from: z.string(),
        to: z.string(),
        startedAt: isoTime,
        answeredAt: isoTime.nullable(),
        endedAt: isoTime.nullable(),
        durationSeconds: z.number().int().min(0),
        recordingAvailable: z.boolean(),
      }),
    },
    getRecording: {
      description: 'A short-lived link to the recording of a finished call.',
      input: z.strictObject({ providerCallId: z.string().min(1).max(200) }),
      output: z.object({ url: z.string().url(), contentType: z.string(), expiresAt: isoTime.nullable() }),
    },
  },
  webhooks: {
    description: 'Call status callbacks and incoming-call (passthru) requests.',
    events: {
      'call.incoming': '{ providerCallId, from, to }',
      'call.answered': '{ providerCallId, from, to, answeredAt }',
      'call.completed': '{ providerCallId, from, to, status, durationSeconds, recordingAvailable }',
      'call.missed': '{ providerCallId, from, to }',
    },
  },
  sample: {
    method: 'startCall',
    input: () => ({ agentPhone: '+919000000002', customerPhone: '+919000000001' }),
  },
});

const person = z.strictObject({ email, name: z.string().min(1).max(200).optional() });

export const meetings = defineKind({
  key: 'meetings',
  label: 'Meetings',
  description: 'Video meeting links for demos and counselling sessions, and who attended for how long.',
  methods: {
    createMeeting: {
      description: 'Create a meeting and return its join link.',
      input: z.strictObject({
        topic: z.string().min(1).max(200),
        startAt: isoTime,
        durationMinutes: z.number().int().min(1).max(1440),
        timeZone,
        hostEmail: email.optional(),
        attendees: z.array(person).max(100).default([]),
        reference: optionalReference,
      }),
      output: z.object({
        providerMeetingId: z.string().min(1),
        joinUrl: z.string().url(),
        hostUrl: z.string().url().nullable(),
        passcode: z.string().nullable(),
        startAt: isoTime,
      }),
    },
    cancelMeeting: {
      description: 'Cancel a scheduled meeting. Cancelling one that is already gone is not an error.',
      input: z.strictObject({ providerMeetingId: z.string().min(1).max(200) }),
      output: z.object({ canceled: z.literal(true) }),
    },
    getAttendance: {
      description: 'Who joined a finished meeting and for how long (overlapping sessions of one person merged).',
      input: z.strictObject({ providerMeetingId: z.string().min(1).max(200) }),
      output: z.object({
        providerMeetingId: z.string(),
        endedAt: isoTime.nullable(),
        participants: z.array(
          z.object({
            name: z.string(),
            email: z.string().nullable(),
            joinedAt: isoTime,
            leftAt: isoTime.nullable(),
            durationSeconds: z.number().int().min(0),
          }),
        ),
        totalSeconds: z.number().int().min(0),
      }),
    },
  },
  webhooks: {
    description: 'Meeting lifecycle and participant events (Zoom signs them; Meet arrives through Google push channels).',
    events: {
      'meeting.started': '{ providerMeetingId, startedAt }',
      'meeting.ended': '{ providerMeetingId, endedAt }',
      'participant.joined': '{ providerMeetingId, name, email?, joinedAt }',
      'participant.left': '{ providerMeetingId, name, email?, leftAt }',
      'recording.ready': '{ providerMeetingId, recordingId }',
    },
  },
  sample: {
    method: 'createMeeting',
    input: ({ now }) => ({
      topic: 'Connection check',
      startAt: new Date(now() + 86_400_000).toISOString(),
      durationMinutes: 30,
      timeZone: 'Asia/Kolkata',
    }),
  },
});

export const calendar = defineKind({
  key: 'calendar',
  label: 'Calendars',
  description: "Read counsellors' busy times and put bookings on their calendars.",
  methods: {
    listBusy: {
      description: 'Busy intervals on a calendar between two times (at most 62 days).',
      input: z
        .strictObject({ calendarId: z.string().min(1).max(320).default('primary'), from: isoTime, to: isoTime })
        .refine((r) => Date.parse(r.to) > Date.parse(r.from), { message: 'to must be after from', path: ['to'] })
        .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 62 * 86_400_000, { message: 'At most 62 days', path: ['to'] }),
      output: z.object({ busy: z.array(z.object({ start: isoTime, end: isoTime })) }),
    },
    createEvent: {
      description: 'Add an event. With conference: true the provider attaches a meeting link (Meet or Teams).',
      input: z.strictObject({
        calendarId: z.string().min(1).max(320).default('primary'),
        title: z.string().min(1).max(300),
        description: z.string().max(8000).optional(),
        startAt: isoTime,
        endAt: isoTime,
        timeZone,
        attendees: z.array(person).max(100).default([]),
        location: z.string().max(500).optional(),
        conference: z.boolean().default(false),
        reference: optionalReference,
      }),
      output: z.object({ providerEventId: z.string().min(1), htmlLink: z.string().url().nullable(), conferenceUrl: z.string().url().nullable() }),
    },
    updateEvent: {
      description: 'Move or rename an event.',
      input: z.strictObject({
        calendarId: z.string().min(1).max(320).default('primary'),
        providerEventId: z.string().min(1).max(1024),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(8000).optional(),
        startAt: isoTime.optional(),
        endAt: isoTime.optional(),
        timeZone: timeZone.optional(),
      }),
      output: z.object({ providerEventId: z.string().min(1) }),
    },
    deleteEvent: {
      description: 'Remove an event. Removing one that is already gone is not an error.',
      input: z.strictObject({ calendarId: z.string().min(1).max(320).default('primary'), providerEventId: z.string().min(1).max(1024) }),
      output: z.object({ deleted: z.literal(true) }),
    },
  },
  webhooks: {
    description: 'Change notifications (Google push channels, Microsoft Graph subscriptions with a validationToken handshake).',
    events: { 'calendar.changed': '{ calendarId, resourceId? }' },
  },
  sample: {
    method: 'listBusy',
    input: ({ now }) => ({ from: new Date(now()).toISOString(), to: new Date(now() + 7 * 86_400_000).toISOString() }),
  },
});
