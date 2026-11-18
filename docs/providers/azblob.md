# Azure Blob Storage provider (`azblob`, kind: storage)

Dependency-free REST client for Azure Blob Storage, plus a local-disk store with the same
interface for development. Code: `apps/api/src/integrations/providers/azblob/`. Tests:
`apps/api/test/providers/azblob/` (run `cd apps/api && node --test "test/providers/azblob/*.test.js"`;
on Node 24 a bare directory argument is treated as a file and fails, so use the glob).

Facts below were checked against Microsoft's own documentation on **2026-11-05** (see Sources).

## What it does

| Capability | Function | REST call |
| --- | --- | --- |
| `put_blob` | `putBlob({ name, body, contentType, filename / contentDisposition, cacheControl, metadata, overwrite, ifMatch, accessTier })` | Put Blob (block blob, single request) → 201 |
| `get_blob`, `range_read`, `content_md5_check` | `getBlob({ name, range: { offset, count } })` | Get Blob → 200 / 206 |
| `head_blob` | `getBlobProperties({ name })` | Get Blob Properties (HEAD) → 200 |
| `delete_blob` | `deleteBlob({ name, deleteSnapshots, ifMatch, ignoreMissing })` | Delete Blob → 202 |
| `create_private_container` | `createContainer({ container })` | Create Container → 201 (no `x-ms-blob-public-access` header, so private) |
| `signed_download_url` | `createDownloadUrl({ name, expiresInSeconds, filename, inline, contentType })` | none: builds a SAS URL locally (service SAS with Shared Key, user delegation SAS with Entra ID) |
| — | `getUserDelegationKey({ validUntil })` | Get User Delegation Key → 200 (cached, Entra ID only) |
| `webhook_event_grid` | `verifyWebhook`, `parseWebhook`, `subscriptionValidationResponse`, `abuseProtectionResponse`, `verifyEntraBearer` | Event Grid deliveries |

Every function takes an optional `container` (else `defaultContainer`) and an optional `signal`
(AbortSignal) for cancellation. Times returned are ISO 8601 UTC strings; sizes are integer bytes.
Storage has no money amounts, so the "integer minor units" rule does not apply here.

`createLocalDiskStorage(config, { now })` returns the same functions (plus `verifyDownloadUrl(url)`
and `readDownload(url)` for a dev-only download route) and raises the same error kinds and Azure
codes for the cases the CRM relies on (`ContainerNotFound`, `BlobNotFound`, `BlobAlreadyExists`,
`ConditionNotMet`).

## Configuration

`createAzblobClient(config, { fetch, now, logger })`. Config is validated with zod (`config.js`);
invalid config throws `AzblobError { kind: 'config' }` naming the field but never echoing values.

| Field | Default | Where to get it |
| --- | --- | --- |
| `accountName` | required | Azure portal → Storage account → Overview (3-24 lowercase letters/digits). |
| `auth.type = 'managedIdentity'` | — | **Production.** Enable a system- or user-assigned identity on the VM / App Service / Container App. Grant it **Storage Blob Data Contributor** on the storage account (read/write/delete) — this role also includes `generateUserDelegationKey`, needed for download links. If data access is scoped to a container, also grant **Storage Blob Delegator** at account scope. |
| `auth.clientId` / `objectId` / `resourceId` | system identity | Only for a user-assigned identity: Managed Identity resource → Overview. Set at most one. |
| `auth.identityEndpoint` + `auth.identityHeader` | IMDS | App Service / Functions: values of the `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` environment variables. Omit on VMs/AKS (IMDS at `169.254.169.254`). |
| `auth.type = 'sharedKey'`, `auth.accountKey` | — | Storage account → Security + networking → Access keys. Use for Azurite; avoid in production (Microsoft recommends disallowing Shared Key). Or pass `parseConnectionString(cs)`. |
| `auth.type = 'token'`, `auth.getToken` | — | `async () => ({ token, expiresOn })` for workload identity federation or tests. |
| `blobEndpoint` | `https://<account>.blob.core.windows.net` | Azurite: `http://127.0.0.1:10000/devstoreaccount1` (needs `allowInsecureHttp: true`, Shared Key only). |
| `defaultContainer` | none | Your container name (3-63 lowercase letters, digits, single hyphens). |
| `apiVersion` / `sasVersion` | `2026-04-06` | Latest version fully deployed in every region (Microsoft, 2026-10-29). |
| `timeoutMs` | 30000 | Per attempt, enforced with `AbortSignal.timeout`. |
| `maxRetries`, `retryBaseMs`, `retryMaxMs` | 3, 500, 8000 | Exponential backoff with full jitter; `Retry-After` honoured. |
| `maxUploadBytes` | 256 MiB | Single Put Blob cap we accept (Azure allows 5,000 MiB; the body is held in memory). |
| `downloadUrlTtlSeconds` / `maxDownloadUrlTtlSeconds` | 900 / 86400 | Our policy for download links. |
| `sasClockSkewSeconds` | 300 | SAS start time is back-dated by this much. |

