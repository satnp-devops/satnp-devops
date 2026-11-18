# Security hardening (Express 5 + Next.js 16 on Azure) and CERT-In obligations: Phoenix Group CRM

Research as of 6 November 2026. This is written for the engineers doing the security review and hardening wave. Anything I could not confirm from a primary source is marked **unconfirmed**. Citations in square brackets point to section 7 (Sources).

Stack observed in the repo (read-only check): `express ^5.1.0`, `helmet ^8.1.0`, `pino ^9.7.0`, `next ^16.4.0`, `react ^19.2.0`, `pg`, `zod ^4`, `bullmq`/`ioredis` (Redis 7 holds sessions, the access cache, rate-limit counters, TOTP replay guards and queues). There is an append-only `audit_logs` table written in the same transaction as each change, with secret redaction. Phase 3 plans webhooks and API keys. The repo does not say which Azure compute service is used (App Service, Container Apps or AKS). See the open questions.

---

## 1. Summary

1. **CERT-In Directions apply to Phoenix in full for directions (i) to (iv).** Phoenix is a "body corporate" (a company; IT Act s.43A definition quoted in FAQ Q25). The Directions of 28 April 2022 (No. 20(3)/2022-CERT-In, issued under s.70B(6) IT Act) require four things. (i) Sync all ICT clocks to NIC/NPL NTP or a source that "shall not deviate" from them. (ii) Report any Annexure I incident (20 types, including data breach, data leak, unauthorised access, and attacks on cloud and AI/ML systems) **within 6 hours of noticing it or being told about it**. (iii) Designate a Point of Contact and act on CERT-In orders. (iv) Enable logs of **all** ICT systems and keep them for a **rolling 180 days within Indian jurisdiction** [D1]. Non-compliance can be punished under s.70B(7): up to 1 year in prison, a fine up to ₹1 lakh, or both [D2 intro ¶4]. The MSME deferral ended on 25 Sept 2022 [N1]. I found no amendment to these Directions after 2022 (searched Nov 2026; **unconfirmed** that none exists).
2. **Directions (v) and (vi) mostly do not apply.** (v) covers data centres, VPS, cloud and VPN providers. (vi) covers virtual-asset providers. One open question remains: could Phoenix's B2B SaaS for institutes count as a "cloud service provider" under (v)? The term is undefined, so keeping 5-year customer onboarding records is a cheap hedge.
3. **Logs: keep them in Central India for ≥180 days, and preferably ≥1 year.** The FAQ allows logs outside India if they can be produced "in a reasonable time" (Q35). However, Q36 says any provider serving users in India must keep logs "in Indian jurisdiction". Keeping everything in a Central India Log Analytics workspace meets both readings. Set retention to at least 365 days so the same store also meets the DPDP Rules 2025 one-year log requirement (Rule 6), which commences 13 May 2027 per secondary sources [P1]; cross-check with the DPDP research doc.
4. **Time:** Azure-native time sync is acceptable for cloud customers (FAQ Q42). If Phoenix runs its own NTP, it must use `samay1.nic.in`, `samay2.nic.in` or `time.nplindia.org` (Q43). IST is not required. Use UTC and record the time zone (Q40). ASVS 16.2.2 says the same.
5. **Framework patch level is a P0.** Next.js had critical unauthenticated RCEs in 2025 and 2026: React2Shell CVE-2025-55182, and GHSA-673q-mjm6-r5xr / GHSA-2464-fhr4-w9xw fixed in 16.4.1. A further batch of advisories was published 3 Nov 2026, affecting ≤16.4.2. npm `latest` is **16.4.5** (3 Nov 2026) [X1, X2]. The repo pins `^16.4.0`, so make sure the lockfile resolves to ≥16.4.5. Express `latest` is 5.3.0.
6. **OWASP ASVS 5.0.0 Level 2** (released 2025) is the right target. The most relevant L2 items are: V1.3.6 (SSRF); V3.4.x (CSP, HSTS, frame-ancestors); V5 (file handling, including antivirus scanning 5.4.3); V8.4.1 (cross-tenant controls); V13.2/13.3 (service auth, egress allowlists, key vault); V14 (data classification); V16 (logging, including 16.2.5 sensitive data in logs and 16.4.2 logs that cannot be modified) [A1].
7. **CSP with nonces** in Next.js 16 is generated in `proxy.ts` (Middleware was renamed to Proxy in v16 and runs on Node.js). It forces dynamic rendering. It disables static optimisation and ISR, and it is incompatible with Partial Prerendering [X3, X4]. The authenticated CRM is dynamic anyway. Public admissions pages can use static headers or experimental SRI.
8. **SSRF in the automation "call webhook" action** needs layered defences. Use a protocol and port allowlist. Validate every resolved address against non-global ranges, and explicitly block `169.254.169.254` (Azure IMDS) and `168.63.129.16` (an Azure platform *public* IP, so an "is private?" check will not catch it). Connect only to the validated IP. Do not follow redirects. Send calls from an isolated egress subnet [O1, M3, SW1, A1].
9. **Webhooks:** verify signatures over the raw body in constant time. Check a timestamp tolerance where the sender signs one (Standard Webhooks `msg_id.timestamp.payload`). Dedupe on the event ID with a unique DB constraint. Make the business action idempotent too [SW1, R1].
10. **Azure controls:**
    - **Key Vault:** use the RBAC model with purge protection. Purge protection is irreversible. Soft-delete retention is 7–90 days and is fixed at creation. Use managed identities everywhere. Connect to Postgres with Entra tokens and disable password auth [K1, K2, PG2].
    - **Front Door:** WAF managed rules (DRS), Bot Manager and Private Link origins are **Premium-only** [F2, F3]. Rate limits use fixed windows of 1 or 5 minutes, counted per socket IP (GA). Counting is approximate per Front Door server below about 200 requests/min [F1].
    - **Postgres flexible server:** PITR retention is 7–35 days. **Geo-redundant backup can only be chosen at server creation.** Local RPO is up to about 5 minutes; geo RPO is up to 1 hour. Deleting the server deletes its backups, so apply a resource lock [PG1].
    - **Audit logs:** add DB-level append-only enforcement and hash chaining. Export sealed batches to Blob storage with a **locked** time-based WORM policy [S1].
    - **Uploads:** Defender for Storage on-upload scanning (up to 50 GB per blob, runs in-region). Promote files on Event Grid results, not on blob index tags, because "Index tags aren't tamper-resistant" [M4].

---

## 2. CERT-In Directions of 28 April 2022: rules in detail

### 2.1 Instrument

- **Citation:** CERT-In, *Directions under sub-section (6) of section 70B of the Information Technology Act, 2000 relating to information security practices, procedure, prevention, response and reporting of cyber incidents for Safe & Trusted Internet*, No. 20(3)/2022-CERT-In, dated 28 April 2022 [D1].
- **Legal basis:** IT Act s.70B(6), read with the CERT-In Rules 2013 (notified 16.01.2014). Definitions of "cyber incident" and "cyber security incident" come from the IT Act and the CERT-In Rules 2013 [D1 p.4]. FAQ Q3 defines "Cyber Security Incident" as "any real or suspected adverse event in relation to cyber security that violates an explicitly or implicitly applicable security policy resulting in unauthorised access, denial of service or disruption, unauthorised use of a computer resource for processing or storage of information or changes in data, information without authorisation" [D2].
- **Commencement:** "This direction will become effective after 60 days from the date on which it is issued" [D1 p.4], which is about 27 June 2022. CERT-In extended this to 25 September 2022 for MSMEs, and for the subscriber-validation parts of direction (v) [N1, secondary reporting of a 27 June 2022 CERT-In notification; the notification itself was not fetched]. That deferral has long expired.
- **Penalty:** "Any service provider, intermediaries, data centres, body corporate or person who fails to provide the information called for or comply with the direction under sub-section (6), shall be punishable with imprisonment for a term which may extend to one year or with fine which may extend to one lakh rupees or with both" (s.70B(7), quoted in [D2] intro ¶4). FAQ Q23 adds: "This power will be exercised reasonably and on occasions when the non-compliance is deliberate."
- **Status of the FAQ:** The FAQ (May 2022) says it "is not a legal document and in no way whatsoever replaces, amends or alters" the Act or Rules [D2 p.2]. Treat it as CERT-In's interpretation, not as law.

### 2.2 Applicability to Phoenix

| Question | Answer | Source |
|---|---|---|
| Is Phoenix covered? | Yes. Directions (i)–(iv) apply to "service providers, intermediaries, data centres, body corporate and Government organisations". "Body corporate" means "any company and includes a firm, sole proprietorship or other association of individuals engaged in commercial or professional activities." | D1; D2 Q7, Q25 |
| Foreign vendors and sub-processors | The Directions "are applicable to any entity whatsoever, in the matter of cyber incidents and cyber security incidents." | D2 Q26 |
| Incident at a vendor (Azure, WhatsApp BSP, payment gateway) affecting Phoenix data | "Any entity which notices the cyber security incident, shall report to CERT-In. The obligation of reporting of cyber incident is neither transferrable nor indemnified or dispense with." Phoenix must report if *it* notices, even when the vendor also reports. | D2 Q13, Q31 |
| Contracts with confidentiality clauses | The statutory reporting obligation "overrides any confidentiality clause in any contract by virtue of the provisions of section 81". | D2 Q22 |
| Direction (v) (DC/VPS/CSP/VPN subscriber records, 5 years) | Aimed at infrastructure providers. FAQ Q34 limits "VPN Service provider" to entities providing "Internet proxy like services" to the general public. "Cloud Service provider" is **not defined** [N1 commentary]. Phoenix's B2B SaaS sold to institutes is arguably outside scope (**unconfirmed**; see open questions). | D1 p.3; D2 Q33–34 |
| Direction (vi) (virtual-asset KYC) | Not applicable (Phoenix is not a VASP). | D1 p.4 |

