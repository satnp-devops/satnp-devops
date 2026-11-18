# Phoenix Platform

One platform for every Phoenix company (Pi Vector, SatnPaper, Excel and the next ones): leads, demo bookings, admissions, software sales to institutes, fees and onboarding.

This repository is **phase 1, the foundation** that every later feature plugs into:

- a multi-level organisation (group → companies → regions → branches → teams, any depth)
- roles that apply at any level and flow down, with custom roles and no privilege escalation
- settings that inherit down the tree
- sign-in with two-step verification, invitations, password reset and device management
- an audit log of every change, and domain events delivered by a background worker
- a module registry, so new features are added as modules without touching the core
- a Next.js app (strict TypeScript) with organisation, people, roles, settings, audit and account screens

How it works, and how to extend it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

| Part | Technology |
| --- | --- |
| API | Node.js 20.12+, Express 5, JavaScript (ES modules), zod, knex |
| Database | PostgreSQL 16 |
| Cache, queues, rate limits | Redis 7, BullMQ |
| Web app | Next.js 16, React 19, TypeScript 5.9 (strict), TanStack Query |

## Quick start

You need Node.js 20.12 or newer and Docker (or your own PostgreSQL 16 and Redis 7).

```bash
docker compose up -d          # PostgreSQL on 5432, Redis on 6379
cp .env.example .env          # defaults work for local development
npm install
npm run db:migrate
npm run db:seed               # the Phoenix group, its units and people, and the CRM demo data
npm run dev                   # API :4000, worker, web :3000
```

Open http://localhost:3000 and sign in with any seeded person below. The password for all of them is `Phoenix@12345` (`SEED_PASSWORD` in `.env`).

| Email | Person | Role, and where |
| --- | --- | --- |
| owner@phoenix.test | Anand Rao | Group owner, Phoenix Educational Institute |
| admin@phoenix.test | Meenal Joshi | Group admin, Phoenix Educational Institute |
| finance@phoenix.test | Farah Siddiqui | Finance, Phoenix Educational Institute |
| admin.satnpaper@phoenix.test | Rohit Bansal | Company admin, SatnPaper |
| admin.pivector@phoenix.test | Nisha Pillai | Company admin, Pi Vector |
| kabir@phoenix.test | Kabir Anand | Manager of SatnPaper › Online, and counsellor in SAT admissions |
| ritika@phoenix.test | Ritika Sharma | Counsellor, SatnPaper › Online › SAT admissions |
| sales.satnpaper@phoenix.test | Dev Khanna | Account executive, SatnPaper › Software sales |
| admin.excel@phoenix.test | Sameer Kulkarni | Company admin, Excel (added by the CRM seed) |

Sign in as different people to see the levels at work: a company admin only sees their company (the group shows above it for context), and a counsellor can see the organisation but not manage people.

The CRM seed (`02_crm.js`) adds product lines, products, pipelines, custom fields, about 80 families, 15 institutes and 200 leads with their timelines, tasks and consent records for Pi Vector, SatnPaper and Excel. Phone numbers are in the fake range +91 90000 0xxxx and emails end in @example.com. Ritika works only her own SatnPaper leads, Kabir sees all of SatnPaper › Online. Phase 2's design is in [docs/crm/PHASE2_CONTRACT.md](docs/crm/PHASE2_CONTRACT.md).

Platform services: every outside system (WhatsApp, email, SMS, calls, meetings, calendars, payments, e-sign, AI, storage) sits behind an adapter with a mock that works offline ([docs/platform/INTEGRATIONS.md](docs/platform/INTEGRATIONS.md)); provider webhooks and background jobs run in the worker with retries and dead letters ([WEBHOOKS_AND_JOBS.md](docs/platform/WEBHOOKS_AND_JOBS.md)); messages go out through one messaging service ([MESSAGING.md](docs/platform/MESSAGING.md)); AI agents run with guardrails and a review queue ([AI.md](docs/platform/AI.md)). With `INTEGRATIONS_MOCKS=auto` (the default outside production) the seeded companies use mock connections, and Settings › Integrations › Sandbox shows what they would have sent.