Secrets live only in config. The account key, bearer tokens and SAS signatures are never logged;
`redact()` strips `sig=`, `code=`, `SharedKey …:` and `Bearer …` from every message and log line,
and auth-failure messages (which echo Azure's string-to-sign) are dropped entirely.

## Auth details

- **Shared Key** (`sharedKey.js`): `Authorization: SharedKey <account>:<Base64(HMAC-SHA256(key, StringToSign))>`
  with `StringToSign = VERB\nContent-Encoding\nContent-Language\nContent-Length\nContent-MD5\nContent-Type\nDate\nIf-Modified-Since\nIf-Match\nIf-None-Match\nIf-Unmodified-Since\nRange\n` + CanonicalizedHeaders + CanonicalizedResource.
  Content-Length is empty when zero; Date is empty because we always send `x-ms-date` (RFC 1123, regenerated per retry; Azure rejects requests older than 15 minutes with 403).
  CanonicalizedHeaders: all `x-ms-*`, lowercased, sorted, whitespace collapsed outside quotes, `name:value\n`.
  CanonicalizedResource: `/<account><encoded path>` then `\nname:value` per query parameter (lowercased, sorted, URL-decoded, repeated values sorted and comma-joined). Against Azurite the account appears twice (`/devstoreaccount1/devstoreaccount1/...`), as Microsoft documents.
  We never send `Content-Length` ourselves (fetch derives it from the Buffer body) but sign the same value.
- **Entra ID bearer** (`identity.js`): IMDS `GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://storage.azure.com/` with `Metadata: true`; App Service `GET $IDENTITY_ENDPOINT?resource=…&api-version=2019-08-01` with `X-IDENTITY-HEADER`. Tokens are cached until five minutes before `expires_on` and fetched once for concurrent callers. IMDS 404/410/429/5xx are retried; other 4xx are permanent. A 401 from Storage drops the cached token and retries once. Bearer tokens are refused over `http://`.
- **Service SAS** (`sas.js`, sv ≥ 2020-12-06): 16-line string-to-sign
  `sp, st, se, /blob/<account>/<container>/<blob>, si, sip, spr, sv, sr, snapshotTime, ses, rscc, rscd, rsce, rscl, rsct`.
  The Azure JS SDK uses this same layout for every later version, and the Microsoft page (updated 2026-11-03) lists no newer format.
- **User delegation SAS**: layout chosen by `sv`: 2020-12-06 (24 lines), 2025-07-05 (adds `skdutid`, `sduoid` after `scid`, 26 lines), 2026-04-06 (adds the `srh`/`srq` canonical lines after `ses`, 28 lines; we never emit `srh`/`srq`, so those lines are empty). The key comes from `POST /?restype=service&comp=userdelegationkey` with `<KeyInfo><Start/><Expiry/></KeyInfo>`; it is cached and requested for at least a day (max 7 days). A SAS may not outlive its key.
- Permissions are limited to `r a c w d` and re-ordered to `racwd`. Download links use `sp=r`, `spr=https` (omitted for http Azurite), `rscd` for the download filename (RFC 6266 with an RFC 5987 UTF-8 `filename*`, so Devanagari/Tamil names work) and optional `rsct`.

## Errors

All failures are `AzblobError { kind, retryable, status, azureCode, requestId, attempts }`.

| Status / code | kind | retried? |
| --- | --- | --- |
| 400 | `validation` | no |
| 401 | `auth` | no (bearer: one token refresh) |
| 403 `AuthenticationFailed` / other 403 | `auth` / `forbidden` | no |
| 404 | `not_found` (`deleteBlob` returns `{ deleted: false }`) | no |
| 408 | `timeout` | yes |
| 409 (`BlobAlreadyExists`, `ContainerAlreadyExists`, `LeaseIdMissing`…) | `conflict` | no |
| 412 `ConditionNotMet` | `precondition` | no |
| 413 | `too_large` | no |
| 429, 503 / `ServerBusy` | `throttled` | yes |
| 500 / `OperationTimedOut` / `InternalError`, 502, 504 | `server` | yes |
| network error / per-attempt timeout | `network` / `timeout` | yes |
| caller aborted `signal` | `cancelled` | no |

Only idempotent calls are retried, and all of ours are: GET/HEAD/DELETE by nature, Put Blob because it
replaces the whole blob with the same bytes. **Azure has no idempotency keys.** `x-ms-client-request-id`
(we generate one, or pass `clientRequestId`) is only a correlation id in Azure's logs. For create-only
uploads (`overwrite: false`) a retry after a lost 201 would see 409; the client then compares the stored
Content-MD5 with ours and reports success (`reconciled: true`) if they match. Full downloads are checked
against `Content-MD5` when Azure returns one.

## Webhooks (blob events through Azure Event Grid)

Blob Storage has no webhooks of its own. Set up: Storage account → **Events** → + Event Subscription →
endpoint type **Web Hook** → `https://<api>/webhooks/azblob?code=<secret>` (or leave the URL clean and add a
**Delivery Properties** header `x-phoenix-webhook-secret: <secret>` with *Is secret?* ticked). Filter to
`Microsoft.Storage.BlobCreated` / `BlobDeleted` and optionally by subject prefix
`/blobServices/default/containers/<container>/`. Event Grid only delivers to HTTPS endpoints.

**Verification scheme (exact).** Event Grid does **not** sign payloads: there is no HMAC and no timestamp
header. Supported authentication is (a) a secret in a query parameter, (b) a static custom header, or
(c) a Microsoft Entra ID bearer token. `verifyWebhook(rawBody, headers, secret, { query, headerName, toleranceSeconds, now })`:

1. takes the credential from header `x-phoenix-webhook-secret` (configurable), else `Authorization: Bearer <secret>`, else query `code`;
2. compares it in constant time (SHA-256 both sides, `crypto.timingSafeEqual`) against the secret or each secret in `[current, previous]` during rotation (secrets must be ≥ 16 chars);
3. checks `aeg-event-type`, when present, is `Notification`, `SubscriptionValidation` or `SubscriptionDeletion`;
4. parses the raw body as JSON (array, or one CloudEvent) and requires each event to have an `id`;
5. only if `toleranceSeconds` is given: rejects events whose `eventTime`/`time` is older than the window or more than 5 minutes in the future. Event Grid defines **no** tolerance and retries for up to 24 hours (default TTL 1440 min, 30 attempts), so keep this off or set it above your subscription TTL.

Because there is no signature, body tampering cannot be detected cryptographically; TLS plus the secret are
the protection. For stronger auth use an Entra-protected webhook and `verifyEntraBearer(authHeader, { jwks, audience, issuers })`
(RS256, `aud`, `iss`, `exp`/`nbf` with 5-minute skew; you fetch and cache the tenant JWKS).

Handshakes: Event Grid schema sends `Microsoft.EventGrid.SubscriptionValidationEvent` with header
`aeg-event-type: SubscriptionValidation`; respond 200 within 30 s with `subscriptionValidationResponse(events)`
→ `{ "validationResponse": "<code>" }` (or GET the `validationUrl` within 10 minutes). CloudEvents 1.0 schema
uses an HTTP OPTIONS preflight; reply with `abuseProtectionResponse(headers)` (`WebHook-Allowed-Origin`).

`parseWebhook(body)` returns normalised events: `{ provider: 'azblob', id, type ('blob.created',
'blob.deleted', 'blob.renamed', 'blob.tier_changed', 'subscription.validation', …), providerType, schema,
occurredAt, account, container, blobName, url, api, contentType, contentLength, eTag, blobType, accessTier,
sequencer, requestId, clientRequestId, validationCode, validationUrl, raw }`. Delivery is at least once and
unordered: dedupe on `id`; use `sequencer` to order events for the same blob. Return 200-204 quickly;
400/401/403/413 are not retried by Event Grid.

## Rate limits and sizes

- Storage account (standard GPv2): **40,000 requests/s** and 60 Gbps ingress / 200 Gbps egress in listed regions, which include **Central India** and **Jio India West**; **20,000 requests/s**, 25 Gbps ingress / 50 Gbps egress elsewhere (South India, West India). Increases via Azure Support.
- Single block blob: up to 3,000 requests/s. Hot partitions (sequential names) can throttle earlier, so prefer names with a random or hashed segment (e.g. `g/<groupId>/<uuid>-file.pdf`).
- Throttling shows as 503 Server Busy or 500 Operation Timeout; we back off and retry.
- Put Blob max 5,000 MiB (we cap at `maxUploadBytes`); larger files need Put Block / Put Block List (not implemented). Azure allows 10 minutes per MiB.
- User delegation key and its SAS: at most 7 days. Metadata: 8 KiB total, ASCII values.
- IMDS is throttled (429); tokens are cached so this is rarely hit.

## Sandbox / test mode

- **Azurite** (Microsoft's emulator; v3.37 supports Blob API 2026-10-06): `docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0`, then
  `createAzblobClient({ ...parseConnectionString('UseDevelopmentStorage=true'), defaultContainer: 'dev' })`.
  The account `devstoreaccount1` and its key are public, documented values. OAuth on Azurite needs `--oauth basic` plus HTTPS and does not check signatures.
- **Local disk**: `createLocalDiskStorage({ rootDir, baseUrl, signingSecret })`. Blobs are stored as `<rootDir>/<container>/<sha256(name)>.bin` + `.json`; download URLs are HMAC-signed and expire.
- **Unit tests**: inject `fetch` (see `test/providers/azblob/fakes.js`), `now`, `sleep`, `random`. No network.
- There is no separate Azure "sandbox"; use a dedicated storage account in a dev subscription.

## India-specific notes

- Regions: Central India (Pune), South India (Chennai), West India (Mumbai); Jio India West / Central are restricted-access regions. Central India gets the higher 40k rps / 60 Gbps targets. All three public India regions are on x-ms-version 2026-12-06 or later per Microsoft's table, so `2026-04-06` works.
- Data residency: keep admission documents (marksheets, Aadhaar-masked IDs, TC, fee receipts) in an India region with LRS or ZRS. GRS/RA-GRS copies data to the paired region; check the pair is also in India before enabling it. Treat student and parent documents as personal data under the DPDP Act 2023; this client does not decide retention, that belongs to the CRM.
- File names in Hindi, Marathi, Tamil and other scripts are fine as blob names (UTF-8, percent-encoded per segment) and as download names (`filename*=UTF-8''…`). Metadata values must be ASCII; base64-encode anything else.
- Do not use `sip` (IP-restricted SAS) for families on mobile networks: carrier-grade NAT and changing IPs make links fail. Keep links short-lived instead (default 15 minutes).

## Wrapping it in the adapter (wave 2)

Both factories return `{ provider, kind: 'storage', capabilities, putBlob, getBlob, getBlobProperties,
deleteBlob, createContainer, createDownloadUrl }`. Map adapter config to `createAzblobClient(config, { fetch, now, logger })`
(or `createLocalDiskStorage` when `NODE_ENV=development`), map `AzblobError.kind`/`retryable` onto the
framework's error types, and mount `verifyWebhook` + `parseWebhook` (+ `subscriptionValidationResponse`
and `abuseProtectionResponse`) on the webhook route using the **raw** request body.

## Sources (all checked 2026-11-05)

- Authorize with Shared Key — https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key (page dated 2024-11-15)
- Create a service SAS — https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas (updated 2026-11-03)
- Create a user delegation SAS — https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas (updated 2026-11-03)
- Get User Delegation Key — https://learn.microsoft.com/en-us/rest/api/storageservices/get-user-delegation-key (updated 2026-01-20)
- Put Blob — https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob (updated 2026-03-26); Delete Blob — …/delete-blob (updated 2026-01-20)
- Versioning for Azure Storage — https://learn.microsoft.com/en-us/rest/api/storageservices/versioning-for-the-azure-storage-services (updated 2026-10-29)
- Authorize with Microsoft Entra ID — https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-azure-active-directory (updated 2025-04-04)
- Managed identity tokens on VMs (IMDS) — https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token (updated 2026-06-15)
- App Service managed identity REST endpoint — https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity (updated 2026-05-20)
- Blob Storage scalability targets — https://learn.microsoft.com/en-us/azure/storage/blobs/scalability-targets (updated 2026-07-27); standard account targets — https://learn.microsoft.com/en-us/azure/storage/common/scalability-targets-standard-account (updated 2026-10-16)
- Event Grid: Blob Storage event schema — https://learn.microsoft.com/en-us/azure/event-grid/event-schema-blob-storage (updated 2026-03-25); webhook validation (Event Grid schema, 2026-03-27; CloudEvents, 2026-02-17); authenticate delivery — …/security-authentication (2026-02-17); delivery properties — …/delivery-properties (2026-03-25); delivery and retry — …/delivery-and-retry (2026-02-12)
- Azure SDK for JS `BlobSASSignatureValues.ts` (main branch) — version branching for SAS layouts
- Azurite README and ChangeLog (v3.37.0, 2026.08) — dev account, API version support

## Unconfirmed / not verified

- No official Shared Key or SAS signature test vector with a published key exists. Our vectors are computed with `node:crypto` from string-to-sign literals typed from the docs; the Shared Key string-to-sign matches Microsoft's examples byte for byte. Not yet run against real Azure or Azurite (no emulator in this environment).
- Service SAS at sv ≥ 2026-04-06 is assumed to keep the 2020-12-06 layout (docs list nothing newer; SDK agrees). Whether Azurite 3.37 accepts user delegation SAS at sv 2026-04-06 is unknown.
- The `srh`/`srq` canonical query format differs between the docs (`name=value`) and the JS SDK (`name:value`); we never emit `srh`/`srq`, so this does not affect us.
- The exact `WebHook-Request-Origin` value Event Grid sends (`eventgrid.azure.net`) and the claims of Event Grid's Entra tokens (aud/iss format) were not confirmed from the pages read; both are configurable.
- India region pairs for GRS and the DPDP Act implications were not verified in this pass.
- IMDS `410` can last up to 70 seconds; our retry budget (≈ 3 retries, ≤ 30 s backoff) may give up sooner.
