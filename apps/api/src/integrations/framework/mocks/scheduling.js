import { createHash } from 'node:crypto';
import { IntegrationError } from '../errors.js';
import { calendar, calling, meetings } from '../kinds/scheduling.js';
import { callKey, healthFor, iso, maybeFail, mockWebhookMethods, stableId } from './common.js';

// Mock calls, meetings and calendars. State lives in the sandbox outbox: getCall, getAttendance
// and listBusy read back what the mock recorded, so the mocks behave consistently across the API
// and worker processes without a table of their own.

/** A deterministic integer in [min, max] from a string. */
export function hashInt(value, min, max) {
  const n = createHash('sha256').update(value).digest().readUInt32BE(0);
  return min + (n % (max - min + 1));
}

const notFound = (ctx, what) =>
  new IntegrationError('integration_provider_error', `The mock has no ${what} with that id`, {
    kind: ctx.connection.kind,
    provider: 'mock',
    details: { reason: 'not_found' },
  });

const addSeconds = (date, seconds) => new Date(new Date(date).getTime() + seconds * 1000).toISOString();

export function createCallingMock(ctx) {
  const callerId = () => ctx.config.callerId || '+918000000000';
  const adapter = {
    kind: calling.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async startCall(input) {
      maybeFail(ctx, 'startCall');
      const providerCallId = stableId('mock-call', ctx.connection.id, callKey(input));
      await ctx.record({
        operation: 'startCall',
        recipient: input.customerPhone,
        subject: `Call from ${input.callerId ?? callerId()}`,
        body: `Rings ${input.agentPhone} first, then ${input.customerPhone}`,
        providerRef: providerCallId,
        status: 'queued',
        payload: { ...input, record: input.record ?? ctx.config.record === true },
      });
      return { providerCallId, status: 'queued', startedAt: iso(ctx.now) };
    },
    /** Every mock call is answered after 8 s and lasts 1 to 15 minutes (from its id). */
    async getCall({ providerCallId }) {
      const row = await ctx.findRecord({ providerRef: providerCallId, operation: 'startCall' });
      if (!row) throw notFound(ctx, 'call');
      const startedAt = new Date(row.created_at).toISOString();
      const durationSeconds = hashInt(providerCallId, 60, 900);
      const answeredAt = addSeconds(startedAt, 8);
      const endedAt = addSeconds(answeredAt, durationSeconds);
      const finished = Date.parse(endedAt) <= ctx.now();
      return {
        providerCallId,
        status: finished ? 'completed' : 'in_progress',
        direction: 'outbound',
        from: row.payload?.callerId ?? callerId(),
        to: row.recipient,
        startedAt,
        answeredAt,
        endedAt: finished ? endedAt : null,
        durationSeconds: finished ? durationSeconds : 0,
        recordingAvailable: finished && row.payload?.record === true,
      };
    },
    async getRecording({ providerCallId }) {
      const call = await adapter.getCall({ providerCallId });
      if (!call.recordingAvailable) throw notFound(ctx, 'recording');
      return {
        url: `https://recordings.mock.phoenix.invalid/${encodeURIComponent(providerCallId)}.mp3`,
        contentType: 'audio/mpeg',
        expiresAt: new Date(ctx.now() + 3_600_000).toISOString(),
      };
    },
    ...mockWebhookMethods(ctx, calling),
  };
  return adapter;
}