Emails (invitations, password resets) are printed in the worker's log in development. Invitation links are also shown on screen outside production.

## Scripts

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | API and worker with auto-restart, plus the web app in dev mode |
| `npm run build` | Production build of the web app |
| `npm start` | API, worker and web app in production mode |
| `npm run db:migrate` / `db:rollback` | Apply or undo database migrations (`db:rollback` undoes the last batch; `npm run db:rollback -- --all` undoes every migration) |
| `npm run db:seed` | Add the demo group, people and CRM data (each part skipped if already there) |
| `npm run db:reset` | Drop everything, migrate and seed again |
| `npm test` | API unit tests |
| `npm run test:integration` | API end-to-end tests against the real database and Redis |
| `npm run typecheck` | Strict TypeScript check of the web app |

API-only commands:

```bash
# Start another organisation on the same platform, with its own owner and invite link
npm run org:create-group -w @phoenix/api -- --name "Acme Learning" --code acme \
  --owner-email owner@acme.example --owner-name "Asha Mehta"

# After adding or upgrading a module: update the built-in roles with its default grants
npm run roles:sync -w @phoenix/api

# Rebuild the global search index (all of it, one kind with --entity deal|contact|account, or one group with --group <id>)
npm run search:reindex -w @phoenix/api
```

## Tests

- **Unit tests** (`npm test`): permissions, the org tree, settings inheritance, the module registry, TOTP against the RFC 6238 vectors, password hashing and encryption, input schemas.
- **Integration tests** (`npm run test:integration`, needs a migrated and seeded database): sign-in, the CSRF rule, creating and moving units, visibility across companies, invitations, privilege-escalation checks, settings inheritance, two-step verification with recovery codes, the 2FA policy, custom roles, the audit log and the outbox. They create uniquely named records, so they can run repeatedly.
- **Browser smoke test** (`e2e/smoke.mjs`): signs in as several seeded people and walks through every screen, including inviting someone, accepting the invitation, setting up two-step verification and signing back in with a recovery code. See the comment at the top of the file to run it.

## Project layout

```
apps/
  api/                  Express API and background worker (JavaScript)
    src/core/           registry, access control, org tree, settings, events, audit, queues
    src/modules/        one folder per feature: auth, org, users, roles, settings, audit, system
    src/db/             migrations, seed data, database CLI
    test/               unit tests, and integration/ for end-to-end API tests
  web/                  Next.js app (strict TypeScript)
    src/app/            routes: (auth) sign-in pages, (app) signed-in pages
    src/components/     UI kit, dialogs, dynamic form fields, sidebar
    src/lib/            API client, types, queries, session and permissions
docs/ARCHITECTURE.md    design, data model, API, extension guide, roadmap
docs/crm/, docs/platform/  phase contracts and platform services (integrations, webhooks and jobs, messaging, AI)
e2e/smoke.mjs           browser smoke test
```

## Running in production

- Set `NODE_ENV=production`, a real `APP_URL`, and `APP_ENCRYPTION_KEY` (32 random bytes, base64; the API refuses to start without it). It encrypts two-step verification secrets.
- Set `API_INTERNAL_URL` **before** `npm run build`: Next.js fixes the API address into the build.
- Run the API, the worker and the web app as separate processes. The worker also runs provider webhooks and background jobs (bulk actions, SLA sweeps, reminders, automations), so it must always be up. The API is stateless, so run as many copies as you need behind a load balancer; the worker can also run several copies.
- Set `INTEGRATIONS_MOCKS=off` (the production default) and connect real providers in Settings › Integrations; point each provider's webhook at `<API>/api/v1/webhooks/<provider>/<connectionId>`. Enable Redis persistence (AOF): queued jobs live there until they run.
- Put the web app and API behind HTTPS. Session cookies are `Secure` in production, and set `TRUST_PROXY` to match your proxy so rate limits see real client addresses.
- `MAIL_PROVIDER=console` only prints emails. Add a real mail adapter in `apps/api/src/integrations/mail/` before inviting people (see the architecture doc).
#   s a t n p - d e v o p s  
 