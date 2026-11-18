import { z } from 'zod';

/**
 * Descriptions of the phase 1 routes, keyed "METHOD /express/path".
 *
 * Phase 1 routes were written before describe() existed. Keeping their documentation here means
 * the module files stay exactly as they are (and merge cleanly with work happening in parallel).
 * New modules put describe({...}) on the route itself instead; a route's own describe() wins over
 * an entry here. test/openapi/app.test.js fails if a phase 1 route has no entry or an entry
 * matches no route, so this list can't drift.
 *
 * Request shapes come from each route's validate() schemas; only what those can't say lives here.
 */

const ok = (shape, description) => ({ schema: z.object(shape), ...(description ? { description } : {}) });
const timestamp = () => z.iso.datetime({ offset: true });
const health = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.object({ database: z.enum(['ok', 'down']), redis: z.enum(['ok', 'down']) }),
});

/** @type {Record<string, import('./describe.js').RouteDescription>} */
export const PHASE1_DESCRIPTIONS = {
  // ---------- System ----------
  'GET /health': {
    summary: 'Check the API is up',
    description: 'Answers 503 when the database or Redis is down. Also served at `/health` outside `/api/v1` for load balancers.',
    auth: 'public',
    errors: [503],
    responses: {
      200: {
        raw: true,
        description: 'The API and its dependencies are healthy.',
        schema: health,
      },
      503: { raw: true, description: 'Degraded: `checks` shows which dependency is down.', schema: health },
    },
  },
  'GET /meta': {
    summary: 'Describe this installation',
    description: 'The API version, installed modules, unit types and the permission catalogue.',
  },

  // ---------- Sign-in ----------
  'POST /auth/login': {
    summary: 'Sign in with email and password',
    description:
      'Sets the session cookie. When `mfaRequired` is true, the session can only call `GET /auth/me` and `POST /auth/mfa/verify` until the code is verified. Rate limited to 10 attempts per 15 minutes per IP and email.',
    auth: 'public',
    rateLimited: true,
    responses: { 200: ok({ mfaRequired: z.boolean() }, 'Signed in; the session cookie is set.') },
  },
  'POST /auth/logout': {
    summary: 'Sign out this device',
    description: 'Revokes the current session and clears the cookie. Safe to call when already signed out.',
    auth: 'optional',
    status: 204,
  },
  'GET /auth/me': {
    summary: 'Get the signed-in user, their roles and visible units',
    description:
      'The starting point for clients: the user, the session state (`mfaPending`, `mfaSetupRequired`), role assignments, visible units and permission grants per unit. Works while a two-step code is still pending (lists are then empty).',
  },

  // ---------- Two-step verification ----------
  'POST /auth/mfa/verify': {
    summary: 'Complete sign-in with a two-step code',
    description: 'Accepts an authenticator code (each code once) or a one-time recovery code. 8 attempts per 15 minutes per session.',
    rateLimited: true,
    errors: [400],
    responses: { 200: ok({ verified: z.literal(true), method: z.enum(['totp', 'recovery_code']) }) },
  },
  'POST /auth/mfa/setup': {
    summary: 'Start setting up two-step verification',
    description: 'Creates a pending authenticator secret. Show `qrDataUrl` (or `secret`) to the user, then confirm with `POST /auth/mfa/enable`.',
    errors: [409],
    responses: { 200: ok({ secret: z.string(), otpauthUrl: z.string(), qrDataUrl: z.string() }) },
  },
  'POST /auth/mfa/enable': {
    summary: 'Turn on two-step verification',
    description: 'Confirms the pending secret with a code. Returns 8 recovery codes, shown once. Signs out the user’s other devices.',
    rateLimited: true,
    errors: [409],
    responses: { 200: ok({ recoveryCodes: z.array(z.string()) }, 'Two-step verification is on. Store the recovery codes now.') },
  },
  'POST /auth/mfa/disable': {
    summary: 'Turn off two-step verification',
    description: 'Needs the password and a current code. Refused when a policy requires two-step verification.',
    rateLimited: true,
    errors: [400],
    responses: { 200: ok({ disabled: z.literal(true) }) },
  },
  'POST /auth/mfa/recovery-codes': {
    summary: 'Replace the recovery codes',
    description: 'Needs the password. The old codes stop working.',
    errors: [400],
    responses: { 200: ok({ recoveryCodes: z.array(z.string()) }) },
  },

  // ---------- Passwords ----------
  'POST /auth/password/change': {
    summary: 'Change your password',
    description: 'Needs the current password. Signs out the user’s other devices.',
    responses: { 200: ok({ otherSessionsSignedOut: z.number().int() }) },
  },
  'POST /auth/password/forgot': {
    summary: 'Email a password reset link',
    description: 'Always answers `sent: true`, whether or not the email has an account, so accounts can’t be discovered. 5 requests per hour per IP. The link expires in 1 hour.',
    auth: 'public',
    rateLimited: true,
    responses: { 200: ok({ sent: z.literal(true) }) },
  },
  'POST /auth/password/reset': {
    summary: 'Set a new password with a reset link',
    description: 'Uses the token from the reset email once, then signs out every session. 20 attempts per 15 minutes per IP.',
    auth: 'public',
    rateLimited: true,
    errors: [404],
    responses: { 200: ok({ reset: z.literal(true) }) },
  },

  // ---------- Invitations ----------
  'GET /auth/invites/:token': {
    summary: 'Look up an invitation',
    description: 'For the accept page: who is invited and by whom. 404 when the token is unknown, used or expired.',
    auth: 'public',
    rateLimited: true,
    responses: { 200: ok({ email: z.string(), name: z.string(), invitedBy: z.string().nullable() }) },
  },
  'POST /auth/invites/accept': {
    summary: 'Accept an invitation and set a password',
    description: 'Activates the account. The token works once and expires 7 days after it was sent.',
    auth: 'public',
    rateLimited: true,
    errors: [404],
    responses: { 200: ok({ activated: z.literal(true) }) },
  },

  // ---------- Devices ----------
  'GET /auth/sessions': {
    summary: 'List your signed-in devices',
    description: 'Active sessions, most recently used first (up to 50). `current` marks this device.',
    responses: {
      200: {
        schema: z.array(
          z.object({
            id: z.uuid(),
            ip: z.string().nullable(),
            userAgent: z.string().nullable(),
            createdAt: timestamp(),
            lastSeenAt: timestamp().nullable(),
            current: z.boolean(),
          }),
        ),
      },
    },
  },
  'DELETE /auth/sessions/:id': {
    summary: 'Sign out one of your devices',
    status: 204,
  },

  // ---------- Organisation ----------
  'GET /org/unit-types': {
    summary: 'List unit types',
    description: 'The levels of the organisation (group, company, region, branch, team, and any a module adds): allowed parents and the profile form fields.',
  },
  'GET /org/units': {
    summary: 'List the units you can see',
    description: 'Every unit the user works in and everything below, plus their ancestors (marked as context). Not paginated: units are few.',
  },
  'GET /org/units/:id': {
    summary: 'Get a unit',
    permission: 'org.view',
    description: 'Includes `access` (`view` or `manage`) for the signed-in user. Units you can’t see answer 404.',
  },
  'POST /org/units': {
    summary: 'Create a unit',
    permission: 'org.manage',
    description: 'Creates a unit under `parentId`. The type must be allowed under the parent’s type, `code` unique among siblings, and `profile` valid for the type. Emits `org_unit.created`.',
    status: 201,
    errors: [404, 409],
  },
  'PATCH /org/units/:id': {
    summary: 'Update or archive a unit',
    permission: 'org.manage',
    description: 'Changes name, code, profile or status. Archiving or restoring needs `org.manage` one level up, and a unit must be empty before it is archived. Emits `org_unit.updated`, `org_unit.archived` or `org_unit.restored`.',
    errors: [409],
  },
  'POST /org/units/:id/move': {
    summary: 'Move a unit to a new parent',
    permission: 'org.manage',
    description: 'Needs `org.manage` at the current and the new parent. The whole subtree moves with it. Emits `org_unit.moved`.',
    errors: [409],
  },

  // ---------- People ----------
  'GET /users': {
    summary: 'List people in a unit',
    permission: 'users.view',
    description: 'People with a role at the unit or anywhere below it, sorted by name. Filter with `q` (name or email) and `status`.',
    list: true,
  },
  'GET /users/:id': {
    summary: 'Get a person',
    permission: 'users.view',
    description: 'The person and their role assignments that you can see.',
  },
  'POST /users/invite': {
    summary: 'Invite a person',
    permission: 'users.manage',
    description:
      'Invites a new person with a role at a unit, or gives an existing person another role. You can only give roles whose permissions you hold there. Sends the invitation email; emits `user.invited` or `user.access_added`.',
    status: 201,
    errors: [404, 409],
  },
  'PATCH /users/:id': {
    summary: 'Update a person',
    permission: 'users.manage',
    description: 'Changes details or status (disable, enable). Needs `users.manage` over every unit where the person works. A group keeps at least one active owner.',
    errors: [409],
  },
  'POST /users/:id/invite': {
    summary: 'Resend an invitation',
    permission: 'users.manage',
    description: 'Sends a fresh invitation link to a person who hasn’t accepted yet; the old link stops working.',
    errors: [409],
  },
  'POST /users/:id/assignments': {
    summary: 'Give a person a role at a unit',
    permission: 'users.manage',
    description: 'You can only give roles whose permissions you hold at that unit. Emits `role_assignment.added`.',
    status: 201,
    errors: [409],
  },
  'DELETE /users/:id/assignments/:assignmentId': {
    summary: 'Remove a role from a person',
    permission: 'users.manage',
    description: 'A group keeps at least one active owner. Emits `role_assignment.removed`.',
    status: 204,
    errors: [409],
  },

  // ---------- Roles ----------
  'GET /permissions': {
    summary: 'List every permission, grouped by module',
    description: 'For role editors. Modules add their own permissions here when installed.',
  },
  'GET /roles': {
    summary: 'List roles in a group',
    permission: ['roles.view', 'users.manage'],
    description: 'Built-in and custom roles of `groupId` (default: your first group).',
  },
  'POST /roles': {
    summary: 'Create a custom role',
    permission: 'roles.manage',
    description: 'You can only include permissions you hold in the group. Emits `role.created`.',
    status: 201,
    errors: [404, 409],
  },
  'PATCH /roles/:id': {
    summary: 'Update a custom role',
    permission: 'roles.manage',
    description: 'Built-in roles can’t be changed. Emits `role.updated`.',
    errors: [409],
  },
  'DELETE /roles/:id': {
    summary: 'Delete a custom role',
    permission: 'roles.manage',
    description: 'Only when nobody holds it. Emits `role.deleted`.',
    status: 204,
    errors: [409],
  },

  // ---------- Settings ----------
  'GET /settings/definitions': {
    summary: 'List setting definitions',
    description: 'Every setting modules define: key, category, control, default and the levels where it may be set.',
  },
  'GET /settings': {
    summary: 'Get the effective settings of a unit',
    permission: 'settings.view',
    description: 'Each value with where it comes from: set on this unit, inherited from an ancestor, or the default.',
  },
  'PUT /settings/:key': {
    summary: 'Set a setting on a unit',
    permission: 'settings.manage',
    description: '`value` must match the setting’s type and the unit must be at an allowed level. Emits `settings.updated`.',
    errors: [400],
    responses: { 200: ok({ key: z.string(), value: z.unknown() }) },
  },
  'DELETE /settings/:key': {
    summary: 'Go back to the inherited value',
    permission: 'settings.manage',
    description: 'Removes the value set on the unit. Emits `settings.reset`.',
    status: 204,
  },

  // ---------- Audit ----------
  'GET /audit': {
    summary: 'List audit entries for a unit',
    permission: 'audit.view',
    description: 'Changes in the unit and everything inside it, newest first. `action` is a prefix (`user.` matches every people change); `from` is inclusive, `to` exclusive.',
    list: true,
  },
};
