# Scheduling core

The scheduling engine in `apps/api/src/core/scheduling/` works out booking slots across time zones, picks a host, writes calendar invitations and decides when to send reminders. It is pure JavaScript: no I/O, no database, no clock reads, and no libraries apart from zod. Callers load the data, pass `now` in, and store the results. Phase 6 (scheduling) builds its routes, tables and jobs on top of it.

```js
import { generateSlots, chooseHost, buildInvite, computeReminders } from '../core/scheduling/index.js';
```

| File | What it does |
| --- | --- |
| `tz.js` | Zone validation, offsets, wall clock ↔ UTC with DST rules, local-date arithmetic, formatting |
| `slots.js` | `generateSlots`, `checkSlot`, `groupSlotsByLocalDate`, the zod schemas for event types and hosts |
| `roundRobin.js` | `chooseHost`, `recordAssignment` |
| `ics.js` | `buildInvite` (iTIP REQUEST and CANCEL), escaping, folding, `icsContentType` |
| `reminders.js` | `computeReminders`, `quietWindowAt`, `reminderJobId` |
| `errors.js` | `SchedulingInputError` (has `issues: [{ path, message }]`), `parseInput` |

## Conventions

- **Instants** are UTC, given as epoch milliseconds, `Date` objects or ISO 8601 strings that include `Z` or an offset. A string without an offset, such as `2026-11-09T10:00:00`, is refused because it does not name an instant. Results are ISO strings ending in `Z`.
- **Zones** are IANA names. `normalizeTimeZone` returns the current spelling and accepts any letter case and old aliases: `asia/calcutta` → `Asia/Kolkata`, `US/Eastern` → `America/New_York`, `Etc/UTC` → `UTC`. It refuses offsets (`+05:30`) and abbreviations (`IST` could mean India, Ireland or Israel, and `EST` is a fixed-offset legacy zone). Store the normalised name.
- **Local dates** are `YYYY-MM-DD` and **clocks** are `HH:MM`. `24:00` is allowed only as the end of a range.
- **Validation.** Each entry point parses its input with an exported zod schema and throws `SchedulingInputError` with field paths. Routes can call `parseOrThrow(generateSlotsInputSchema, body)` first to return a 422 response in the API's usual format.

## tz.js

| Function | Returns |
| --- | --- |
| `toEpochMs(instant)` / `toIso(instant)` | epoch ms / ISO string. Throws on naive strings |
| `normalizeTimeZone(name)`, `isValidTimeZone(name)`, `assertTimeZone(name)` | current IANA name or null / boolean / name, or a RangeError |
| `offsetMinutesAt(zone, instant)` | minutes east of UTC (Kolkata 330, Kathmandu 345, New York −300 or −240) |
| `toZonedParts(instant, zone)` | `{ year, month, day, hour, minute, second, millisecond, weekday, weekdayKey, offsetMinutes, date, time, timeZone }` |
| `localToUtc(date, time, zone, { disambiguation })` / `localToUtcIso` | the instant for a wall-clock time |
| `inspectLocalTime(date, time, zone)` | `{ status: 'valid'｜'gap'｜'overlap', instants, offsetBeforeMinutes, offsetAfterMinutes, gapMinutes }` |
| `startOfLocalDay`, `localDayLengthMinutes` | first instant of a date; 1380 or 1500 minutes on DST days |
| `parseLocalDate`, `isLocalDate`, `addDays`, `weekdayOf`, `daysBetween`, `parseClock`, `formatClock` | calendar helpers that never touch a zone |
| `formatOffset(330)` → `+05:30`; `toZonedIsoString` → `2026-11-05T17:30:00+05:30` | |
| `formatInZone(instant, zone, { locale, ...Intl options })` | `5 Nov 2026, 5:30 pm` (default locale en-IN) |
| `zoneDisplayName(zone, instant, { style })`, `zoneLabel(zone, instant)` | `India Standard Time`; `(GMT+05:30) Asia/Kolkata` for zone pickers |

**How offsets are found.** `Intl.DateTimeFormat#formatToParts` (with `hourCycle: 'h23'`) gives the wall-clock reading of an instant in a zone. The offset is that reading, taken as if it were UTC, minus the instant. Formatters are cached per zone. The IANA rules are the copy built into Node (`process.versions.tz`; Node 24.22 ships 2026e). New government rule changes arrive with Node upgrades.

**Wall clock to UTC.** The engine reads the zone's offsets a day before and a day after the local time. It also reads the offset at a naive guess, to catch two transitions close together. Each offset that maps back to itself gives a candidate instant. No candidate means a gap and two mean an overlap. The `disambiguation` option decides what happens then:

| Policy | Gap (time does not exist) | Overlap (time happens twice) |
| --- | --- | --- |
| `compatible` (default) | read with the offset before the gap, so it moves forward by the gap length (NY 02:30 → 03:30 EDT) | first occurrence (NY 01:30 → EDT) |
| `earlier` | moves back by the gap length (02:30 → 01:30 EST) | first occurrence |
| `later` | moves forward | second occurrence (01:30 EST) |
| `reject` | RangeError | RangeError |

Source: RFC 5545 §3.3.5, which states the default exactly. The tests check its two New York examples, from 2007. Temporal's `compatible` disambiguation behaves the same way.

## slots.js

```js
generateSlots({
  eventType: { durationMin, slotIntervalMin?, bufferBeforeMin?, bufferAfterMin?, minNoticeMin?,
               maxPerDay?, horizonDays?, alignTimeZone? },
  hosts: [{ id, timeZone, weekly: { mon: ['09:00-13:00', { start: '14:00', end: '18:00' }], ... },
            overrides: { '2026-11-14': 'unavailable', '2026-11-15': ['10:00-12:00'] },
            busy: [{ start, end, bufferBeforeMin?, bufferAfterMin? }],
            bookedCountByDate: { '2026-11-09': 3 } }],
  range: { from, to },      // at most 92 days
  now,
  mode: 'any' | 'all',      // all = every host must be free (panel interviews)
}) → [{ start, end, hostIds }]   // sorted by start; hostIds in the order hosts were given
```

Rules, applied to each host separately in that host's own zone:

1. **Working hours.** A host's day comes from `weekly[sun…sat]`. An entry in `overrides` for that local date replaces the weekly ranges: `'unavailable'`, `null`, `false` or `[]` block the day, and a list of ranges opens it, even on a weekend.
2. **Midnight.** A range whose end is at or before its start runs into the next day (`22:00-01:00`), and `24:00` is the end of the day. A range belongs to the date it starts on, so an override on Saturday does not cut Friday's overnight range. Ranges that touch are merged (`fri 20:00-24:00` and `sat 00:00-02:00`), so a slot can cross midnight.
3. **DST.** Range edges are converted with `localToUtc` (the `compatible` policy), so ranges are real elapsed time. 09:00–17:00 stays 8 hours on a change day, but 00:00–04:00 is 3 hours on the spring-forward day and 5 hours on the fall-back day. On the fall-back day, 01:00 is offered twice, once in each offset.
4. **Grid.** Slot starts step by `slotIntervalMin` (default: the duration) from the start of each merged range, and each slot must fit inside its range. With `alignTimeZone`, every host instead uses one grid: multiples of the interval since local midnight in that zone. Use it for teams whose offsets differ by a non-hour amount (Kolkata +05:30 and Kathmandu +05:45). Without it, those hosts' slots sit 15 minutes apart and never compete in round robin.
5. **Busy time and buffers.** A slot needs `[start − bufferBeforeMin, end + bufferAfterMin)` free of every busy interval. Each busy interval is widened by its own `bufferBeforeMin`/`bufferAfterMin`. Intervals are half-open, so back-to-back meetings are allowed when there are no buffers. A buffer may extend outside working hours (the same as Cal.com).
6. **Notice and horizon.** `start ≥ now + minNoticeMin` and `start ≤ now + horizonDays × 24 h`. Both are instants, not calendar days.
7. **Daily limit.** `maxPerDay` is compared with `bookedCountByDate[local date of the slot start in the host zone]`. 00:30 IST on Tuesday counts against Tuesday although it is Monday in UTC.
8. **Range.** A slot is returned when its start lies in `[range.from, range.to)`.

Also exported:
- `checkSlot({ eventType, hosts, now, start })` → `{ available, start, end, hostIds }`. Run it again when the booking is written, because the list the visitor saw may be stale.
- `groupSlotsByLocalDate(slots, viewerZone)` → `[{ date, slots: [{ ...slot, localTime }] }]` for the booking-page calendar.
- `workingIntervals` and `mergeIntervals`, for availability previews.
- The schemas `generateSlotsInputSchema`, `eventTypeSchema`, `hostSchema`, `weeklyHoursSchema` and `clockRangeSchema`, plus the limits `MAX_RANGE_DAYS = 92` and `MAX_SLOTS = 20000`. The limits keep a public booking page cheap to serve.

## roundRobin.js