export function createMeetingsMock(ctx) {
  return {
    kind: meetings.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async createMeeting(input) {
      maybeFail(ctx, 'createMeeting');
      const providerMeetingId = stableId('mock-mtg', ctx.connection.id, callKey(input));
      const passcode = String(hashInt(providerMeetingId, 100000, 999999));
      await ctx.record({
        operation: 'createMeeting',
        recipient: input.attendees.map((a) => a.email).join(', ') || null,
        subject: input.topic,
        body: `${input.startAt} for ${input.durationMinutes} min (${input.timeZone})`,
        providerRef: providerMeetingId,
        status: 'scheduled',
        payload: input,
      });
      return {
        providerMeetingId,
        joinUrl: `https://meet.mock.phoenix.invalid/j/${providerMeetingId}`,
        hostUrl: `https://meet.mock.phoenix.invalid/h/${providerMeetingId}`,
        passcode,
        startAt: new Date(input.startAt).toISOString(),
      };
    },
    async cancelMeeting({ providerMeetingId }) {
      maybeFail(ctx, 'cancelMeeting');
      await ctx.record({ operation: 'cancelMeeting', recipient: null, subject: 'Meeting cancelled', body: null, providerRef: providerMeetingId, status: 'cancelled', payload: { providerMeetingId } });
      return { canceled: true };
    },
    /**
     * After the scheduled end, every attendee "joined" one minute late and stayed for a share of
     * the meeting fixed by their email (20% to 100%), so attendance thresholds can be tested.
     */
    async getAttendance({ providerMeetingId }) {
      const row = await ctx.findRecord({ providerRef: providerMeetingId, operation: 'createMeeting' });
      if (!row) throw notFound(ctx, 'meeting');
      const { startAt, durationMinutes, attendees = [], hostEmail } = row.payload ?? {};
      const endedAt = addSeconds(startAt, durationMinutes * 60);
      if (Date.parse(endedAt) > ctx.now()) return { providerMeetingId, endedAt: null, participants: [], totalSeconds: 0 };
      const people = [{ name: 'Host', email: hostEmail ?? null }, ...attendees.map((a) => ({ name: a.name ?? a.email, email: a.email }))];
      const participants = people.map((person) => {
        const share = person.name === 'Host' ? 100 : hashInt(`${providerMeetingId}:${person.email}`, 20, 100);
        const durationSeconds = Math.max(60, Math.floor((durationMinutes * 60 * share) / 100) - 60);
        const joinedAt = addSeconds(startAt, 60);
        return { name: person.name, email: person.email, joinedAt, leftAt: addSeconds(joinedAt, durationSeconds), durationSeconds };
      });
      return { providerMeetingId, endedAt, participants, totalSeconds: participants.reduce((sum, p) => sum + p.durationSeconds, 0) };
    },
    ...mockWebhookMethods(ctx, meetings),
  };
}

const DAY = 86_400_000;

export function createCalendarMock(ctx) {
  return {
    kind: calendar.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    /** Busy: 12:00 to 13:00 IST (06:30 to 07:30 UTC) every day, plus events created through this mock and not deleted. */
    async listBusy({ calendarId, from, to }) {
      maybeFail(ctx, 'listBusy');
      const start = Date.parse(from);
      const end = Date.parse(to);
      const busy = [];
      for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
        const blockStart = day + 6.5 * 3_600_000;
        const blockEnd = blockStart + 3_600_000;
        if (blockEnd > start && blockStart < end) busy.push({ start: new Date(Math.max(blockStart, start)).toISOString(), end: new Date(Math.min(blockEnd, end)).toISOString() });
      }
      const [created, deleted] = await Promise.all([ctx.listRecords({ operation: 'createEvent' }), ctx.listRecords({ operation: 'deleteEvent' })]);
      const gone = new Set(deleted.map((row) => row.provider_ref));
      for (const row of created) {
        const p = row.payload ?? {};
        if (gone.has(row.provider_ref) || (p.calendarId ?? 'primary') !== calendarId) continue;
        const s = Date.parse(p.startAt);
        const e = Date.parse(p.endAt);
        if (e > start && s < end) busy.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      }
      busy.sort((a, b) => a.start.localeCompare(b.start));
      return { busy };
    },
    async createEvent(input) {
      maybeFail(ctx, 'createEvent');
      const providerEventId = stableId('mock-evt', ctx.connection.id, callKey(input));
      await ctx.record({
        operation: 'createEvent',
        recipient: input.attendees.map((a) => a.email).join(', ') || null,
        subject: input.title,
        body: `${input.startAt} to ${input.endAt} (${input.timeZone})`,
        providerRef: providerEventId,
        status: 'confirmed',
        payload: input,
      });
      return {
        providerEventId,
        htmlLink: `https://calendar.mock.phoenix.invalid/e/${providerEventId}`,
        conferenceUrl: input.conference ? `https://meet.mock.phoenix.invalid/j/${providerEventId}` : null,
      };
    },
    async updateEvent(input) {
      maybeFail(ctx, 'updateEvent');
      await ctx.record({ operation: 'updateEvent', recipient: null, subject: input.title ?? 'Event updated', body: null, providerRef: input.providerEventId, status: 'confirmed', payload: input });
      return { providerEventId: input.providerEventId };
    },
    async deleteEvent(input) {
      maybeFail(ctx, 'deleteEvent');
      await ctx.record({ operation: 'deleteEvent', recipient: null, subject: 'Event deleted', body: null, providerRef: input.providerEventId, status: 'deleted', payload: input });
      return { deleted: true };
    },
    ...mockWebhookMethods(ctx, calendar),
  };
}