### 2.3 Direction (i): clock synchronisation

Verbatim [D1 p.2]:
> "All service providers, intermediaries, data centres, body corporate and Government organisations shall connect to the Network Time Protocol (NTP) Server of National Informatics Centre (NIC) or National Physical Laboratory (NPL) or with NTP servers traceable to these NTP servers, for synchronisation of all their ICT systems clocks. Entities having ICT infrastructure spanning multiple geographies may also use accurate and standard time source other than NPL and NIC, however it is to be ensured that their time source shall not deviate from NPL and NIC."

FAQ clarifications [D2]:
- **Q40:** Other accurate, standard sources are allowed "as long as the accuracy of time is maintained". There is "no need to mandatorily set system clocks in Indian Standard Time (IST)". "The time zone information shall also be recorded along-with time to facilitate accurate conversion at the time of need."
- **Q42 (cloud customers):** "Customers in cloud environments … have an option to use the native time services offered by the Cloud … The entities relying on the native time services offered as part of Cloud may continue to use the same". If an entity runs its own NTP service that syncs to non-native sources, NIC, NPL or other accurate sources may be used, and the time "shall not deviate from NPL and NIC".
- **Q43:** NIC servers are `samay1.nic.in` and `samay2.nic.in`. The NPL server is `time.nplindia.org`.

**What this means for Phoenix:** Azure PaaS uses platform time, which Q42 accepts. Any VM, AKS node or appliance Phoenix configures itself must point to Azure native time or to the NIC/NPL hosts above. Every log record must carry a UTC timestamp with an explicit offset. ASVS 16.2.2 says the same: "timestamps in security event metadata use UTC or include an explicit time zone offset" [A1].

### 2.4 Direction (ii): 6-hour incident reporting

Verbatim [D1 p.2]:
> "Any service provider, intermediary, data centre, body corporate and Government organisation shall mandatorily report cyber incidents as mentioned in Annexure I to CERT-In within 6 hours of noticing such incidents or being brought to notice about such incidents. The incidents can be reported to CERT-In via email (incident@cert-in.org.in), Phone (1800-11-4949) and Fax (1800-11-6969). The details regarding methods and formats of reporting cyber security incidents is also published on the website of CERT-In www.cert-in.org.in and will be updated from time to time."

**Annexure I: incident types that must be reported** [D1 pp.5–6]. The PDF's column layout misaligns the numerals. The order below is the corrected one, and it matches the FAQ's Annexure I explanation [D2]:

| # | Incident type | Most likely Phoenix triggers |
|---|---|---|
| i | Targeted scanning/probing of critical networks/systems | Front Door WAF/bot logs showing targeted recon |
| ii | Compromise of critical systems/information | Compromise of the API host, DB or Key Vault |
| iii | Unauthorised access of IT systems/data | Account takeover of a staff user; BOLA exploitation; cross-group data access |
| iv | Defacement of website or intrusion into a website and unauthorised changes such as inserting malicious code, links to external websites etc. | Admissions landing pages; a stored-XSS payload |
| v | Malicious code attacks such as spreading of virus/worm/Trojan/Bots/Spyware/Ransomware/Cryptominers | A malware upload detected *and* opened or spread; ransomware |
| vi | Attack on servers such as Database, Mail and DNS and network devices such as Routers | Attacks on Postgres, Redis or DNS |
| vii | Identity Theft, spoofing and phishing attacks | Phishing of parents using Phoenix branding; spoofed WhatsApp sender |
| viii | Denial of Service (DoS) and Distributed Denial of Service (DDoS) attacks | DDoS on the admissions portal |
| ix | Attacks on Critical infrastructure, SCADA and operational technology systems and Wireless networks | Unlikely |
| x | Attacks on Application such as E-Governance, E-Commerce etc. | Attacks on CRM application logic |
| xi | Data Breach | Any exfiltration of contacts or students' PII |
| xii | Data Leak | A misconfigured public blob container; PII in public logs |
| xiii | Attacks on Internet of Things (IoT) devices and associated systems, networks, software, servers | Unlikely |
| xiv | Attacks or incident affecting Digital Payment systems | Payment-link or webhook tampering (money module) |
| xv | Attacks through Malicious mobile Apps | n/a unless Phoenix ships an app |
| xvi | Fake mobile Apps | Fake "Phoenix admissions" app |
| xvii | Unauthorised access to social media accounts | Phoenix's Meta/WhatsApp Business accounts |
| xviii | Attacks or malicious/suspicious activities affecting Cloud computing systems/servers/software/applications | Azure subscription or tenant compromise |
| xix | Attacks or malicious/suspicious activities affecting systems/servers/networks/software/applications related to Big Data, Block chain, virtual assets, virtual asset exchanges, custodian wallets, Robotics, 3D and 4D Printing, additive manufacturing, Drones | Unlikely |
| xx | Attacks or malicious/suspicious activities affecting systems/servers/software/applications related to Artificial Intelligence and Machine Learning | Prompt-injection-driven data exfiltration through the ai module |

FAQ clarifications [D2]:
- **Q30:** If the CERT-In incident reporting form (`https://www.cert-in.org.in/PDF/certinirform.pdf`) cannot be completed within 6 hours: "The entities may provide information to the extent available at the time of reporting. Additional information may be reported later within reasonable time." The answer then says that Annexure I incidents "meeting the following criteria should be reported within the stipulated 6 hour time":
  - incidents "of severe nature (such as denial of service, distributed denial of service, intrusion, spread of computer contaminant including Ransomware) on any part of the public information infrastructure including backbone network infrastructure";
  - "Data Breaches or Data Leaks";
  - "large-scale or most frequent incidents such as intrusion into computer resource, websites etc.";
  - "cyber incidents impacting safety of human beings".
  
  (Interpretation, **unconfirmed** legally: Q30 does not say that other Annexure I incidents need no report. Treat them as reportable, and treat the four criteria as the hard 6-hour cases.)
- **Q24:** The clock runs from "noticing the incident or being brought to notice". Detection latency does not delay the deadline, so detection controls matter.
- **Q15:** Reporting a standalone vulnerability that is not connected to an incident "is not mandatory".
- **Q10:** Incidents outside Annexure I may still be worth reporting "considering the nature, severity and impact" (this is addressed to intermediaries).

### 2.5 Direction (iii): Point of Contact and orders

- When CERT-In orders it, Phoenix must "take action or provide information or any such assistance". The order "may include the format of the information that is required (up to and including near real-time), and a specified timeframe". Missing that timeframe "would be treated as non-compliance" [D1 p.3].
- Phoenix must "designate a Point of Contact to interface with CERT-In". PoC information goes to **info@cert-in.org.in** in the Annexure II format: Name, Designation, Organisation Name, Office Address, Email ID, Mobile No., Office Phone, Office Fax. It "shall be updated from time to time" [D1 pp.3, 7].
- **Q38:** Requisitions for logs come from "an officer of CERT-In not below the rank of Deputy Secretary to the Government of India" [D2]. The runbook should verify this before releasing logs.

### 2.6 Direction (iv): logs, 180 days, Indian jurisdiction

Verbatim [D1 p.3]:
> "All service providers, intermediaries, data centres, body corporate and Government organisations shall mandatorily enable logs of all their ICT systems and maintain them securely for a rolling period of 180 days and the same shall be maintained within the Indian jurisdiction. These should be provided to CERT-In along with reporting of any incident or when ordered / directed by CERT-In."

FAQ [D2]:
- **Q35:** "The logs may be stored outside India also as long as the obligation to produce logs to CERT-In is adhered to by the entities in a reasonable time."
- **Q36:** "Any service provider offering services to the users in the country needs to enable and maintain logs and records of financial transactions in Indian jurisdiction." This is in tension with Q35, so keep logs in India.
- **Q37:** Logs to keep depend on the sector, "such as Firewall logs, Intrusion Prevention Systems logs, SIEM logs, web / database/ mail / FTP / Proxy server logs, Event logs of critical systems, Application logs, ATM switch logs, SSH logs, VPN logs etc." The list is "not exhaustive". Also: "both successful as well as unsuccessful events shall be recorded."
- **Q32:** Existing confidentiality obligations for customer data in logs "are in force and does not change". So redaction and access control still apply.

How this maps to Azure:
- Log Analytics defaults to **30 days** (some tables 90). Analytics retention can be raised to **730 days**, and total retention to **12 years (4,383 days)** [M5].
- So set workspace or table retention to at least 180 days explicitly. The default 30 days does **not** comply.
- Place the workspace in **Central India**. The Central India/South India region pair keeps geo-copies in India [M6].

### 2.7 Related Indian requirements that shape the design (cross-reference)

- **DPDP Rules 2025** (notified 13/14 Nov 2025), from secondary sources [P1]:
  - Rule 6 requires reasonable security safeguards, including access logs and monitoring, and retaining "logs and personal data for one year" for detecting and investigating unauthorised access unless another law requires otherwise. Rule 6 commences 13 May 2027.
  - Rule 7 requires breach intimation to the Data Protection Board and to affected Data Principals "without delay". A detailed report follows within a further period that I did **not** confirm here (often cited as 72 hours). **Unconfirmed in this doc.** Use the DPDP research doc as the authority.
- **Design consequence:** use one log platform with ≥365-day retention in India. That covers CERT-In's 180 days and DPDP's one year.

---

## 3. OWASP ASVS 5.0.0: Level 2 items most relevant to this app

Source: OWASP ASVS 5.0.0 (tag `v5.0.0_release`, English chapters) [A1]. Levels are as published. "L1" items are included where L2 builds on them. Quotes are abridged.