```js
chooseHost({
  candidateIds,                 // slot.hostIds: who is free
  hosts: [{ id, weight=1, priority=0, bookingCount=0, lastBookedAt=null, languages=[], timeZone?, active=true }],
  slotStart?,                   // needed for the time-zone band
  preferredHostIds?: ['leadOwnerId', 'partnerCounsellorId'],
  fallback?: 'round_robin' | 'none',
  strategy?: 'weighted' | 'least_recent',
  filters?: { language?: 'hi', timeZoneBand?: { minOffsetMin?, maxOffsetMin? } | { aroundTimeZone, maxDifferenceMin } },
  relaxFilters?: false,
}) → { hostId | null, reason, explanation, preferredFallback, filtersRelaxed, ranking, excluded }
```

The chooser works through these steps in order:

1. **Eligible hosts** are the candidates that are known and active and that pass the filters. The language filter compares primary subtags, so `hi` matches `hi-IN`. The band is checked against each host's offset at `slotStart`, so London counts as +60 in summer and +0 in winter. If no host passes and `relaxFilters` is set, the filters are dropped. `excluded` records why each candidate was left out.
2. **Sticky host.** The first eligible id in `preferredHostIds` wins, even over fairness and priority. Typical entries are the lead's owner and then the partner's counsellor. When none is free, `fallback: 'round_robin'` continues and sets `preferredFallback: true`; `fallback: 'none'` returns `{ hostId: null, reason: 'preferred_unavailable' }`. Preferred hosts must still pass the filters.
3. **Priority.** The highest `priority` tier present wins.
4. **Weighted fairness** (the `weighted` strategy, the default). The lowest `(bookingCount + 1) / weight` wins. This is the D'Hondt quotient, so over time each host's share tends to `weight / Σ weights`. The tests check that weights 2:1:1 over 400 bookings give exactly 200/100/100. A host with weight 0 gets a booking only when no host with a positive weight in the tier is free. The `least_recent` strategy skips this step.
5. **Ties** go to the least recently booked host (never booked first), then to the lowest id. The result depends only on the input, never on its order.

`reason` is `preferred_host`, `round_robin`, `only_candidate`, `no_candidates`, `no_host_matches_filters` or `preferred_unavailable`. `explanation` is a readable sentence for the booking's timeline entry. `recordAssignment(hosts, hostId, at)` returns updated in-memory state for simulations.

**Fairness inputs.** `bookingCount` is the number of confirmed bookings for the team in the fairness window, for example the current month. A new host should be given a calibration value (the team average) so they are not flooded with bookings. `lastBookedAt` is the time the host's latest booking was created. Assignment is online, slot by slot, so when hosts' availability differs the split can be off by one in each direction.

## ics.js

```js
buildInvite({ method: 'REQUEST' | 'CANCEL', uid, sequence, dtstamp, start, end, summary, description?, location?, url?,
              organizer: { email, name? }, attendees: [{ email, name?, role?, partstat?, rsvp? }],
              created?, lastModified?, prodId? }) → string
icsContentType('REQUEST') → 'text/calendar; charset=UTF-8; method=REQUEST'
```

| Rule | Source |
| --- | --- |
| `VERSION:2.0`, `PRODID` and `METHOD` on the VCALENDAR; one VEVENT with `UID`, `DTSTAMP`, `DTSTART`, `ORGANIZER`, `SUMMARY` and at least one `ATTENDEE` | RFC 5546 §3.2.2 (REQUEST) |
| A CANCEL repeats the UID, carries a SEQUENCE higher than the last REQUEST (the engine refuses 0) and sets `STATUS:CANCELLED` | RFC 5546 §3.2.5, §2.1.4 |
| A reschedule is a new REQUEST with the same UID and `sequence + 1` | RFC 5546 §2.1.4, §3.2.2.1 |
| All times are UTC (`20261109T100000Z`), so no VTIMEZONE is needed | RFC 5545 §3.3.5, form 2 |
| TEXT escapes `\\`, `\;`, `\,` and line breaks as `\n`; control characters are dropped | RFC 5545 §3.3.11 |
| Parameter values containing `:`, `;` or `,` are quoted; DQUOTE becomes `'` and line breaks become spaces | RFC 5545 §3.1, §3.2 |
| Lines are folded at 75 octets with CRLF and a space, never inside a UTF-8 character (Hindi, Tamil and emoji are tested) | RFC 5545 §3.1 |
| The UID is a random UUID with no user, host or domain in it | RFC 7986 §5.3 |
| Email part content type carries `method=` | RFC 6047 §2.4 |

Emails and URLs are checked (`calAddress` and http(s) links only), so user text cannot add properties. The tests try header-style injection through the summary, the attendee name, the email, the UID and the URL. `parseContentLines`, `unfold` and `unescapeText` exist for tests and for reading our own output; they are not a general iCalendar parser.

## reminders.js

