import { validate } from '../../lib/validate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { describe } from '../../core/openapi/describe.js';
import {
  publicBook,
  publicBooking,
  publicCancel,
  publicIcs,
  publicManageSlots,
  publicPage,
  publicReschedule,
  publicRescheduleRequest,
  publicSlots,
} from './public.js';
import { publicBookBody, publicCancelBody, publicRescheduleBody, rescheduleRequestBody, slotsQuery, tokenParams } from './schemas.js';
import { icsContentType } from '../../core/scheduling/index.js';

// Public booking-page endpoints: no session, the signed token is the credential, rate limited per
// IP (and per token for writes) in Redis so the limits hold across API instances. Writes still need
// the X-Phoenix-Client header (the CSRF rule), which the booking page sends.

const ip = (req) => req.ip ?? 'unknown';
const tokenKey = (req) => String(req.params?.token ?? '').slice(0, 24);

export const PUBLIC_LIMITS = Object.freeze({
  read: { limit: 300, windowSeconds: 900 },
  book: { limit: 10, windowSeconds: 900 },
  bookPerToken: { limit: 20, windowSeconds: 900 },
  manage: { limit: 30, windowSeconds: 900 },
});

const readLimit = rateLimit({ name: 'sched-read', ...PUBLIC_LIMITS.read, key: ip });
const bookLimit = rateLimit({ name: 'sched-book', ...PUBLIC_LIMITS.book, key: ip });
const bookTokenLimit = rateLimit({ name: 'sched-book-token', ...PUBLIC_LIMITS.bookPerToken, key: tokenKey });
const manageLimit = rateLimit({ name: 'sched-manage', ...PUBLIC_LIMITS.manage, key: ip });

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}

export function schedulingPublicRoutes(router) {
  router.get('/public/booking/:token', describe({ summary: "Open a booking page", auth: 'public', rateLimited: true, errors: [410] }), noStore, readLimit, validate({ params: tokenParams }), async (req, res) => {
    res.json({ data: await publicPage(req.valid.params.token) });
  });

  router.get('/public/booking/:token/slots', describe({ summary: "Free times on a booking page", auth: 'public', rateLimited: true, errors: [410] }), noStore, readLimit, validate({ params: tokenParams, query: slotsQuery }), async (req, res) => {
    res.json({ data: await publicSlots(req.valid.params.token, req.valid.query, { log: req.log }) });
  });

  router.post(
    '/public/booking/:token/book',
    describe({ summary: 'Book a time', auth: 'public', status: 201, rateLimited: true, errors: [409, 410], description: 'Re-checks the time inside a transaction (host locks and an exclusion constraint), picks the host (deal owner first, then weighted round robin), finds or creates the contact and plans reminders. Idempotent on idempotencyKey. Emits booking.created.' }),
    noStore,
    bookLimit,
    bookTokenLimit,
    validate({ params: tokenParams, body: publicBookBody }),
    async (req, res) => {
      res.status(201).json({ data: await publicBook(req.valid.params.token, req.valid.body, { log: req.log }) });
    },
  );

  router.get('/public/bookings/:token', describe({ summary: "Open a booking from its manage link", auth: 'public', rateLimited: true, errors: [410] }), noStore, readLimit, validate({ params: tokenParams }), async (req, res) => {
    res.json({ data: await publicBooking(req.valid.params.token) });
  });

  router.get('/public/bookings/:token/slots', describe({ summary: "Free times for moving a booking (manage link)", auth: 'public', rateLimited: true, errors: [409, 410] }), noStore, readLimit, validate({ params: tokenParams, query: slotsQuery }), async (req, res) => {
    res.json({ data: await publicManageSlots(req.valid.params.token, req.valid.query, { log: req.log }) });
  });

  router.post(
    '/public/bookings/:token/reschedule',
    describe({ summary: 'Move a booking (manage link)', auth: 'public', rateLimited: true, errors: [409, 410], description: 'Emits booking.rescheduled.' }),
    noStore,
    manageLimit,
    validate({ params: tokenParams, body: publicRescheduleBody }),
    async (req, res) => {
      res.json({ data: await publicReschedule(req.valid.params.token, req.valid.body, { log: req.log }) });
    },
  );

  router.post('/public/bookings/:token/cancel', describe({ summary: "Cancel a booking (manage link)", auth: 'public', rateLimited: true, errors: [409, 410] }), noStore, manageLimit, validate({ params: tokenParams, body: publicCancelBody }), async (req, res) => {
    res.json({ data: await publicCancel(req.valid.params.token, req.valid.body, { log: req.log }) });
  });

  router.post(
    '/public/bookings/:token/reschedule-request',
    describe({ summary: 'Ask the team for another time (manage link)', auth: 'public', rateLimited: true, errors: [409, 410], description: 'Emits booking.reschedule_requested.' }),
    noStore,
    manageLimit,
    validate({ params: tokenParams, body: rescheduleRequestBody }),
    async (req, res) => {
      res.json({ data: await publicRescheduleRequest(req.valid.params.token, req.valid.body) });
    },
  );

  router.get('/public/bookings/:token/invite.ics', describe({ summary: "Download the calendar invitation", auth: 'public', rateLimited: true, errors: [410], responses: { 200: { description: 'text/calendar (iTIP REQUEST, or CANCEL once cancelled)', raw: true } } }), noStore, readLimit, validate({ params: tokenParams }), async (req, res) => {
    const { ics, method, filename } = await publicIcs(req.valid.params.token);
    res.set('Content-Type', icsContentType(method));
    res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9.-]/gi, '-')}"`);
    res.send(ics);
  });
}