| ID | Lvl | Requirement (abridged) | Phoenix module(s) |
|---|---|---|---|
| 1.2.4 | L1 | Parameterized queries / ORM against SQL injection | all (the `pg` layer) |
| 1.3.5 | L2 | Sanitize or disable user-supplied scriptable/template content (Markdown, CSS…) | messaging (templates), automation |
| **1.3.6** | L2 | "protects against Server-side Request Forgery (SSRF) attacks, by validating untrusted data against an allowlist of protocols, domains, paths and ports…" | **automation** (call webhook), ai (URL tools) |
| 1.3.7 | L2 | No templates built from untrusted input | messaging, automation |
| 2.1.3 / 2.3.2 | L2 | Business-logic limits documented per user and globally, then enforced | admissions, money, messaging |
| 2.3.3 | L2 | Business operations are transactional (all-or-nothing) | money, deals |
| 2.3.4 | L2 | Locking so limited resources cannot be double-booked | admissions (seats, counselling slots) |
| **2.4.1** | L2 | Anti-automation against "data exfiltration, garbage-data creation, quota exhaustion, rate-limit breaches, denial-of-service, or overuse of costly resources" | platform, admissions (public forms), ai (token cost), analytics (exports) |
| 3.3.1–3.3.4 | L1/L2 | Cookies: `Secure`; `__Host-` prefix (L2); `SameSite` per purpose (L2); `HttpOnly` for session tokens (L2) | platform |
| 3.4.1 | L1 | HSTS on all responses, max-age ≥ 1 year; "for L2 and up, the policy must apply to all subdomains" | platform |
| **3.4.3** | L2 | CSP "As a minimum, a global policy must be used which includes the directives object-src 'none' and base-uri 'none' and defines either an allowlist or uses nonces or hashes" (L3 requires per-response nonces/hashes) | platform (web) |
| 3.4.4–3.4.6 | L2 | `X-Content-Type-Options: nosniff`; Referrer-Policy; CSP `frame-ancestors` on every response ("X-Frame-Options … is obsolete") | platform |
| 3.2.1 | L1 | Prevent rendering in the wrong context (e.g. user-uploaded files): Sec-Fetch-*, CSP sandbox, attachment disposition | admissions (documents) |
| 3.5.1–3.5.3 | L1 | CSRF: anti-forgery tokens or non-safelisted headers; sensitive functions not reachable via GET/HEAD | platform |
| 3.5.4 | L2 | Separate applications on separate hostnames | platform (serve user files from a separate host) |
| 3.7.2 | L2 | Redirects to other domains only by allowlist | platform, messaging (tracked links) |
| 4.1.3 | L2 | Intermediary-set headers (`X-Forwarded-*`, `X-Real-IP`) cannot be overridden by the end user | platform (Front Door → API) |
| 4.2.1 | L2 | Consistent HTTP message boundaries (request smuggling) | platform |
| 4.4.2 | L2 | WebSocket handshake checks Origin | messaging (live inbox, if WS) |
| 5.1.1 | L2 | Document permitted types, extensions, max (unpacked) size, and malicious-file behaviour per upload feature | admissions, contacts (imports) |
| 5.2.1–5.2.3 | L1/L2 | Size limits; extension and content (magic bytes) match; archive uncompressed-size and file-count limits | admissions, contacts |
| 5.3.1–5.3.2 | L1 | Uploaded files never executed; internally generated paths, not user filenames | admissions |
| 5.4.1–5.4.2 | L2 | Ignore user filenames; set and encode `Content-Disposition` filename (RFC 6266) | admissions, messaging (attachments) |
| **5.4.3** | L2 | "files obtained from untrusted sources are scanned by antivirus scanners" | admissions, messaging (inbound WhatsApp media), contacts (CSV imports) |
| 6.1.1 / 6.3.1 | L1 | Documented and implemented credential-stuffing and brute-force controls | platform |
| 6.2.12 | L2 | New passwords checked against breached-password set | platform |
| **6.3.3** | L2 | MFA (or a combination of single-factor mechanisms) required to access the application | platform (staff) |
| 6.4.3 | L2 | Password reset does not bypass MFA | platform |
| 6.5.1, 6.5.4, 6.5.5 | L2 | OOB codes and TOTP single-use; ≥20 bits entropy; OOB lifetime ≤ 10 min, TOTP ≤ 30 s | platform, admissions (parent OTP) |
| 6.6.1–6.6.3 | L2 | SMS/phone OTP only to previously validated numbers, stronger alternatives offered; OOB codes bound to their request; rate-limited | admissions, messaging |
| 7.1.1–7.1.3, 7.3.1–7.3.2 | L2 | Documented and enforced idle and absolute session timeouts; concurrent-session policy | platform |
| 7.4.2 / 7.4.3 / 7.4.5 | L1/L2 | Kill sessions on account disable; option to kill other sessions after factor change; admin can terminate sessions | platform |
| 7.5.1 | L2 | Re-authentication before changing email, phone, MFA | platform |
| 8.2.1–8.2.2 | L1 | Function-level and data-specific authorization (IDOR/BOLA) | contacts, deals, admissions, money |
| **8.2.3** | L2 | Field-level authorization (BOPLA) | deals (value/discount), contacts (student PII), money |
| 8.3.1 | L1 | Enforce at a trusted service layer, not in client code | platform (do not rely on Next.js `proxy.ts` for authZ) |
| **8.4.1** | L2 | "multi-tenant applications use cross-tenant controls" | platform (groups never cross), deals (B2B institutes) |
| 11.1.1–11.1.2 | L2 | Key-management policy and crypto inventory | platform |
| 11.5.1 | L2 | CSPRNG with ≥128 bits for non-guessable values | platform |
| 12.1.1, 12.2.1, 12.3.1–12.3.4 | L1/L2 | TLS 1.2/1.3 only; TLS on all inbound/outbound incl. DB, Redis; validate certs; internal TLS with trusted CAs | platform |
| 13.1.1 | L2 | Document all communication needs, *including where an end user can supply an external location* | automation |
| **13.2.1** | L2 | Backend-to-backend auth via "individual service accounts, short-term tokens, or certificate-based authentication and not unchanging credentials" | platform (managed identity to Postgres, Key Vault, Storage) |
| 13.2.2 | L2 | Least-privilege service accounts | platform |
| **13.2.4–13.2.5** | L2 | Outbound allowlist of resources at app, server or firewall layer | automation, ai, messaging |
| **13.3.1–13.3.2** | L2 | "a secrets management solution, such as a key vault, is used to securely create, store, control access to, and destroy backend secrets"; least-privilege access to secrets | platform |
| 13.4.2–13.4.5 | L2 | No debug modes in prod; no directory listing; no TRACE; docs and monitoring endpoints not exposed | platform |
| 14.1.1–14.1.2 | L2 | Classify sensitive data into protection levels with documented requirements (encryption, retention, logging) | all; especially admissions (minors' data) |
| 14.2.1 | L1 | No sensitive data in URLs or query strings | all (Front Door access logs record request URIs) |
| 14.2.2–14.2.3 | L2 | No sensitive data cached in LB/app caches; no sensitive data to untrusted third parties (trackers) | platform, analytics, ai |
| 14.3.2–14.3.3 | L2 | `Cache-Control: no-store` for sensitive responses; no sensitive data in browser storage | platform, analytics |
| 15.1.1–15.2.1 | L1 | Documented remediation timeframes for vulnerable components, and adherence | platform |
| 15.1.2 | L2 | SBOM of third-party libraries | platform |
| 15.3.2 | L2 | Backend calls to external URLs do not follow redirects unless intended | automation |
| 15.3.3 | L2 | Mass-assignment protection per action | all (zod `.strict()` schemas) |
| 15.3.4 | L2 | Correct client IP through proxies for logging and rate limiting | platform |
| 15.3.6 | L2 | Prevent JavaScript prototype pollution | all |
| 16.1.1 | L2 | Log inventory: what, where, format, access, retention | platform |
| 16.2.1–16.2.5 | L2 | When/where/who/what metadata; synced UTC time; logs only to documented sinks; common format; **sensitive data logged per protection level ("credentials or payment details" not logged; tokens hashed or masked)** | platform |
| 16.3.1–16.3.4 | L2 | Log all authentication events (success and failure), failed authorization, bypass attempts, unexpected errors | platform |
| 16.4.1–16.4.3 | L2 | Encode against log injection; "logs are protected from unauthorized access and cannot be modified"; ship to a logically separate system | platform |
| 16.5.1–16.5.3 | L2 | Generic errors, no stack traces; graceful degradation; fail closed | platform |

---

## 4. Engineering controls in detail

### 4.1 CSP with nonces in the Next.js 16 App Router

Facts [X3, X4]:
- Next.js 16 renamed Middleware to **Proxy**. The file is `proxy.ts` and the export is `proxy`. It "defaults to using the Node.js runtime", and Edge is not supported in Proxy. `middleware.ts` still exists for Edge but is deprecated. Codemod: `npx @next/codemod@latest middleware-to-proxy .`
- Official pattern:
  - Generate `const nonce = Buffer.from(crypto.randomUUID()).toString('base64')` per request.
  - Build the CSP header: `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'` (plus `'unsafe-eval'` **only in development**), `style-src 'self' 'nonce-${nonce}'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.
  - Set the header on **both** the forwarded request headers (with `x-nonce`) and the response.
  - Next.js parses the nonce from the request CSP header. It applies the nonce automatically to framework scripts, page bundles, inline scripts and styles it generates, and `<Script nonce>`.
  - Read the nonce in Server Components with `(await headers()).get('x-nonce')`.
- Matcher: exclude `api`, `_next/static`, `_next/image` and `favicon.ico`, and skip prefetches (`next-router-prefetch` and `purpose: prefetch` headers).
- Consequences stated by Next.js:
  - "you **must use dynamic rendering** to add nonces". Use `await connection()` to force it.
  - "Static optimization and Incremental Static Regeneration (ISR) are disabled".
  - "Pages cannot be cached by CDNs without additional configuration".
  - "**Partial Prerendering (PPR) is incompatible** with nonce-based CSP".
- Alternative: experimental SRI (`experimental.sri.algorithm`) for hash-based CSP on static pages. It is App Router only, "Feature may change or be removed", and "Cannot handle dynamically generated scripts".

Phoenix decisions:
1. **CRM app (authenticated):** use nonce CSP via `proxy.ts`. These pages are per-user and dynamic anyway, so there is no caching loss. Set **`base-uri 'none'`**, not the Next.js example's `'self'`, because ASVS 3.4.3 names `base-uri 'none'` [A1]. Keep `object-src 'none'` and `frame-ancestors 'none'` (ASVS 3.4.6). Keep `form-action 'self'`.
2. **Public admissions/marketing pages:** if they are statically generated or use PPR/Cache Components, nonces will not work. Use a static header from `next.config.js` with SRI, or explicit hashes, without `'unsafe-inline'` for scripts. Otherwise make them dynamic. Note that `'unsafe-inline'` scripts would not meet the spirit of 3.4.3's intent to "limit execution of malicious JavaScript".
3. **Roll-out:** ship `Content-Security-Policy-Report-Only` first, with a reporting endpoint on the API, then enforce. (Engineering recommendation; reporting-endpoint mechanics not sourced here.)
4. **Express API:** Helmet 8 is already present. For JSON API responses use `default-src 'none'; frame-ancestors 'none'`, plus `nosniff`, `Cache-Control: no-store` for personal data (ASVS 14.3.2), and HSTS `max-age>=31536000; includeSubDomains` (ASVS 3.4.1, L2 subdomains). `app.disable('x-powered-by')` and custom 404/error handlers are in Express's own guidance [E1].
5. **Authorization is not done in `proxy.ts`.** Proxy may do coarse redirects only. Every API handler re-checks session and permission (ASVS 8.3.1). The existing architecture already does this per route.
6. **Patch level (P0):**
   - React2Shell (CVE-2025-55182, pre-auth RCE in RSC, fixed in Next.js 16.0.7) [X5].
   - DoS and source-exposure follow-ups CVE-2025-55184/55183/67779 (Next.js 16.0.10) [X6].
   - 2026 critical RCEs: GHSA-2xp9-vwfh-vxw4 (AVIF image optimisation), GHSA-vcvr-r3jv-pc5j (`next/og`, fixed 16.3.6), GHSA-2464-fhr4-w9xw (SVG in image optimisation), GHSA-673q-mjm6-r5xr (`use cache` typed arrays). The last two are fixed in **16.4.1** [X1].
   - 3 Nov 2026 batch: 7 medium advisories covering ≤16.4.2 (cache disclosure, HttpOnly cookie exposure on Edge routes, image-optimisation SVG bypass) [X1]. npm `latest` = **16.4.5**, published 3 Nov 2026 [X2]. Which release patches this batch is **unconfirmed**: the advisory API lists `16.4.2` for one and blank for others. Target ≥16.4.5 and recheck the advisory pages.
   - Also: restrict `images.remotePatterns` to known hosts. GHSA-cjq9-62q9-8jv4 is an image-optimisation SSRF. Do not enable SVG optimisation.

### 4.2 SSRF defences for the automation "call webhook" action

Threat: a tenant user configures a URL, and the worker calls it. Targets an attacker would aim at in Azure:
- **IMDS** `169.254.169.254`, listed by OWASP [O1].
- **The App Service/Functions local token service** at `IDENTITY_ENDPOINT` ("a local URL"). Requests to it need `X-IDENTITY-HEADER`, described as "A header that can help mitigate server-side request forgery (SSRF) attacks. The platform rotates the value" [M2].
- **`168.63.129.16`**, a "virtual public IP address" for Azure platform DNS, DHCP, health probes and the VM agent [M3]. It is *public*, so a generic private-range check will not block it.
- Redis, Postgres, private endpoints and anything else in the VNet.

Requirements (OWASP "Case 2: any external destination" uses a deny-list plus network controls [O1]; ASVS 1.3.6, 13.1.1, 13.2.4–5, 15.3.2 [A1]; Standard Webhooks SSRF section [SW1]):

1. **URL parsing and allowlist:**
   - Scheme `https:` only. No `http:` in production; allow it only behind a per-tenant flag if ever needed.
   - Port allowlist: `443`, plus optionally `8443`.
   - Reject userinfo (`user:pass@`), fragments and IP-literal hosts. Requiring a DNS name simplifies validation; alternatively allow literals but validate them identically.
   - Hostname max 253 characters. Normalise IDN to punycode.
2. **Resolve, then validate every address:**
   - Use `dns.lookup(host, { all: true, verbatim: true })` and reject if *any* A/AAAA result is non-global.
   - Deny at least:
     - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, plus **`168.63.129.16/32`**.
     - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `64:ff9b::/96` (NAT64) and `::ffff:0:0/96`. For mapped addresses, extract the embedded IPv4 and re-check it.
   - Implement with Node's `net.BlockList`, or a parser that resists alternate encodings. OWASP cites `ip-address` as not exposed to hex/octal/dword/mixed-encoding bypasses [O1].
3. **Pin the connection to the validated IP (anti-DNS-rebinding).** OWASP: "checking DNS answers separately does not prevent DNS rebinding". Connect only to the validated address. Keep the original hostname for Host, SNI and certificate validation [O1]. In Node, do the validation inside a custom `lookup` function passed to the socket connect options (for example an undici `Agent`'s `connect` options). The address that is validated is then the address used.
4. **No redirects:** set `redirect: 'manual'` and treat 3xx as failure (ASVS 15.3.2). Standard Webhooks also treats `3xx` as failure and recommends updating the URL instead [SW1].
5. **Bounded calls:**
   - Connect timeout about 5 s; total timeout 15–30 s (Standard Webhooks recommends "between 15 and 30s" [SW1]).
   - Cap response body size (for example 64 KB read, then discard).
   - Never show the raw response body to the user. Store only status, latency and a truncated, sanitised snippet. This makes SSRF blind.
   - Cap concurrency per tenant and per destination host.
6. **Network layer (defence in depth):** run webhook workers, or a dedicated egress proxy such as Stripe's smokescreen (named in [SW1]), in their **own subnet**. That subnet's NSG/Azure Firewall should deny the VNet address space, private endpoints, `168.63.129.16` (where permitted) and IMDS, and allow only `443` to the Internet via NAT Gateway. OWASP: segregation is "highly recommended in order to block illegitimate calls directly at network level itself" [O1].
7. **Permission and audit:**
   - Creating or changing a webhook action needs a dedicated permission (for example `automation.webhooks.manage`).
   - Write every configuration change and every call (destination host, resolved IP, status) to the audit log and app log.
   - Alert on validation rejections, which are bypass attempts (ASVS 16.3.3).
8. **Outbound signing:** sign Phoenix-sent webhooks per Standard Webhooks:
   - Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`.
   - Signature `v1,<base64 HMAC-SHA256 of "msg_id.timestamp.payload">`. Secrets use the `whsec_` prefix and are **unique per endpoint**.
   - During rotation, send signatures from both the old and new key, space-separated [SW1].
   - Store endpoint secrets in Key Vault, or encrypted with a Key Vault-held key.
9. **Same guard elsewhere:** reuse the same egress guard for any other user-influenced fetch: AI "browse/fetch URL" tools, link previews in messaging, and import-from-URL in contacts.

### 4.3 Webhook replay protection (inbound)

General rules [SW1, A1]:
1. **Capture the raw body** before parsing. In Express 5, mount the provider routes with `express.raw({ type: 'application/json', limit: '1mb' })`, or the `verify` option of `express.json`. Compute the HMAC over the exact bytes. Razorpay notes that re-serialising parsed JSON can change the bytes and invalidate the signature [R1].
2. **Constant-time compare** with `crypto.timingSafeEqual` on equal-length buffers. Standard Webhooks: failing to do so "can expose consumers to timing-attacks" [SW1].
3. **Timestamp tolerance** where the sender signs a timestamp. Standard Webhooks: "verify the `webhook-timestamp` header has a timestamp that is within some allowable tolerance of the current timestamp to prevent replay attacks" [SW1]. Phoenix choice: ±5 minutes, which depends on synced clocks (§2.3).
4. **Event-ID dedupe:**
   - Standard Webhooks: "Use the `webhook-id` header as an idempotency key" [SW1].
   - Razorpay: deduplicate on `x-razorpay-event-id`. Delivery is at-least-once, so duplicates are expected [R1].
   - Implement as `INSERT … ON CONFLICT DO NOTHING` into `webhook_events(provider, event_id UNIQUE, received_at, signature_ok, payload_hash)`. This is durable and stronger than a Redis TTL key. Optionally keep a Redis `SET NX` as a fast path.
   - Keep rows for at least the provider's retry horizon. Razorpay's retry window is described as about 24 h in a Razorpay blog (**unconfirmed** in the API reference).
5. **Providers that do not sign a timestamp:** if Razorpay's signature does not cover a timestamp (**unconfirmed**; the docs describe HMAC over the body only [R1]), replay protection rests on event-ID dedupe **plus business idempotency**. A `payment.captured` for an already-captured payment is a no-op. Razorpay's own blog warns that event-level dedupe alone is not enough because different events can concern the same payment [R1].
6. **Fast ack:** respond 2xx quickly and process asynchronously through BullMQ. Razorpay mentions the case where a server "fails to respond in 5 seconds" [R1].
7. **Secret rotation:** Razorpay applies a new secret only to events generated after the change, so retries of older events still use the old secret [R1]. Accept both secrets during an overlap window.
8. **Meta/WhatsApp Cloud API:** verify the `X-Hub-Signature-256` HMAC-SHA256 with the app secret and dedupe on message/status IDs. Cross-check the exact header format with the WhatsApp research doc (**not re-verified here**).
9. **Rate-limit and log** webhook endpoints, including Front Door rate-limit rules on `/webhooks/*`. Treat bursts of invalid signatures as a security event (ASVS 16.3.3).

### 4.4 File upload validation and malware scanning

ASVS V5 [A1] sets the rules. Azure Defender for Storage provides scanning [M4].

Pipeline:
1. **Per-feature policy document** (ASVS 5.1.1). For each upload point, record: allowed extensions and MIME types, maximum size (including unpacked size), and what happens on detection. Upload points include admissions documents (marksheets, ID proofs, photos), contacts CSV/XLSX imports, messaging attachments (outbound) and inbound WhatsApp media.
2. **Upload path:** the client gets a short-lived, write-only, single-blob SAS (user-delegation SAS signed via managed identity, so there is no account key) for a **quarantine** container. The blob name is server-generated (UUID), never the user filename (ASVS 5.3.2). Alternatively, stream through the API with a hard size limit (ASVS 5.2.1).
3. **Validation worker:**
   - Check that the extension is allowlisted *and* the magic bytes match the declared type (ASVS 5.2.2).
   - For archives and OOXML (`docx`/`xlsx` are zip files), check total uncompressed size and file count before extraction (ASVS 5.2.3).
   - Re-encode images (strip EXIF, which can contain the location of a minor's home).
   - For CSV imports, neutralise formula-injection prefixes (`=`, `+`, `-`, `@`) on export. (Engineering recommendation; not in ASVS L2 text quoted here.)
4. **Malware scanning (ASVS 5.4.3):** enable Defender for Storage **on-upload malware scanning** on the quarantine account. Facts [M4]:
   - Uses Microsoft Defender Antivirus. Scans all file types including ZIP/RAR, up to **50 GB** per blob.
   - Results arrive as blob index tags (`No threats found` / `Malicious` / `Error` / `Not scanned`), Defender alerts, Event Grid events and the `StorageMalwareScanningResults` Log Analytics table.
   - Built-in soft-delete remediation is available.
   - "Malware scanning is performed in the same Azure region as your storage account", and "The service doesn't store scanned files". It may share file metadata such as the SHA-256 hash with Defender for Endpoint.
   - Limitations: append and page blobs are not supported; client-side-encrypted blobs cannot be scanned; chunked fragments may evade detection; the scan timeout is 30 min to 3 h; not all regions are supported. Central India support is **unconfirmed**; check the availability page.
   - "Index tags aren't tamper-resistant … you shouldn't use them as a sole security control". So **promote quarantine → clean only on an Event Grid scan-result event**, handled by a worker with its own identity. Never let the app read from quarantine.
   - Pricing was not fetched (**unconfirmed**).
5. **Serving:**
   - Serve user files from a separate hostname (for example `files.<domain>`, ASVS 3.5.4) through short-lived read SAS, or proxy through the API.
   - Set `Content-Disposition: attachment; filename*=UTF-8''<sanitised>` (ASVS 5.4.1–5.4.2), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` (ASVS 3.2.1) and `Cache-Control: private, no-store` for students' documents.
6. **Audit and retention:** log each upload, scan result and download, with no file contents in logs. Apply retention and erasure rules per the DPDP doc.

### 4.5 Azure Key Vault and managed identity

Facts:
- Key Vault references in App Service use the app's system-assigned identity by default, or a specified user-assigned one. RBAC vaults need the **Key Vault Secrets User** role. App Service caches referenced values and refetches every **24 hours**; a config change forces a refetch. Versionless `SecretUri` tracks the latest version. Container Apps refreshes within **30 minutes** [K1].
- Soft-delete retention is **7–90 days (default 90)**, "can only be configured during key vault creation". Purge protection cannot be turned off once enabled. With RBAC enabled, vault access policies are ignored [K2].
- Managed identity role changes can take "around 24 hours" to apply because of back-end token caching [M2].
- Azure Database for PostgreSQL flexible server accepts Entra access tokens from managed identities (token for `ossrdbms-aad.database.windows.net` used as the password). Password authentication can be disabled [PG2].

Requirements:
1. One Key Vault per environment (prod, staging) in Central India, with these settings:
   - **RBAC permission model**
   - **purge protection on**
   - soft-delete 90 days
   - public network access disabled, with a private endpoint from the app VNet
   - diagnostic `AuditEvent` logs to the Central India workspace (≥180 days)
   - a `CanNotDelete` resource lock.
2. The API, the worker and the web server each get their **own user-assigned managed identity**. Grant `Key Vault Secrets User` scoped to the specific secrets each needs, where practical (ASVS 13.3.2). There are no human "Secrets Officer" standing assignments; use PIM/JIT.
3. Secrets to move into Key Vault:
   - session/cookie signing keys
   - TOTP-secret encryption key
   - Razorpay key secret and webhook secret
   - WhatsApp/Meta app secret and access tokens
   - SMTP/SMS credentials
   - AI provider API keys
   - per-endpoint outbound webhook secrets (or a KEK that wraps them)
   - Redis credentials if Entra auth is not used.
   
   Nothing goes in `.env` files in images, the repo, App Settings plaintext, CI logs or Terraform state (ASVS 13.3.1).
4. Field-level encryption keys (for example Aadhaar/ID numbers, if ever stored) should be Key Vault **keys** used for envelope encryption (wrap/unwrap), not secrets in memory for life. Document them in the crypto inventory (ASVS 11.1.1–11.1.2).
5. **Postgres:**
   - Entra auth with the managed identity, with password auth disabled once migrated (ASVS 13.2.1).
   - Separate DB roles: `app_rw` (DML on business tables; **INSERT/SELECT only** on `audit_logs` and `outbox_events`), `migrator` (DDL, used only by CI), `readonly_analytics`.
   - Require TLS, and verify the certificate (ASVS 12.3.2).
6. Local development uses `DefaultAzureCredential`, which works with developer sign-in in dev and managed identity in Azure [M2].
7. Rotation: versionless references, plus a rotation runbook. Account for the 24-hour cache (or force a refresh) and dual-validity overlap for webhook secrets.

### 4.6 Azure Front Door WAF and rate limiting

Facts:
- **Tiers:** Standard supports custom WAF rules only. Microsoft-managed rule sets (DRS), **Bot Manager** and **Private Link origins** are **Premium** [F2, F3].
- **Rate limit rules** [F1]:
  - They are custom rules with a threshold "within a time period of either one minute or five minutes".
  - They count per **socket IP** by default (GA). Grouping by country, ASN, JA4 or None is **preview, Premium only**.
  - Windows are fixed. A group that exceeds the threshold is blocked "for the remainder of the fixed window".
  - Counters are per Front Door server: "for a low threshold (for example, less than about 200 requests per minute), you might see some requests above the threshold get through".
  - Actions include Block, Log and JS Challenge. Microsoft advises deploying grouped rules with the Log action first and keeping a per-IP rule.
- **Origin lockdown** [F3]:
  - Private Link (Premium) removes public exposure.
  - Otherwise, allow only the `AzureFrontDoor.Backend` service tag **and** validate the `X-Azure-FDID` header against the profile's Front Door ID. The service-tag ranges "are shared by all Front Door instances across all Azure customers".

Requirements:
1. **Front Door Premium** for production, with these settings:
   - WAF policy in **Prevention** mode with the DRS managed ruleset, after a tuning period in Detection mode
   - Bot Manager
   - per-IP rate-limit rules
   - HTTPS-only with TLS 1.2+ (ASVS 12.1.1).
2. Starting rate-limit rules. These are proposals; tune them from a week of `FrontDoorAccessLog` data as Microsoft suggests [F1]:

   | Path | Window | Threshold per socket IP | Action |
   |---|---|---|---|
   | `/api/auth/*` (login, OTP send/verify, password reset) | 5 min | 50 | Block |
   | Public admissions/lead forms | 5 min | 100 | JS Challenge (HTML) / Block (API) |
   | `/api/webhooks/*` | 1 min | 600 | Log first, then Block. Provider egress IPs may be shared, so allowlist them instead if they are published. |
   | Everything (`Host` size ≥ 0) | 5 min | 3,000 | Block |

3. **App-level limits in Redis as well.** Front Door is approximate and IP-based. Add per-user, per-tenant and per-phone-number limits for OTP sends, login failures, exports, AI calls and outbound webhooks (ASVS 2.4.1, 6.3.1, 6.6.3). Express's guidance suggests per-user+IP and per-IP failure counters, for example with `rate-limiter-flexible` [E1].
4. **Client IP correctness** (ASVS 4.1.3, 15.3.4): configure Express `trust proxy` so `req.ip` comes from Front Door's forwarded header, and never trust client-supplied `X-Forwarded-For` when the request did not come through Front Door. Front Door's exact client-IP header names (e.g. `X-Azure-ClientIP` / `X-Azure-SocketIP`) are **unconfirmed** in this research; verify them in the Front Door HTTP headers doc. With origin lockdown in place, only Front Door can reach the origin, which makes this safe.
5. Front Door access and WAF logs go to the Central India workspace with ≥180 days retention. These are the "firewall"/"IPS" logs that CERT-In FAQ Q37 names.

### 4.7 Backups and PITR for Azure Database for PostgreSQL flexible server

Facts [PG1]:
- Daily snapshot backups (first full, then differential) plus WAL archiving. "In general, the delay RPO … can be up to five minutes."
- Retention is **7 days by default, maximum 35**.
- Backups are AES-256 encrypted, cannot be exported, and are read-only to you.
- **Geo-redundant backup "only during server creation"**; you cannot change it after provisioning. Geo-restore RPO is up to 1 hour. "Currently, PITR of geo-redundant backups isn't available", so a geo-restore goes to the last copied backup.
- Zone-redundant backup storage "restricts replication of data to within a country or region to meet data residency requirements".
- PITR "always creates a new database server". Parameters, firewall rules, private endpoints and VNet rules are **not copied**. Restoring across public and private access is not supported.
- "If you delete a server, all backups that belong to the server are also deleted and can't be recovered". Use management locks. (The doc also links "restore a deleted server" guidance; how long that window lasts was not checked.)
- On-demand backups: up to 7 per server; not on the Burstable tier or SSDv2.
- **Long-term retention** via Azure Backup: up to **10 years**. Backups are logical (pg_dump) and scheduled weekly, monthly or yearly. Maximum database size is 1 TiB. Restore is "as Files" only for now. Vault immutability and soft delete are available (soft delete in preview).
- Paired region for Central India is South India, both in India [M6].

Requirements:
1. Create the production server in **Central India**, zone-redundant HA if the budget allows, and **geo-redundant backup enabled at creation** (paired with South India, so it stays in India).
2. Set backup retention to **35 days**.
3. Put a `CanNotDelete` lock on the server and resource group. Restrict who can delete or restore through RBAC and PIM.
4. **Quarterly restore drill.** Run a PITR to a new server in the same VNet; run the post-restore checklist (parameters, private endpoint, Entra admin, roles, alerts); run app smoke tests; record the achieved RTO and RPO. The doc states "The best way to check backups is to perform periodic PITR".
5. Before risky migrations, take an on-demand backup (General Purpose tier or above).
6. Enable LTR with Azure Backup (monthly, 1–7 years per the records-retention decision), with backup-vault immutability. Also consider weekly `pg_dump` of critical schemas to an immutable Blob container in India.
7. Enable `pgaudit` (an Azure Policy built-in audits whether it is enabled [PG2]). At minimum, log DDL and role changes, plus connection logs. Send diagnostics to the Central India workspace.

### 4.8 Audit-log immutability

Current design: `audit_logs` is append-only with bigint identity keys, written in the same transaction as the change, with redaction of secrets and no foreign keys. Personal security events are stored per user.

Gaps against ASVS 16.4.2 ("cannot be modified") and 16.4.3 (ship to a logically separate system) [A1]:
1. **DB-enforced append-only.**
   - The runtime role has `INSERT, SELECT` only on `audit_logs`. `REVOKE UPDATE, DELETE, TRUNCATE`.
   - Add a `BEFORE UPDATE OR DELETE` trigger and a `TRUNCATE` trigger that `RAISE EXCEPTION`.
   - Only the `migrator` role owns the table. Owner-held privileges can bypass triggers, so ownership separation is the real control. Log any DDL on the table via `pgaudit`.
2. **Tamper evidence (hash chain or Merkle sealing).**
   - Per group, a sealer job runs every N minutes. It reads unsealed rows in id order and computes `row_hash = SHA-256(prev_hash || canonical_json(row))`. It writes a `audit_seals(group_id, from_id, to_id, root_hash, sealed_at)` row.
   - Sealing in a background job avoids hot-row contention on the write path.
   - A verifier job recomputes the hashes daily and alerts on mismatch.
3. **WORM copy.**
   - Export each sealed batch as NDJSON plus a seal file to a Blob container (Central India, ZRS/GZRS within India) with a **locked time-based retention policy** [S1]. Under a locked policy you can extend retention but never shorten it or delete the policy. Container-level policies allow at most 5 extensions. Microsoft recommends locking "typically less than 24 hours" after testing.
   - Retention = the audit-records period decided by legal (at least 365 days; see open questions).
   - Use a separate storage account with its own identity. The app identity has write-only (create) access; no human has delete.
   - Note: immutable storage "is **incompatible** with point-in-time restore" for blobs, so do not enable blob PITR on that account.
4. **Application and infrastructure logs** go to Log Analytics, which is a separate system from the app (16.4.3). Restrict workspace access with Azure RBAC, so no app-team write access. For extra assurance, export security tables to an immutable storage account (Log Analytics data export or Sentinel; not detailed here).
5. **Conflict with erasure:** audit diffs may contain personal data (names, phone numbers of parents and students). Prefer storing references and field names over raw values for PII fields. Alternatively, use crypto-shredding: encrypt PII values in the diff with a per-data-principal key, and delete the key on erasure. Legal must decide (open question).

### 4.9 PII redaction in logs

Facts:
- pino's `redact` takes paths (bracket notation and `*` wildcards). The `censor` option replaces values; `remove: true` drops the key.
- "paths are **case sensitive**". Wildcards "carry a non-trivial cost". pino redaction is built on fast-redact, about 2% overhead without wildcards.
- User input must never be used to build redaction paths [L1].
- Redaction is **path-based**. It does not scrub PII inside free-text messages or error strings. (Inference from the path-based design.)

Requirements (ASVS 14.1.1–14.1.2, 16.2.5, 16.4.1, 14.2.1) [A1]:
1. **Classify data** (P0 doc): Secret, Restricted PII, PII, Internal, Public.
   - **Secret:** passwords, tokens, OTP/TOTP, API keys, webhook secrets, `X-IDENTITY-HEADER`.
   - **Restricted PII:** minors' data, ID numbers (Aadhaar/PAN), marksheets, health and caste data if collected, payment instrument data.
   - **PII:** names, phone numbers, emails, addresses.
2. **Logging rule per class:**
   - Secret: never logged.
   - Restricted PII: never logged.
   - PII: logged only as a keyed HMAC pseudonym, for example `phone_h = HMAC(log_key, e164)`, so support can correlate without seeing the value. Or masked (`+91******1234`).
3. **Central pino configuration** shared by the API and workers:
   - `redact.paths` covering: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `req.headers["x-razorpay-signature"]`, `req.headers["x-hub-signature-256"]`, `req.headers["x-identity-header"]`, `*.password`, `*.newPassword`, `*.otp`, `*.totp`, `*.token`, `*.secret`, `*.apiKey`, `*.aadhaar`, `*.pan`, `*.dob`, `*.phone`, `*.email`, `body.message.text`.
   - Choose explicit paths over deep wildcards for performance.
   - Custom serializers that log `req.url` **without the query string** (ASVS 14.2.1 keeps secrets out of URLs anyway).
   - An error serializer that strips the `pg` error `detail` and `where` fields, which can echo row values such as `Key (email)=(…) already exists`.
4. **Module rules:**
   - **messaging:** never log message bodies, template variables or media URLs; log IDs and status only.
   - **ai:** do not log prompts or completions by default. If debugging is required, keep it per-tenant, time-boxed, redacted and kept on a short retention table.
   - **money:** never log card or UPI data. Log order and payment IDs, amounts, status.
   - **admissions:** never log document contents or ID numbers.
5. **Log injection:** keep structured JSON logs. pino JSON-encodes values. Never concatenate untrusted strings into the message field (ASVS 16.4.1).
6. **CI guard:** a unit test feeds a fixture object containing every classified field through the logger and fails if any raw value appears in the output.
7. **Log inventory** (ASVS 16.1.1): a table of each sink (pino → stdout → Log Analytics table, Front Door, Postgres, Key Vault, Storage, Redis), its fields, access group and retention (≥180 days, India). This doubles as the CERT-In log evidence.

---

## 5. Prioritised checklist for the security review and hardening wave

Legend: **P0** must be done before production traffic or within this wave. **P1** this wave if capacity allows, otherwise next. **P2** follow-up. Each item is tagged with its module.

### P0: compliance-critical and exploit-critical

- [ ] **SEC-01 [platform]** Designate the CERT-In Point of Contact and a deputy. Email the Annexure II details (Name, Designation, Organisation, Office Address, Email, Mobile, Office Phone, Fax) to `info@cert-in.org.in`. Re-send on any change. (Dir. (iii) [D1])
- [ ] **SEC-02 [platform]** Write and rehearse the **6-hour incident runbook**:
  - Record "time noticed" as the clock start.
  - Use a triage table mapped to Annexure I (i)–(xx).
  - File the first report by email to `incident@cert-in.org.in` (phone 1800-11-4949, fax 1800-11-6969) using the current CERT-In form, with partial info allowed and supplementary reports later (FAQ Q30).
  - Attach relevant logs.
  - Vendor incidents that Phoenix notices are Phoenix's to report (Q13, Q31).
  - Run the DPDP Board and data-principal notification track in parallel (DPDP doc).
  - Verify the rank of anyone requesting logs (Q38). (Dir. (ii) [D1, D2])
- [ ] **SEC-03 [platform]** **Logs of all ICT systems, ≥180 days rolling, in India.**
  - Use a Log Analytics workspace in Central India with analytics or total retention ≥ **365 days** (default 30 days is non-compliant) [M5].
  - Diagnostic settings for: Front Door access and WAF; App Service/Container Apps console and HTTP logs; workers; Postgres server logs and pgaudit; Key Vault AuditEvent; Storage (including malware-scan results); Redis; Entra sign-in and audit logs; Azure Activity log.
  - Record success and failure events (Q37).
  - Restrict workspace RBAC. (Dir. (iv), ASVS 16.1.1, 16.4.2–16.4.3)
- [ ] **SEC-04 [platform]** **Time:**
  - Rely on Azure native time sync (FAQ Q42).
  - Any self-managed NTP points to `samay1.nic.in` / `samay2.nic.in` / `time.nplindia.org` (Q43).
  - All logs and audit rows use UTC ISO-8601 with `Z` or an explicit offset (Q40, ASVS 16.2.2).
  - Add a health check alerting on clock skew > 1 s on any VM/node.
- [ ] **SEC-05 [platform]** **Patch and pin frameworks:**
  - Next.js ≥ **16.4.5** (latest at 3 Nov 2026; covers React2Shell, the 16.4.1 critical RCEs, and likely the 3 Nov batch, **confirm**). Verify via `npm ls next react react-dom`.
  - React at a patched 19.2.x.
  - Express ≥ 5.3.0, Helmet 8.x.
  - Turn on Dependabot/Renovate plus `npm audit` in CI.
  - Write remediation SLAs (critical ≤ 72 h, high ≤ 7 d; proposal) (ASVS 15.1.1, 15.2.1).
  - Do not enable SVG image optimisation. Restrict `images.remotePatterns`. [X1–X6]
- [ ] **SEC-06 [platform]** **Key Vault and managed identities:**
  - RBAC model, purge protection, soft-delete 90 days, private endpoint, resource lock, `AuditEvent` logs.
  - Per-service user-assigned identities with `Key Vault Secrets User`.
  - Move every secret listed in §4.5; no secrets in env files, images, repo or CI logs.
  - Postgres via Entra token, then disable password auth.
  - Least-privilege DB roles. (ASVS 13.2.1–13.2.2, 13.3.1–13.3.2 [K1, K2, PG2])
- [ ] **SEC-07 [automation]** **SSRF-safe "call webhook" action:**
  - `https` and port 443 allowlist; no userinfo.
  - Resolve all A/AAAA and deny non-global ranges plus `169.254.169.254` and `168.63.129.16`; pin the connection to the validated IP.
  - No redirects; 5 s connect / 15–30 s total timeouts; response-size cap; no response body echoed to the user.
  - Isolated egress subnet (or smokescreen-style proxy) whose NSG/Firewall denies VNet, private endpoints and platform IPs.
  - Dedicated permission; audit every config change and call.
  - Per-tenant concurrency and rate limits.
  - (ASVS 1.3.6, 13.1.1, 13.2.4–13.2.5, 15.3.2 [O1, M2, M3, SW1])
- [ ] **SEC-08 [money]** **Payment webhooks:**
  - Raw-body HMAC-SHA256 verification before parsing; `timingSafeEqual`.
  - Unique `(provider, event_id)` on `x-razorpay-event-id`.
  - Business-level idempotency on payment and order ID, so a replayed or duplicate event is a no-op.
  - 2xx within 5 s, then async processing.
  - Dual-secret overlap on rotation.
  - Log invalid-signature bursts as security events. [R1, SW1]
- [ ] **SEC-09 [messaging]** **Inbound WhatsApp/SMS/email-provider webhooks:**
  - Signature verification (Meta `X-Hub-Signature-256`, per the WhatsApp doc), raw body, constant-time compare.
  - Dedupe on provider message/status IDs.
  - Timestamp tolerance ±5 min where the provider signs a timestamp.
  - Message bodies never logged. [SW1]
- [ ] **SEC-10 [admissions]** **Document upload pipeline:**
  - Per-feature allowlist and size policy documented.
  - Write-only user-delegation SAS into a quarantine container with server-generated names.
  - Magic-byte check, archive limits, image re-encode with EXIF strip.
  - **Defender for Storage on-upload scanning**; promote to the clean container only on an Event Grid "No threats found" result, never on index tags alone.
  - Serve from a separate host with `attachment`, `nosniff`, `sandbox` CSP and `no-store`.
  - Log uploads, scan results and downloads.
  - (ASVS 5.1.1, 5.2.1–5.2.3, 5.3.1–5.3.2, 5.4.1–5.4.3, 3.2.1, 3.5.4 [M4])
- [ ] **SEC-11 [contacts]** The same scanning and validation applies to CSV/XLSX imports: zip-bomb limits for XLSX, formula-injection neutralisation on export, row and size caps, and the import job runs under the importing user's permissions. (ASVS 5.2.3, 2.4.1)
- [ ] **SEC-12 [platform]** **Front Door Premium and WAF:**
  - DRS managed rules (Detection, then Prevention) and Bot Manager.
  - Per-IP rate-limit rules on auth, OTP, public forms, webhooks and a global rule.
  - Origin lockdown via Private Link, or the `AzureFrontDoor.Backend` service tag plus `X-Azure-FDID` check.
  - Express `trust proxy` configured so `req.ip` is Front Door's client IP.
  - Mirror the limits in Redis per user, tenant and phone number.
  - (ASVS 2.4.1, 4.1.3, 6.3.1, 15.3.4 [F1–F3, E1])
- [ ] **SEC-13 [platform]** **Postgres resilience:**
  - Geo-redundant backup selected **at creation** (Central India→South India).
  - Retention 35 days; `CanNotDelete` locks.
  - Documented restore runbook including re-applying parameters, private endpoint, Entra admin and alerts.
  - First PITR drill before go-live, then quarterly. [PG1, M6]
- [ ] **SEC-14 [deals]** **Authorization tests**:
  - Every deal, quote and institute-account endpoint enforces unit/group scope (BOLA) and field-level rules (deal value, discount, margin).
  - No cross-group reads (B2B and B2C data in different groups never mix).
  - Strict zod schemas block mass assignment.
  - Automated negative tests per endpoint.
  - (ASVS 8.2.1–8.2.3, 8.4.1, 15.3.3)
- [ ] **SEC-15 [contacts]** Same authorization test suite for contacts, families and students: object-level and field-level (students' DOB, documents, guardian phone numbers) and cross-unit. Responses return only the fields the caller may see. (ASVS 8.2.2–8.2.3, 15.3.1)
- [ ] **SEC-16 [platform]** **Security headers and CSP:**
  - Nonce CSP in `proxy.ts` with `'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`; Report-Only first.
  - API responses `default-src 'none'`.
  - HSTS ≥ 1 year with `includeSubDomains`; `nosniff`; Referrer-Policy `strict-origin-when-cross-origin` or stricter.
  - Cookies `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax/Strict`.
  - `x-powered-by` disabled.
  - Proxy is not used for authZ.
  - (ASVS 3.3.1–3.3.4, 3.4.1–3.4.6, 8.3.1 [X3, X4, E1])

### P1: hardening this wave

- [ ] **SEC-17 [platform]** **Audit-log immutability:**
  - `INSERT/SELECT`-only grants, plus UPDATE/DELETE/TRUNCATE-blocking triggers and owner separation.
  - Background hash-chain sealer and daily verifier with alerting.
  - Sealed batches exported to a **locked** WORM Blob container in India, retention ≥ 365 days or per legal decision.
  - No blob PITR on that account. (ASVS 16.4.2–16.4.3 [S1])
- [ ] **SEC-18 [platform]** **PII redaction:**
  - Data classification doc.
  - Shared pino config with explicit `redact.paths`, query-stripping URL serializer and `pg`-error scrubber.
  - HMAC pseudonyms for phone and email.
  - CI test asserting no raw PII in logs.
  - Log inventory. (ASVS 14.1.1–14.1.2, 16.1.1, 16.2.5, 16.4.1 [L1])
- [ ] **SEC-19 [ai]** AI module:
  - No prompt or completion logging by default.
  - Provider keys in Key Vault.
  - Send the AI provider only the minimum fields needed, with no Restricted PII unless the DPA and consent allow it.
  - URL-fetching tools go through the SEC-07 egress guard.
  - Per-tenant token and cost limits.
  - Treat prompt-injection-driven data access as Annexure I (xx) in triage.
  - (ASVS 2.4.1, 14.2.3, 1.3.6)
- [ ] **SEC-20 [platform]** **Staff authentication:**
  - MFA mandatory for all staff (TOTP exists; enforce it).
  - Breached-password check on set and change.
  - Credential-stuffing controls; reset does not bypass MFA.
  - Documented idle and absolute session timeouts; sessions killed on disable; option to kill other sessions after a factor change.
  - Re-auth for email, phone or MFA changes.
  - All auth successes and failures logged.
  - (ASVS 6.2.12, 6.3.1, 6.3.3, 6.4.3, 7.1.1, 7.3.1–7.3.2, 7.4.2–7.4.3, 7.5.1, 16.3.1)
- [ ] **SEC-21 [admissions]** **Parent/student OTP:**
  - Single-use, 6 random digits (≥20 bits), lifetime ≤ 10 min, bound to the originating request.
  - Rate-limited per phone and per IP; sent only to numbers validated earlier in the flow.
  - Seat and slot booking uses DB-level locking or constraints so nothing is double-booked.
  - (ASVS 6.5.1, 6.5.4–6.5.5, 6.6.1–6.6.3, 2.3.4)
- [ ] **SEC-22 [messaging]** Outbound campaigns:
  - Per-tenant send quotas and anti-automation (stops spam and cost abuse); template rendering sandboxed, never built from untrusted templates.
  - Tracked-link redirects only to allowlisted destinations.
  - WebSocket inbox (if any) checks Origin.
  - (ASVS 1.3.5, 1.3.7, 2.4.1, 3.7.2, 4.4.2)
- [ ] **SEC-23 [analytics]** Exports and reports:
  - Row and size caps and rate limits; `Cache-Control: no-store`.
  - Field-level authorization on PII columns.
  - Every export written to the audit log (who, filter, row count).
  - Export files delivered via short-lived SAS and auto-expired.
  - No PII sent to third-party trackers on CRM pages.
  - (ASVS 2.4.1, 8.2.3, 14.2.3, 14.3.2)
- [ ] **SEC-24 [money]** Financial-transaction records are reconstructable (who, when with time zone, IP, amounts, IDs) and stored in India (FAQ Q36). No card or UPI data is logged. Refund and discount actions require a dedicated permission and are audited. (Dir. (iv) [D2]; ASVS 2.3.3, 16.2.5)
- [ ] **SEC-25 [platform]** Production hygiene:
  - Generic error responses with no stack traces; debug off.
  - TRACE disabled; no `.git` in images.
  - OpenAPI docs, metrics and health detail not public; the Next.js dev server or MCP endpoint never exposed (cf. GHSA-39w2-rjm5-chcv).
  - Fail closed on validation errors.
  - (ASVS 13.4.1–13.4.5, 15.2.3, 16.5.1–16.5.3)
- [ ] **SEC-26 [platform]** TLS everywhere: TLS 1.2+/1.3 at Front Door; TLS with certificate verification to Postgres and Redis; internal service calls over TLS. (ASVS 12.1.1, 12.3.1–12.3.4)
- [ ] **SEC-27 [deals]** **Direction (v) hedge:** for B2B institute customers, retain validated legal name, address, contact numbers, ownership type, service start and end dates, and onboarding email, IP and timestamp for **5 years after termination**, until counsel confirms (v) does not apply. (Dir. (v) [D1]; open question)

### P2: follow-up

- [ ] **SEC-28 [platform]** LTR backups via Azure Backup (monthly, immutable vault) plus periodic `pg_dump` to immutable Blob; test "restore as files". [PG1]
- [ ] **SEC-29 [platform]** Front Door grouped rate limits (JA4/ASN, Premium preview) in Log mode, then Challenge, alongside the per-IP rules. [F1]
- [ ] **SEC-30 [platform]** SBOM generation in CI (CycloneDX), plus crypto inventory and key-management policy. (ASVS 11.1.1–11.1.2, 15.1.2)
- [ ] **SEC-31 [platform]** Annual CERT-In tabletop exercise (6-hour clock), and an external penetration test against ASVS L2. Check whether a CERT-In-empanelled auditor is expected for Phoenix's sector (**unconfirmed**).
- [ ] **SEC-32 [admissions]** Static public pages: move to SRI or hash-based CSP if they must stay static (experimental feature; re-evaluate each Next.js minor). [X3]

---

## 6. Open questions

1. **Direction (v) scope:** does selling hosted CRM/ERP software to institutes make Phoenix a "Cloud Service provider" that must keep subscriber records for 5 years? The term is undefined [N1]. SEC-27 is the hedge. This needs counsel.
2. **Compute platform:** App Service, Container Apps or AKS? This affects identity-endpoint SSRF targets, Key Vault reference refresh (24 h vs 30 min), NTP responsibility (AKS nodes and VMs), and egress-subnet design.
3. **Front Door tier:** Premium is required for managed rules, Bot Manager and Private Link. Budget confirmation is needed.
4. **DPDP breach timelines:** Board intimation "without delay" plus a detailed report within a period I did not confirm here (often cited as 72 hours). Confirm in the DPDP research doc and align the incident runbook.
5. **Audit and log retention beyond 365 days:** education records, GST/accounting (money module) and dispute windows may need longer. Set the WORM lock period only after legal sign-off, because a locked policy cannot be shortened [S1].
6. **Erasure vs immutable audit:** should diffs keep PII values, references only, or crypto-shredded values?
7. **Aadhaar or ID documents in admissions:** if Aadhaar numbers or copies are collected, the Aadhaar Act and UIDAI storage rules apply (out of scope here).
8. **Defender for Storage:** is malware scanning available in Central India, and what does it cost? Not verified [M4].
9. **Front Door client-IP headers:** exact names and semantics (`X-Azure-ClientIP`, `X-Azure-SocketIP`, `X-Forwarded-For`) are needed for the `trust proxy` config. Not verified.
10. **Next.js 3 Nov 2026 advisories:** which patch release fixes each one? The GitHub API lists `16.4.2` for one and blank for others. Assume ≥16.4.5 and re-check [X1, X2].
11. **Razorpay signature:** does it cover any timestamp? If not, replay defence relies on event-ID dedupe and business idempotency.
12. **CERT-In reporting channel:** CERT-In says formats "will be updated from time to time". Check cert-in.org.in for the current form or portal before go-live. I found no post-2022 amendment to the Directions, but did not exhaustively check CERT-In notifications (**unconfirmed**).
13. **Redis (Azure Cache / Azure Managed Redis):** is Entra/managed-identity auth available on the chosen SKU, or is an access key needed (stored in Key Vault)? Not researched.

---

## 7. Sources (all accessed 6 November 2026)

**CERT-In and Indian law**
- [D1] CERT-In, Directions No. 20(3)/2022-CERT-In dated 28 April 2022 under s.70B(6) IT Act (PDF, 8 pp.). https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf
- [D2] CERT-In, *FAQs on Cyber Security Directions of 28.04.2022*, May 2022 (PDF, 28 pp.). https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf
- [N1] Secondary reports of the June 2022 extension to 25 Sept 2022 (MSMEs; validation parts of Dir. (v)): Internet Freedom Foundation https://internetfreedom.in/delaying-the-inevitable-implementation-of-cert-ins-cybersecurity-directions-gets-a-piecemeal-extension/; Business Today https://www.businesstoday.in/industry/it/story/cert-in-extends-msmes-cybersecurity-compliance-deadline-to-september-25-339484-2022-06-28; JSA Prism (June 2022) https://jsalaw.com/wp-content/uploads/2022/09/JSA-Prism-Information-Technology-June-20220565.pdf
- [P1] DPDP Rules 2025 (secondary): KPMG, *DPDP Rules 2025 guidance* (Nov 2025) https://assets.kpmg.com/content/dam/kpmgsites/in/pdf/2025/11/dpdp-rules-2025-guidance-to-dpdp-act-implementation.pdf; DPDPA rule 6 text mirror https://dpdpa.com/dpdparules/rule6.html. Primary gazette text not fetched in this research.

**OWASP and standards**
- [A1] OWASP ASVS 5.0.0, chapters V1–V16, tag `v5.0.0_release`. https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0/en
- [O1] OWASP Cheat Sheet Series, *Server-Side Request Forgery Prevention*. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- [SW1] Standard Webhooks specification. https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md

**Next.js, React, Express, pino**
- [X1] vercel/next.js GitHub Security Advisories (repository advisories API, entries 22 Sep – 3 Nov 2026). https://github.com/vercel/next.js/security/advisories
- [X2] npm registry metadata for `next` (latest 16.4.5, 3 Nov 2026; backport 15.5.29) and `express` (latest 5.3.0, 9 Oct 2026). https://registry.npmjs.org/next ; https://registry.npmjs.org/express
- [X3] Next.js docs, *How to set a Content Security Policy (CSP)* (lastUpdated 2026-03-20). https://nextjs.org/docs/app/guides/content-security-policy
- [X4] Next.js docs, *proxy.js* file convention, *Renaming Middleware to Proxy*, and *Next.js 16* blog. https://nextjs.org/docs/app/api-reference/file-conventions/proxy ; https://nextjs.org/docs/messages/middleware-to-proxy ; https://nextjs.org/blog/next-16
- [X5] GitHub Advisory GHSA-fv66-9v8q-g76r (CVE-2025-55182) and Vercel changelog. https://github.com/advisories/GHSA-fv66-9v8q-g76r ; https://vercel.com/changelog/cve-2025-55182
- [X6] Vercel security bulletin CVE-2025-55184 / CVE-2025-55183. https://vercel.com/kb/bulletin/security-bulletin-cve-2025-55184-and-cve-2025-55183
- [E1] Express, *Production Best Practices: Security*. https://expressjs.com/en/advanced/best-practice-security.html
- [L1] pino docs, *Redaction*. https://github.com/pinojs/pino/blob/main/docs/redaction.md

**Microsoft Azure**
- [M2] *Managed identities – Azure App Service* (ms.date 2026-04-14). https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity
- [M3] *Azure IP address 168.63.129.16 overview*. https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16
- [M4] *Introduction to Defender for Storage malware scanning* (ms.date 2026-07-03). https://learn.microsoft.com/en-us/azure/defender-for-cloud/introduction-malware-scanning
- [M5] *Manage data retention in a Log Analytics workspace*. https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure
- [M6] *Azure region pairs and nonpaired regions*. https://learn.microsoft.com/en-us/azure/reliability/regions-paired
- [K1] *Use Key Vault references as app settings – App Service*. https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references ; Container Apps secrets https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets
- [K2] *Azure Key Vault soft-delete overview* and Microsoft.KeyVault/vaults template reference. https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview ; https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/vaults
- [F1] *WAF rate limiting for Azure Front Door* (ms.date 2026-10-22). https://learn.microsoft.com/en-us/azure/web-application-firewall/afds/waf-front-door-rate-limit
- [F2] *Azure Front Door tier comparison* / pricing / WAF design guide. https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/tier-comparison ; https://learn.microsoft.com/en-us/azure/frontdoor/understanding-pricing ; https://learn.microsoft.com/en-us/azure/networking/design-guide/web-application-firewall
- [F3] *Secure traffic to origins – Azure Front Door*. https://learn.microsoft.com/en-us/azure/frontdoor/origin-security
- [PG1] *Backup and restore in Azure Database for PostgreSQL flexible server* (ms.date 2026-07-05). https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore
- [PG2] *Connect with managed identity* and *Microsoft Entra authentication* (Azure Database for PostgreSQL); Azure Policy support (pgaudit built-in). https://learn.microsoft.com/en-us/azure/postgresql/security/security-connect-with-managed-identity ; https://learn.microsoft.com/en-us/azure/postgresql/security/security-entra-concepts ; https://learn.microsoft.com/en-us/azure/postgresql/security/security-azure-policy
- [S1] *Immutable storage for blob data overview* (ms.date 2026-08-18). https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview

**Payment provider**
- [R1] Razorpay docs, *Validate and Test Webhooks* and *Webhooks Best Practices*; Razorpay blog *Payment Gateway Webhooks: Signatures, Retries & Logs*. https://razorpay.com/docs/webhooks/validate-test/ ; https://razorpay.com/docs/webhooks/best-practices/ ; https://razorpay.com/blog/payment-gateway-webhooks-india/ (pages seen via search results, not fetched in full)