```js
computeReminders({ start, now, offsetsMin = [1440, 60], timeZone?, quietHours?: { start: '21:00', end: '08:00', shift: 'auto' },
                   minLeadMin = 15, minGapMin = 15 })
  → { reminders: [{ offsetMin, at, shifted: null | 'later' | 'earlier' }], skipped: [{ offsetMin, reason }] }
```

1. Each offset produces `start − offset`. A reminder whose time is at or before `now` is skipped with reason `past`, for example the 24-hour reminder for a booking made 3 hours ahead.
2. Quiet hours apply in the **attendee's** zone, and a window may cross midnight. Its boundary minutes are allowed (21:00 and 08:00 are sendable). With `auto`, a reminder inside the window moves to the end of the window if that is still at least `minLeadMin` before the start. Otherwise it moves to the start of the window, the evening before. `later` and `earlier` allow only one direction. If neither time works, the reminder is skipped with reason `quiet_hours`.
3. Reminders less than `minGapMin` apart collapse into one. The engine keeps the one whose offset best matches its real lead time and skips the other with reason `duplicate`.
4. `reminderJobId(bookingId, offsetMin, sequence)` returns `reminder-<booking>-s<sequence>-m<offset>`. BullMQ refuses `:` in custom job ids. Adding the booking sequence means a reschedule never collides with old jobs.

## How features use it (phase 6)

The engine needs no tables, but its inputs suggest the following persistence contract.

- `scheduling_event_types`: unit_id, slug, duration and buffer minutes, min notice, max per day, horizon, slot interval, align zone, assignment (`round_robin` | `collective` | `single`), and reminder offsets.
- `scheduling_hosts`: event type and user, weight, priority, languages, and active.
- `user_availability`: user, `time_zone` (normalised), weekly JSONB, overrides JSONB.
- `bookings`: `start_at`/`end_at timestamptz`, `host_user_id`, `status`, `attendee_time_zone`, `ics_uid uuid` (from `crypto.randomUUID()`), `ics_sequence int`, the lead or contact id, and `assignment_reason` (from `explanation`). To make double booking impossible in the database as well, add `EXCLUDE USING gist (host_user_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status = 'confirmed')`, which needs `btree_gist`.

**Booking page.** Load the event type, its hosts' availability and their busy time for the range: confirmed bookings, plus external calendars once phase 3 connectors exist. Then call `generateSlots` and group the result with `groupSlotsByLocalDate(slots, visitorZone)`. Pass the visitor's zone from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) after `normalizeTimeZone`.

**Create a booking.** Inside one transaction:
1. Lock the hosts' rows.
2. Call `checkSlot` with fresh busy data.
3. Call `chooseHost` with `slot.hostIds`, `preferredHostIds: [lead.ownerId, partner.counsellorId]`, and fairness counts from `bookings`.
4. Insert the booking, `writeAudit` and `emitEvent('booking.created')`.

After the commit, email `buildInvite({ method: 'REQUEST', sequence: 0 })` and enqueue each item from `computeReminders` with `jobId: reminderJobId(...)` and a `delay`.

**Reschedule.** Bump `ics_sequence` and send a REQUEST with the same UID. Remove the old reminder jobs and enqueue new ones.

**Cancel.** Bump `ics_sequence` and send a CANCEL. Remove the reminder jobs.

**Settings.** The following module settings would feed the engine: `scheduling.quiet_hours` (company level), `scheduling.reminder_offsets` and `scheduling.fairness_window`.

## Limits and known gaps

- There are no recurring events (RRULE or RECURRENCE-ID), VALARM, VTIMEZONE, or REPLY/COUNTER processing. Invitations are outbound only.
- The DST search assumes at most one transition within a day of the local time, plus the case that the naive-guess offset catches. No IANA zone currently breaks this.
- Zone rules are only as current as the running Node build. Check `process.versions.tz` after upgrades.
- Minimum notice and the horizon count elapsed time, not business days.
- Round robin assigns one booking at a time and does not plan ahead.

## Tests

`apps/api/test/scheduling/` contains tz, slots, roundRobin, ics and reminders tests: 85 in total. They cover:
- the DST gap and overlap in America/New_York, Europe/London, Australia/Sydney and Lord Howe (a 30-minute shift);
- Chile's midnight transition and the day Samoa skipped;
- Asia/Kolkata (+05:30) and Asia/Kathmandu (+05:45), every minute of a day;
- a year-long round trip in six zones, and every zone Intl knows normalising to itself;
- slots crossing midnight, buffers, minimum notice, horizon, daily limits and overrides;
- mixed-zone teams, weighted fairness simulations, and ICS folding, escaping and injection.

Run them with:

```
cd apps/api && node --test "test/scheduling/*.test.js"
```

The quoted glob is required: in Node 24 on Windows, `node --test test/scheduling/` fails with "Cannot find module".
