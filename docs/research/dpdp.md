# DPDP Act 2023 and DPDP Rules 2025: requirements for the Phoenix Group CRM

Prepared 6 November 2026 for Phoenix engineering. This is not legal advice. Anything marked **unconfirmed** could not be checked against a primary source in this research and needs counsel or a fresh Gazette check before anyone relies on it. Statements labelled **interpretation** are this document's reading of the text, not words in the law.

Citation keys: "s." means a section of the Digital Personal Data Protection Act, 2023 (Act 22 of 2023, the "Act"). "R." means a rule of the Digital Personal Data Protection Rules, 2025 (G.S.R. 846(E), 13 Nov 2025, the "Rules"). "Sch." means a Schedule to the Rules unless it says "Act Schedule". The Sources section at the end lists every source with its access date.

---

## 1. Summary

- **Dates.** The Act is being brought into force in three phases by G.S.R. 843(E), and the Rules follow the same phases under R.1:
  - **13 Nov 2025:** the Board, the definitions and some procedural provisions came into force.
  - **13 Nov 2026 (one week from today):** Consent Manager registration (s.6(9), s.27(1)(d), R.4).
  - **13 May 2027:** all substantive obligations: notice, consent, legitimate uses, security, breach notification, retention and erasure, children's data, rights, grievances, cross-border transfers and penalties.

  PIB (16 May 2026) confirms the Act is "fully enforceable from 13 May 2027". In January 2026 MeitY proposed shortening the 18-month window to 12 months, mainly for Significant Data Fiduciaries. No amending notification was found (secondary sources checked up to Sept/Oct 2026), so that proposal is **unconfirmed / not in force**. The only 2026 change found in the Gazette is the DPDP (Removal of Difficulties) Order, 2026 (S.O. 5458(E), 5 Oct 2026). It makes textual fixes to s.9(1) and s.10(2)(c)(ii).
- **Lawful basis.** Phoenix may process personal data only on **consent** or one of the **"certain legitimate uses"** listed in s.7 (s.4). The Act has **no general "legitimate interests" ground**. Cold marketing to bought or scraped lists therefore needs consent that can be shown to cover Phoenix. The one exception is data the person made public themselves, which is out of scope under s.3(c)(ii).
- **Consent** must be free, specific, informed, unconditional and unambiguous, given by a clear affirmative action, and limited to the data necessary for the purpose (s.6(1)). It must be preceded by a standalone notice that itemises the data and the purposes (s.5, R.3). Withdrawal must be as easy as giving consent (s.6(4), R.3(c)(i)). Phoenix carries the burden of proving notice and consent (s.6(10)). The consent ledger is therefore evidence, not just a log.
- **Children (under 18)** (s.2(f)):
  - Before processing any child's data, Phoenix must obtain **verifiable parental consent**, after checking that the person claiming to be the parent is an identifiable adult (s.9(1), R.10). R.10 accepts two kinds of check: (a) reliable identity and age details Phoenix already holds; or (b) identity and age details provided voluntarily by the parent, or a **virtual token** from an authorised entity, which expressly includes **DigiLocker**.
  - Two bans apply. **Tracking, behavioural monitoring and targeted advertising directed at children** are banned (s.9(3)), and so is any processing likely to harm a child's well-being (s.9(2)).
  - The exemption for **educational institutions** (Sch. 4 Part A item 3) is narrow. It lifts s.9(1) and s.9(3) only where processing is "restricted to tracking and behavioural monitoring" for the institution's educational activities or for the safety of enrolled children. Admissions marketing to prospective students very likely falls outside it (**interpretation**).
- **Rights:** access to a summary of the data and processing (s.11), correction, completion, updating and erasure (s.12), grievance redressal (s.13), and nomination (s.14). For a child, the parent is the "Data Principal" (s.2(j)). Responses are due within **90 days**: R.14(3), read with the PIB description. The gazetted wording of R.14(3) is garbled (see §3.8).
- **Retention:**
  - Erase personal data when consent is withdrawn or the purpose is no longer served, unless another law requires keeping it (s.8(7)).
  - Keep personal data, associated traffic data and processing logs for **at least one year** from processing, for government information requests, then erase them (R.8(3)). Security logs must also be kept one year (R.6(1)(e)).
  - The 3-year inactivity erasure rule in Sch. 3 applies only to large e-commerce, online-gaming and social-media platforms. It does not apply to Phoenix unless Phoenix reaches those user thresholds.
- **Breach:**
  - Tell each affected person **without delay**, with the content R.7(1) prescribes.
  - Tell the Board **without delay**, then send a detailed report **within 72 hours** (R.7(2)).
  - Separately, CERT-In requires a report **within 6 hours** and a rolling **180 days** of logs kept in India (CERT-In Directions, 28 Apr 2022).
- **Cross-border transfers** are allowed except to countries the government restricts by notification (s.16). R.15 adds that Phoenix must follow any government order about making data available to foreign States. No restricted list or order was found (**unconfirmed**).
- **Penalties** (Act Schedule):
  - Up to ₹250 crore for failing to keep reasonable security safeguards.
  - Up to ₹200 crore for a breach-notification failure.
  - Up to ₹200 crore for breaching the children's obligations.
  - Up to ₹50 crore for anything else.

---

## 2. Commencement timeline (each obligation)

Sources: G.S.R. 843(E) (Act commencement), R.1 as corrected by G.S.R. 892(E), PIB 2190014 and PIB 16 May 2026.

All dates count from publication of the Gazette dated **13 Nov 2025**. PIB says the Rules were "notified on 14 November 2025" (the Gazette PDF was signed on 14 Nov), and some commentators count from 14 Nov. **Plan against the earlier date.**

| Date | In force | What it means for Phoenix |
|---|---|---|
| 11 Aug 2023 | Act enacted | – |
| 13 Nov 2025 | s.1(2), s.2 (definitions), ss.18–26 (Board), ss.35, 38–43, s.44(1) and (3); R.1, R.2, R.17–21. Board established, headquartered in the NCR (G.S.R. 844(E)), with 4 members (G.S.R. 845(E)). | Nothing operational yet. Definitions fix the vocabulary. s.38: the Act adds to other laws and prevails where they conflict. |
| 6 Oct 2026 | Removal of Difficulties Order 2026: s.9(1) now reads "child or **of** a person with disability"; s.10(2)(c)(ii) "audit" becomes "data audit" | Textual only. |
| **13 Nov 2026** | s.6(9) (Consent Manager registration), s.27(1)(d) (Board powers over Consent Managers' breaches); R.4 and Sch. 1 | Consent Managers can register with the Board. Phoenix integration is optional (s.6(7) says "may"). |
| **13 May 2027** | ss.3–5 (application, grounds, notice); s.6(1)–(8) and (10) (consent); ss.7–10 (legitimate uses, general obligations, children, Significant Data Fiduciaries); ss.11–15 (rights and duties); s.16 (transfers); s.17 (exemptions); s.27 except (1)(d); ss.28–34 (Board procedure, appeals, penalties); ss.36–37; s.44(2) (repeal of IT Act s.43A). R.3, R.5–16, R.22, R.23 and Sch. 2–4 and 7. | **All CRM obligations in this document apply from this date.** Existing contacts must receive a s.5(2) notice "as soon as it is reasonably practicable" after this date. |
| Until 13 May 2027 | IT Act 2000 s.43A remains in force, because its omission sits in s.44(2) | The SPDI Rules 2011 regime continues until then. Its content was not verified here because the earlier download of the SPDI text failed (**unconfirmed**). |
| Already in force, separate law | CERT-In Directions No. 20(3)/2022 (effective 60 days after 28 Apr 2022) | 6-hour incident reporting, 180-day logs kept in India, clock sync to NIC/NPL NTP servers. |

**Watch items.** Re-check the Gazette before each release.

1. **The 12-month compression proposal.** MeitY consulted stakeholders on 22–23 Jan 2026, with comments due by 4 Feb 2026. Reports say it targets Significant Data Fiduciaries and may bring R.8(3) forward. As of 20 Sep 2026, MirvoLegal reported no amending notification. Legal500/Khurana (18 Mar 2026) describes it only as a proposal. **Unconfirmed / not notified.**
2. **Board appointments.** Applications were invited in May/June 2026. Most secondary sources (Aug–Sep 2026) report no Chairperson or Members appointed, and one outlier claims otherwise. **Unconfirmed.**

---

## 3. The rules in detail

### 3.1 Scope and roles

- **Personal data** is "any data about an individual who is identifiable by or in relation to such data" (s.2(t)). The Act covers digital personal data, including data collected on paper and digitised later (s.3(a)).
  - It also applies to processing outside India that is connected with offering goods or services to people in India (s.3(b)).
  - It does not apply to personal or domestic use, or to data made publicly available by the person themselves or under a legal obligation (s.3(c)).
  - **No B2B carve-out:** contact details of staff at client institutes are personal data.
- **Data Fiduciary** means whoever decides the purpose and means of processing (s.2(i)). **Data Processor** means whoever processes on a fiduciary's behalf (s.2(k)). The fiduciary stays responsible for processing done by its processors "irrespective of any agreement to the contrary" (s.8(1)). It may engage a processor only under a valid contract (s.8(2)), and that contract must include security safeguards (R.6(1)(f)).
  - **Phoenix B2C** (families and students): Phoenix is the Data Fiduciary.
  - **Phoenix B2B SaaS:** for the institutes' own student and parent data, the institute is the fiduciary and Phoenix is its processor (**interpretation**, depends on contract design). For Phoenix's own sales contacts at those institutes, Phoenix is the fiduciary.
- **Data Principal** means the individual. For a child, it **includes the parents or lawful guardian**. For a person with a disability, it includes the lawful guardian acting on their behalf (s.2(j)). Rights requests, notices and breach intimations for a student contact therefore go to and come from the verified parent.
- **Child** means an individual under 18 (s.2(f)).
- **Significant Data Fiduciary (SDF)** status applies only once the government notifies an entity or class (s.10(1)). An SDF must appoint a DPO based in India, appoint an independent data auditor, and run a DPIA and an audit every 12 months (s.10(2), R.13). No notification covering Phoenix was found, so **Phoenix is not an SDF unless notified (unconfirmed)**.
- **Startup exemption.** The government may exempt notified fiduciaries, including startups, from s.5, s.8(3), s.8(7), s.10 and s.11 (s.17(3)). No such notification was found (**unconfirmed**).

### 3.2 Notice: content and languages

- Every consent request must be "accompanied or preceded" by a notice (s.5(1)) that tells the person:
  1. what personal data will be processed and for what purpose;
  2. how to withdraw consent (s.6(4)) and use grievance redressal (s.13);
  3. how to complain to the Board.
- **R.3 adds three requirements:**
  - (a) The notice must be understandable "independently of any other information". PIB describes this as a standalone notice.
  - (b) It must use clear, plain language and include at minimum (i) an **itemised description of the personal data** and (ii) the **specified purpose(s)** plus a "specific description of the goods or services to be provided or uses to be enabled".
  - (c) It must give the **communication link** to the website or app, and describe any other means by which the person can (i) **withdraw consent, "with the ease of doing so being comparable to that with which such consent was given"**, (ii) exercise their rights, and (iii) complain to the Board.
- **Language.** The person must be given "the option to access" the notice (s.5(3)) and the consent request (s.6(3)) "in English or any language specified in the Eighth Schedule to the Constitution". The Eighth Schedule lists 22 languages: Assamese, Bengali, Bodo, Dogri, Gujarati, Hindi, Kannada, Kashmiri, Konkani, Maithili, Malayalam, Manipuri, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali, Sindhi, Tamil, Telugu, Urdu. This list comes from the Constitution and was not re-verified against a downloaded copy in this session, so check it before shipping the language picker. Whether all 22 must be offered, or only languages relevant to the audience, is an open question; the conservative reading is all 22 (see §5).
- **The consent request itself** must also carry the business contact details of the DPO, if there is one, or of a person authorised to respond to rights requests (s.6(3)).
- **Legacy data (s.5(2)).** For consent obtained before commencement, Phoenix must send a notice with the same content "as soon as it is reasonably practicable". It may continue processing until the person withdraws. The Act's own illustration names "email, in-app notification or other effective method".

### 3.3 Consent

- **Standard (s.6(1)).** Consent must be free, specific, informed, unconditional and unambiguous, "with a clear affirmative action", and limited to the personal data "necessary for such specified purpose".
  - The illustration: a telemedicine app's consent to read the phone contact list is not valid, because the contacts are not needed for the service.
  - Any part of a consent that infringes the Act or another law is invalid to that extent (s.6(2)). For example, a waiver of the right to complain to the Board is invalid.
  - **Itemised and purpose-specific (interpretation, from s.6(1) and R.3(b)):** one toggle per purpose, no bundling of marketing with service, and no pre-ticked boxes.
- **Withdrawal.** The person may withdraw "at any time", and doing so must be comparable in ease to giving consent (s.6(4)). Withdrawal does not make earlier processing unlawful, and the person bears its consequences (s.6(5)). For example, a service already paid for can still be fulfilled.
  - After withdrawal, Phoenix must "within a reasonable time, cease and cause its Data Processors to cease processing", unless law requires or authorises continuing (s.6(6)).
  - Phoenix must then erase the data under s.8(7)(a), subject to other laws and the R.8(3) minimum retention.
- **Consent Managers.** A person may give, manage, review or withdraw consent through a Consent Manager registered with the Board (s.6(7)–(9), R.4).
  - Registration conditions (Sch. 1 Part A): an Indian company, net worth of at least ₹2 crore, and an independently certified interoperable platform.
  - Obligations (Sch. 1 Part B): the Consent Manager must not be able to read the data it routes; it must keep records of consents given, denied or withdrawn, of the notices, and of data sharing, **for at least 7 years**; it must provide records in machine-readable form on request; and it must not sub-contract its obligations.
  - Registration opens **13 Nov 2026**. The Board has yet to publish its "data protection standards and assurance framework" (Sch. 1 Part A item 9), so no integration API standard exists yet (**unconfirmed**).
- **Burden of proof.** If consent is questioned in a proceeding, the fiduciary "shall be obliged to prove that a notice was given ... and consent was given" (s.6(10)).

### 3.4 Certain legitimate uses (s.7) relevant to Phoenix

- **s.7(a):** the "specified purpose for which the Data Principal has voluntarily provided her personal data ... and in respect of which she has not indicated ... that she does not consent". The illustrations are a pharmacy receipt SMS, and a broker responding to an inquiry who must stop when told help is no longer needed.
  - Relevance: a parent submits an inquiry form asking for a callback or a prospectus; an institute submits a demo request. Phoenix may respond for **that** purpose only. Marketing beyond it needs consent (**interpretation**).
- **s.7(d) and (e):** compliance with legal disclosure obligations, and with judgments or orders.
- **s.7(i):** employment purposes. This covers Phoenix's own staff data, not CRM contacts.
- **The s.7(a) basis still carries rights.** Access and correction/erasure rights expressly extend to data processed under s.7(a) (s.11(1), s.12(1)).
- **Children (interpretation).** s.9(1) requires verifiable parental consent before processing "any personal data of a child". The text does not say this is displaced where s.7 applies. Treat parental consent as required for student data, whatever the basis for the parent's own data.

### 3.5 Children's data (s.9, R.10, R.12, Sch. 4)

- **Obligation (s.9(1) as amended by the 2026 Order).** Before processing any personal data of a child, Phoenix must obtain the verifiable consent of the parent. "Consent of the parent" includes a lawful guardian.
- **Due diligence (R.10(1)).** Phoenix must adopt technical and organisational measures to obtain parental consent before processing. It must check "that the individual identifying herself as the parent is an adult who is identifiable if required in connection with compliance with any law" by reference to one of:
  - **(a)** "reliable details of identity and age of the individual available with the Data Fiduciary", for example a parent who is already a verified Phoenix account holder (illustration cases 1 and 3); or
  - **(b)** identity and age details voluntarily provided **(i)** by the individual, or **(ii)** "through a virtual token mapped to such details, which is issued by an authorised entity".
  - An "**authorised entity**" (R.10(2)(b)) means an entity entrusted by law or by the Central or a State Government with issuing identity and age details or tokens, or a person it appoints. It "also includes details of identity and age or token made available and verified by a **Digital Locker service provider**".
  - "**Adult**" means aged 18 or over (R.10(2)(a)).
  - Illustration cases 2 and 4: where the parent is not a registered user, the fiduciary checks against government-issued identity and age details or a mapped virtual token, and the parent "may voluntarily make such details available using the services of a Digital Locker service provider".
- **Who starts the flow.** Illustration case 1 has the child state that she is a child and name her parent; the fiduciary then "shall enable P to identify herself through its website, app or other appropriate means". Illustration case 3 has the parent open the account.
- **What R.10 does not say.** It does not expressly require verifying the parent-child relationship, only that the person is an identifiable adult (see §5). Whether a parent typing in ID details under R.10(1)(b)(i), without checking them against a government source, is enough is also unclear. The illustrations point to government-issued details or tokens (**interpretation**).
- **DigiLocker technical facts** (NeGD Requester API Specification v1.12, Sept 2023):
  - It uses OAuth 2.0 with PKCE (S256 only).
  - Optional `purpose` parameter values: `kyc`, `verification`, `compliance`, `availing_services`, `educational`.
  - Optional `consent_valid_till` (a Unix timestamp, IST).
  - The token response and the Get User Details API return `digilockerid`, `name`, **`dob` (DDMMYYYY)**, `gender` and an `eaadhaar` flag.
  - The spec addresses "trusted partners", so Phoenix needs DigiLocker requester onboarding. The onboarding process was not researched here (**unconfirmed**).
  - No official government "age token" or "parental consent" service built specifically for DPDP was found (**unconfirmed**). Whether a third-party aggregator's DigiLocker flow counts as "made available and verified by a Digital Locker service provider" is also **unconfirmed**.
- **Persons with disability (R.11).** A guardian's consent requires checking that the guardian was appointed by a court, a designated authority under the RPwD Act 2016 s.15, or a local level committee under the National Trust Act 1999 s.13.
- **Prohibitions.**
  - **s.9(2):** no processing "likely to cause any detrimental effect on the well-being of a child". Nothing exempts from this.
  - **s.9(3):** "A Data Fiduciary shall not undertake tracking or behavioural monitoring of children or targeted advertising directed at children."
- **Exemptions from s.9(1) and s.9(3)** (s.9(4), R.12). These remove the parental-consent and tracking/targeting bans only, never s.9(2).
  - **Sch. 4 Part A** (by class of fiduciary):
    - Item 3, **educational institution**: "Processing is restricted to tracking and behavioural monitoring (a) for the educational activities of such institution; or (b) in the interests of safety of children enrolled with such institution." An "educational institution" is "an institution of learning that imparts education, including vocational education".
    - Item 4: crèche and day-care carers, for safety.
    - Item 5: an entity engaged by an educational institution, crèche or child-care centre to transport enrolled children. Its processing is limited to location tracking during travel to and from the institution, for safety.
    - Items 1–2: healthcare.
  - **Sch. 4 Part B** (by purpose), each limited to what is necessary:
    - Item 1: functions under law in the interests of a child.
    - Item 2: State subsidies or benefits.
    - **Item 3:** creating a user account "limited to communication by email".
    - **Item 4:** real-time location tracking for safety.
    - **Item 5:** making sure harmful information, services or adverts are not accessible to the child.
    - **Item 6:** confirming that the person "is not a child" and carrying out R.10 due diligence. This is the legal basis for age gates.
  - **Interpretation for Phoenix:** the education exemption applies only to Phoenix entities that are themselves institutions of learning. Even then, processing must be confined to educational activities or the safety of **enrolled** children. Admissions lead nurturing, marketing to prospects and ad targeting are not obviously "educational activities", so plan on parental consent and the s.9(3) bans applying in full (see §5).
- **s.9(5).** The government may notify an age above which a "verifiably safe" fiduciary is exempt from s.9(1) and s.9(3). None has been notified (**unconfirmed**).

### 3.6 General obligations: accuracy, security, DPO contact, grievances

- **Accuracy (s.8(3)).** Where data is likely to be used to make a decision affecting the person, or disclosed to another fiduciary, Phoenix must ensure it is complete, accurate and consistent. Examples: admission shortlisting, scholarship eligibility, or sharing with a partner institution.
- **Technical and organisational measures** to observe the Act (s.8(4)).
- **Reasonable security safeguards (s.8(5), R.6(1)).** "At the minimum":
  - **(a)** encryption, obfuscation, masking or virtual tokens mapped to the personal data;
  - **(b)** access control over computer resources;
  - **(c)** "visibility on the accessing of such personal data, through appropriate logs, monitoring and review" so unauthorised access can be detected, investigated and remediated;
  - **(d)** continuity measures such as backups;
  - **(e)** "retain such logs and personal data for a period of one year, unless compliance with any law ... requires otherwise";
  - **(f)** security provisions in processor contracts;
  - **(g)** technical and organisational measures for effective observance.
- **Contact person (s.8(9), R.9).** Phoenix must "prominently publish on its website or app, and mention in every response to a communication for the exercise of the rights" the business contact details of the DPO, if there is one, or of a person able to answer questions about processing.
- **Grievance mechanism (s.8(10), s.13).** It must be "readily available". The person must exhaust it before going to the Board (s.13(3)). R.14(3) sets a **response period not exceeding 90 days** and requires technical and organisational measures to make it effective; see §3.8 on the wording.

### 3.7 Breach notification (s.8(6), R.7)

- **What counts as a breach.** A "personal data breach" is "any unauthorised processing ... or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access" that compromises confidentiality, integrity or availability (s.2(u)). **There is no materiality threshold.**
- **To each affected person (R.7(1)).** "To the best of its knowledge", "without delay", "in a concise, clear and plain manner", through their **user account or any registered mode of communication**. The notice must cover:
  - (a) a description of the breach (nature, extent, timing);
  - (b) the likely consequences for them;
  - (c) mitigation measures taken or under way;
  - (d) safety measures they can take;
  - (e) business contact details of a person who can answer their questions.
- **To the Board (R.7(2)):**
  - **(a) Without delay:** a description of the breach (nature, extent, timing, **location**, likely impact).
  - **(b) Within 72 hours** of becoming aware, or longer if the Board allows on a written request: updated details; the facts, circumstances and reasons; mitigation; findings about the person who caused it; remedial measures to prevent recurrence; and a report on the intimations given to affected people.
- **CERT-In (separate law).** Report listed incidents, including "Data Breach" and "Data Leak", **within 6 hours** of noticing them (Direction (ii)). Keep logs of all ICT systems for a rolling **180 days within India** (Direction (iv)). Sync clocks to NIC/NPL NTP or traceable sources (Direction (i)). Designate a Point of Contact (Direction (iii)).

### 3.8 Data Principal rights and timelines

| Right | Source | Content |
|---|---|---|
| Access | s.11 | A summary of personal data processed and the processing activities; the **identities of all other fiduciaries and processors** it was shared with, plus a description of what was shared; and other prescribed information. This applies to data held on consent or s.7(a). There is an exception for sharing with authorities, on their written request, for investigating offences or cyber incidents (s.11(2)). |
| Correction, completion, updating | s.12(1)–(2) | Correct inaccurate or misleading data; complete incomplete data; update it. |
| Erasure | s.12(3) | Erase on request "unless retention ... is necessary for the specified purpose or for compliance with any law". |
| Grievance | s.13 | Readily available means; a response within the prescribed period; the person must exhaust this before going to the Board. |
| Nomination | s.14, R.14(4) | Nominate one or more individuals to act on death or incapacity, under the fiduciary's terms of service. |
| Withdraw consent | s.6(4) | At any time, with comparable ease. |

- **How requests are made (R.14(1)–(2), (5)).** Phoenix must prominently publish (a) how to make a request and (b) the identifiers needed to identify the requester. An "identifier" includes "customer acquisition form number, application reference number, enrolment ID, email address, mobile number".
- **Response timeline.** The gazetted R.14(3) reads: "Every Data Fiduciary and Consent Manager shall prominently publish on its website or app, or both, as the case may be, within a reasonable period not exceeding ninety days under its grievance redressal system for responding to the grievances of Data Principals ..." The sentence is grammatically incomplete in the Gazette PDF; this was checked directly. PIB 2190014 reads it as: "Data Fiduciaries must respond to all such requests [access, correction, update, erasure, nomination] within a maximum of 90 days."
  - **Engineering target:** publish the response period, keep it **at most 90 days** for every rights request and grievance, and run internal SLAs well below that.
  - The Act sets no separate statutory period for access or erasure. Withdrawal must take effect within "a reasonable time" (s.6(6)).
- **Duties of Data Principals (s.15).** No impersonation, no false or frivolous complaints, and only verifiably authentic information in correction requests. The penalty is up to ₹10,000.
- **Data portability.** Machine-readable export is required **only of Consent Managers**, for their consent records (Sch. 1 Part B item 4(b)). There is no general portability right for fiduciaries, so a JSON export for Phoenix is a design choice.

### 3.9 Retention and erasure

- **s.8(7).** Unless another law requires retention, erase (a) on withdrawal or "as soon as it is reasonable to assume that the specified purpose is no longer being served", whichever comes first, and (b) cause processors to erase what Phoenix gave them.
- **s.8(8) and (11), R.8(1)–(2), Sch. 3.** A purpose is deemed no longer served after a prescribed period of inactivity. The Rules prescribe it **only** for three classes, each with 3 years from last contact and a 48-hour pre-erasure warning:
  - e-commerce entities with at least 2 crore registered users in India;
  - online gaming intermediaries with at least 50 lakh;
  - social media intermediaries with at least 2 crore.
  - **Phoenix is not in these classes (interpretation)**, so it must set and justify its own "no longer served" periods under s.8(7)(a).
- **R.8(3), minimum retention.** "A Data Fiduciary shall retain ... such personal data, associated traffic data and other logs of the processing for a minimum period of **one year from the date of such processing**, for the purposes as specified in the Seventh Schedule". Those purposes are State uses for sovereignty and security, legal functions and disclosure, and SDF assessment. After that, Phoenix must erase "unless further retention is required" by another law.
  - Illustration case 1: the platform keeps order details, personal data and logs for at least a year "even if X deletes her account".
  - Illustration case 2: the fiduciary must make sure its cloud processor also keeps data and logs for at least a year.
  - The government can call for this information through authorised persons (R.23). It may also forbid telling the person if disclosure would harm sovereignty or security (R.23(2)).
- **Engineering consequence (interpretation).** On an erasure request or withdrawal:
  1. Stop all operational use immediately.
  2. Remove the data from live systems.
  3. Move the minimum record (the processing log, the traffic data, and the personal data tied to that processing) into a restricted, access-logged retention vault.
  4. Purge it once 1 year from the last processing has passed, unless a legal hold applies.
- **Other laws** (tax, fee receipts, education-regulator record-keeping) can require longer retention (s.8(7) proviso). The periods were **not researched here (unconfirmed)**.

### 3.10 Cross-border transfers

- Transfers are permitted except to countries or territories the government restricts by notification (s.16(1)). Stricter sectoral laws still apply (s.16(2)).
- **R.15:** transfers are subject to "such requirements as the Central Government may, by general or special order, specify in respect of making such personal data available to any foreign State, or to any person or entity under the control of or any agency of such a State".
- An SDF may face localisation of data specified on a committee's recommendation (R.13(4)).
- **Status:** no restricted-country notification and no R.15 order were found (**unconfirmed**, per secondary sources dated to Sept 2026).
- **Separate requirement:** CERT-In logs must be kept within India (Direction (iv)).

### 3.11 Exemptions that may matter

- **Enforcing legal rights or claims (s.17(1)(a)).** Most of Chapters II and III do not apply, but s.8(1) and s.8(5) still do.
- **Research, archiving or statistics (s.17(2)(b), R.16, Sch. 2).** The Act does not apply if the data is "not to be used to take any decision specific to a Data Principal" and the Sch. 2 standards are met: lawfulness, purpose limitation, minimisation, accuracy, limited retention, security, and accountability.
  - Possible use: aggregate admissions analytics.
  - Safer route: anonymise the data so it is no longer personal data (**interpretation**).

### 3.12 Board, enforcement and penalties

- **Inquiries and orders.**
  - The Board inquires into complaints, intimations and references and completes inquiries within 6 months, extendable by 3 months at a time (s.27–28, R.19(9)).
  - It may accept voluntary undertakings (s.32) and refer matters to mediation (s.31).
  - Appeals go to TDSAT within 60 days (s.29, R.22).
  - The Board works as a digital office (R.20).
  - After penalties in two or more instances, the government may order public access to the fiduciary's platform blocked, on the Board's advice (s.37).
- **Penalties.** The Board imposes a penalty where a breach is "significant" (s.33(1)). The factors are nature, gravity and duration; the type of data; repetition; any gain made or loss avoided; mitigation and how timely it was; proportionality; and the effect of the penalty (s.33(2)).

| Act Schedule item | Breach | Maximum penalty |
|---|---|---|
| 1 | Reasonable security safeguards (s.8(5)) | ₹250 crore |
| 2 | Breach intimation to the Board or people (s.8(6)) | ₹200 crore |
| 3 | Children's obligations (s.9) | ₹200 crore |
| 4 | SDF obligations (s.10) | ₹150 crore |
| 5 | Data Principal duties (s.15) | ₹10,000 |
| 6 | Breach of a voluntary undertaking | Up to the penalty applicable to the original breach |
| 7 | Any other provision of the Act or Rules | ₹50 crore |

### 3.13 Messaging regulation outside DPDP (SMS and voice)

TRAI Telecom Commercial Communications Customer Preference Regulations 2018, as amended by the Second Amendment Regulations 2025 (12 Feb 2025):

- **Promotional message.** It must include an opt-out "in the same Message". Promotional content mixed into a transactional or service message makes the whole message promotional. Promotional messages are delivered according to the recipient's preference register or consent register; explicit digital consent overrides a blocked preference (reg. 2(au)).
- **Service message (reg. 2(bh)).**
  - (i) To an existing customer about a product or service they use (delivery, warranty, safety and similar), with no promotional content: needs no explicit consent.
  - (ii) To facilitate or complete an ongoing transaction: needs explicit consent, **valid for 7 days**.
- **Transactional message (reg. 2(bt)).** Sent in response to a transaction the customer started, **within 30 minutes**, for example an OTP or a confirmation. Needs no explicit consent.
- **Consent revocation.** After revocation or opt-out, a sender may re-acquire DLT consent only after **90 days**. Consent-seeking messages go out through the 127xxx short code.
- **Scope.** WhatsApp and email are outside TCCCPR. Platform policies apply to them and were not researched here.

---

## 4. Concrete CRM requirements (checklist)

Tags: **[contacts] [deals] [messaging] [ai] [automation] [money] [admissions] [analytics] [platform]**. Each item is legally required by 13 May 2027 unless it is marked *(design choice)* or *(already in force)*. The citations show the source of each item.

### Contacts

- [ ] **[contacts] Age status on every person record.** Add `dob` or `age_band`, plus `age_status` ∈ {`verified_adult`, `declared_adult`, `minor`, `unknown`} and `age_source`. Treat `unknown` as `minor` for every s.9 gate. *(s.2(f), s.9; age checks permitted by Sch. 4 Part B item 6)*
- [ ] **[contacts] Guardian link for minors.** Each minor contact must link to at least one guardian contact with `relationship`, `parental_consent_id` and `verification_method`. Block all processing of the minor's data until a verified parental consent exists. Before that, hold only the parent's contact details needed to start the R.10 flow. *(s.9(1), R.10 illustration case 1)*
- [ ] **[contacts] Parent verification service** with methods matching R.10:
  - `existing_verified_account` (R.10(1)(a)).
  - `digilocker_token` (R.10(1)(b)(ii)): OAuth 2.0 with PKCE S256, `purpose=educational|verification`, read `dob`, compute ≥ 18.
  - `govt_id_review` (R.10(1)(b)(i)): reviewed by a person.

  Store only the outcome: adult = true, the method, a timestamp, a hashed `digilockerid` or token reference, and the reviewer. Do not keep ID images or e-Aadhaar XML unless a documented legal need exists *(minimisation under s.6(1); design choice)*. Do not accept a self-declared checkbox alone *(interpretation)*.
- [ ] **[contacts] Disability guardianship.** Verify that the guardian was appointed by a court, a designated authority or a local level committee, and store the reference. *(R.11)*
- [ ] **[contacts] Append-only consent ledger.** Each entry records: `principal_id`, `actor` (self / parent / guardian / consent_manager), `purpose_id`, `data_items[]`, `notice_version_id`, `language`, `channel`, `captured_at`, `evidence` (form payload hash, IP/user-agent, OTP or DigiLocker reference), `status` (given / denied / withdrawn), `withdrawn_at` and `withdrawal_channel`. Make it immutable and exportable. Keep evidence at least as long as the processing lasts plus a legal-claims buffer; set the period with counsel. *(s.6(10); fields mirror the Consent Manager records in Sch. 1 Part B item 3)*
- [ ] **[contacts] Purpose catalogue.** Define itemised purposes, each mapped to specific data fields. Examples: `inquiry_response`, `application_processing`, `counselling_calls`, `marketing_email`, `marketing_sms`, `marketing_whatsapp`, `marketing_voice`, `event_invites`, `scholarship_assessment`, `b2b_sales_followup`, `product_updates`. Capture consent per purpose, with no bundling and no pre-ticked boxes. *(s.6(1), R.3(b))*
- [ ] **[contacts] Lawful basis and source on every record.** Store `lawful_basis` ∈ {`consent`, `s7a_voluntary`, `legal_obligation`} and `source` (web form, walk-in, phone, event, referral, import, partner). An import must carry consent evidence that covers Phoenix, or the record is quarantined. There is no "legitimate interest" basis. *(s.4, s.7)*
- [ ] **[contacts] Legacy notice campaign.** On 13 May 2027, send the s.5(2) notice (data, purposes, how to withdraw, grievance route, Board complaint) to every existing contact. Track delivery and mark `legacy_notice_sent_at`. *(s.5(2))*
- [ ] **[contacts] Correction, completion and update requests** must edit the record and propagate the change to any processors and fiduciaries the data was disclosed to. *(s.12(2), s.8(3))*
- [ ] **[contacts] Disclosure register.** Record every disclosure per contact: recipient fiduciary or processor, the data shared and the date. This feeds the s.11(1)(b) access response. *(s.11)*

### Admissions

- [ ] **[admissions] Parent-led application forms.** Show a standalone, itemised notice before any student data is captured: the student fields (name, DOB, class, marks, documents, photo), the purposes, and links for withdrawal, rights and complaints to the Board. Run R.10 verification before student fields are saved. *(s.5, s.9(1), R.3, R.10)*
- [ ] **[admissions] Self-registering minors** (illustration case 1). Capture only the declared parent's contact details and send the parent a verification and consent link. Do not keep the student's profile or activity data until the parent consents. Purge the stub if no consent arrives within a short window *(the period is a Phoenix choice)*.
- [ ] **[admissions] Exemption flag per institution and per processing activity.** `sch4_partA_item3_applies` defaults to **false**. Set it to true only on legal sign-off, and only for the tracking or behavioural monitoring of **enrolled** children for educational activities or safety. Never set it for prospects or marketing. *(R.12, Sch. 4 Part A item 3; interpretation)*
- [ ] **[admissions] Identifiers for rights requests.** Accept the application reference number or enrolment ID as an identifier. *(R.14(1)(b), R.14(5))*
- [ ] **[admissions] Retention of non-enrolled applicants.** When the admission cycle closes plus a defined period, erase or anonymise their data. Exclude only the R.8(3) one-year processing record and any legal-hold records. Hand enrolled students' data to the institution's records system under its own basis. *(s.8(7)(a), R.8(3))*
- [ ] **[admissions] Transport and location features** (if built): only within Sch. 4 Part A item 5 or Part B item 4 conditions (location during travel, for safety). *(R.12)*

### Messaging

- [ ] **[messaging] Consent check at send time.** Every send resolves `purpose` and `channel`. Promotional sends need an active `marketing_<channel>` consent. Service and transactional sends must be linked to an active service purpose (consent or s.7(a)). *(s.4, s.6(1), s.7(a))*
- [ ] **[messaging] Template classification.** Classify each template as `promotional`, `service`, `transactional` or `government`. Lint templates and reclassify any service or transactional template containing promotional content as promotional. *(TRAI reg. 2(au), 2(bh), 2(bt))*
- [ ] **[messaging] One-step opt-out in every promotional message** (a link, or STOP for SMS/WhatsApp). It writes a `withdrawn` entry to the ledger and stops all queued sends for that purpose within a reasonable time *(target: immediate; the SLA is a design choice)*. *(s.6(4), s.6(6), R.3(c)(i), TRAI reg. 2(au) proviso)*
- [ ] **[messaging] TRAI consent rules for SMS and voice.** Explicit consent for an ongoing transaction expires after 7 days, so abandoned-application nudges by SMS stop after 7 days unless marketing consent exists. Once someone revokes DLT consent, do not ask again for 90 days. *(TRAI reg. 2(bh)(ii); 2025 amendment)*
- [ ] **[messaging] No promotional or targeted messages to minors.** Send nothing promotional or targeted to `minor` or `unknown` contacts. Family marketing goes to the verified parent with the parent's consent, and segments must not use the child's behavioural data. *(s.9(3); scope of "directed at children": interpretation, see §5)*
- [ ] **[messaging] Language.** Render notices and consent requests in English or the recipient's chosen Eighth Schedule language, and store `language`. *(s.5(3), s.6(3))*
- [ ] **[messaging] Breach broadcast capability.** Be able to send an R.7(1) intimation to each affected person through the user account or a registered channel, using pre-approved templates with the five required elements. *(R.7(1))*
- [ ] **[messaging] Withdrawal propagation to messaging processors** (SMS aggregator, WhatsApp BSP, email ESP, voice): suppression lists stay in sync automatically. *(s.6(6))*

### AI

- [ ] **[ai] Hard block on minors.** No lead scoring, propensity models, persona or interest inference, sentiment profiling or behavioural clustering on `minor` or `unknown` contacts, or on student-portal activity. Enforce it in the feature pipeline, not only the UI. *(s.9(3), s.9(2))*
- [ ] **[ai] Purpose manifest per AI feature.** Each feature declares its purposes and input fields. It runs only where the record's consent or basis covers that purpose. Customer data is used for model training or fine-tuning only with a specific consented purpose, and never data of minors. *(s.6(1), s.9)*
- [ ] **[ai] Decisions affecting a person** (admission shortlisting, scholarship eligibility, fee-waiver recommendations): data-completeness checks, source tracing, and human review before the outcome is communicated. *(Accuracy duty in s.8(3); human review is a design choice)*
- [ ] **[ai] LLM and AI vendors are Data Processors.** Each needs a contract covering security, no retention or training by the vendor, erasure on instruction and the R.8(3) log period, plus a recorded processing region. *(s.8(2), R.6(1)(f), s.16)*
- [ ] **[ai] Exclude minors' free text** (counselling notes, essays) from embeddings and vector stores, unless the parent has consented to that specific purpose. Erasure must cascade to vector stores. *(s.9(1), s.8(7))*

### Analytics

- [ ] **[analytics] Age gate before trackers.** Load no third-party advertising pixels, retargeting tags, cross-site identifiers or session replay until an age gate has found the user to be an adult. Never load them on student-facing portals. *(s.9(3); age gate under Sch. 4 Part B item 6)*
- [ ] **[analytics] Ad audiences.** Block export of `minor` or `unknown` contacts, or parent records segmented by a child's behaviour, to ad platforms (custom or lookalike audiences). *(s.9(3) "targeted advertising directed at children")*
- [ ] **[analytics] Adult analytics.** Non-essential identifiable analytics run only after consent. Reports use aggregated or de-identified data. If Phoenix relies on the statistical exemption, document the Sch. 2 standards and never use the output for decisions about individuals. *(s.6, s.17(2)(b), R.16, Sch. 2)*
- [ ] **[analytics] Masking by default.** Mask PII in dashboards and exports by default; unmasking is role-gated and logged. *(R.6(1)(a)–(c))*

### Deals (B2B)

- [ ] **[deals] Lawful basis for institute staff contacts.** Record the basis for each contact: an s.7(a) inquiry or demo request (respond to that only), or consent for marketing. Cold sequences to bought lists need consent evidence. *(s.4, s.7(a))*
- [ ] **[deals] Data processing agreement for SaaS clients** (Phoenix as processor). It must cover:
  - processing only on the institute's instructions;
  - R.6 safeguards;
  - prompt breach notice to the institute, so it can meet R.7;
  - cease and erase on instruction (s.6(6), s.8(7)(b));
  - keeping data and logs for at least one year (R.8(3) illustration case 2);
  - a sub-processor list and their regions;
  - help with rights requests.
  *(s.8(1)–(2), R.6(1)(f))*

### Money

- [ ] **[money] Legal holds on financial records.** Fee and payment records carry `legal_hold_reason` and `hold_until`. Erasure requests skip held fields and say so in the response. *(s.8(7) and s.12(3) "compliance with any law"; specific tax and record periods unconfirmed)*
- [ ] **[money] Paid services survive withdrawal.** Withdrawal does not cancel processing for services already paid for. Marketing stops; fulfilment continues. *(s.6(5) illustration)*
- [ ] **[money] Payment gateways are processors** and need contracts that meet R.6(1)(f). *(s.8(2))*

### Automation

- [ ] **[automation] Consent gate in every workflow.** Every journey, sequence and drip has a consent and purpose gate node and re-checks before each step. Withdrawal or an erasure request exits all active enrolments. *(s.6(6))*
- [ ] **[automation] Retention scheduler.** Set per-purpose retention periods (a Phoenix policy under s.8(7)(a)). Erasure jobs cover the primary database, search indexes, caches, file storage, analytics and vector stores, and send erasure instructions to processors. Enforce the R.8(3) one-year minimum for processing records and logs, then purge. *(s.8(7), R.8(3), R.6(1)(e))*
- [ ] **[automation] Optional 48-hour pre-erasure warning** for inactive contacts. *(R.8(2) applies only to Sch. 3 classes, so this is a design choice)*
- [ ] **[automation] Breach runbook with timers:**
  - T+0 detection;
  - **CERT-In ≤ 6 h** *(already in force)*;
  - **Board "without delay"** initial report;
  - **Board ≤ 72 h** detailed report;
  - affected people "without delay";
  - an evidence pack for each R.7(2)(b) item.
  *(R.7, CERT-In Direction (ii))*
- [ ] **[automation] Rights and grievance SLA timers.** Hard ceiling of 90 days, an internal target such as 30 days *(design choice)*, escalations, and every response carrying the DPO or contact details. *(R.14(3), R.9)*

### Platform

- [ ] **[platform] Notice service.** Notices are standalone, versioned and itemised (data items, purposes, goods/services/uses). Each has links to withdraw, to rights and grievances, and to the Board complaint route. Translations are available in English plus the 22 Eighth Schedule languages, and the user can choose. *(s.5, s.6(3), R.3)*
- [ ] **[platform] Published contact and rights page** on the website and app: the DPO or contact person, how to make requests, the identifiers required, and the grievance response period (at most 90 days). *(s.8(9), R.9, R.14(1), R.14(3))*
- [ ] **[platform] Rights portal.** Identity verification for the requester, with a verified parent acting for a child (s.2(j)). It supports:
  - access requests (s.11);
  - correction, completion and updating (s.12(2));
  - erasure (s.12(3));
  - withdrawal (s.6(4));
  - nomination of one or more individuals (s.14, R.14(4));
  - grievances (s.13).
  *(Ch. III, R.14)*
- [ ] **[platform] Access export.** Produce the s.11 summary in a readable form and as JSON/CSV. It contains the data held, the processing activities, the recipients and a description of what was shared. *(JSON/CSV is a design choice; s.11 content is mandatory)*
- [ ] **[platform] Erasure engine.** Erasure is irreversible across stores and backups (backups age out on a fixed cycle). Records under R.8(3) or a legal hold move to a restricted vault with access logging, then are purged automatically. *(s.8(7), s.12(3), R.8(3))*
- [ ] **[platform] Security baseline:**
  - encryption in transit and at rest;
  - field-level encryption or tokenisation for student DOB, IDs, marks and documents;
  - masking;
  - RBAC with MFA;
  - access logs with monitoring and periodic review;
  - tested backups and restore;
  - security logs kept at least one year;
  - CERT-In: ICT logs for 180 days **in India** and NTP sync to NIC/NPL *(already in force)*.
  *(s.8(5), R.6(1)(a)–(g), CERT-In (i), (iv))*
- [ ] **[platform] Breach register and detection alerts**, recording the facts R.7(2)(b) requires. *(R.7)*
- [ ] **[platform] Processor inventory:** each vendor's purpose, data items, region, contract status and erasure and withdrawal endpoints. This drives s.11(1)(b) responses, s.6(6) and s.8(7)(b) propagation, and s.16 checks. *(s.8(2), s.11, s.16)*
- [ ] **[platform] Cross-border switch.** Be able to block or relocate processing for any country the government restricts under s.16, and to comply with R.15 orders. *(s.16, R.15)*
- [ ] **[platform] Consent Manager adapter** *(optional; registration opens 13 Nov 2026)*. Accept consent and withdrawal events from Board-registered Consent Managers into the ledger. The interface waits on the Board's standards. *(s.6(7), R.4)*
- [ ] **[platform] Multi-tenant processor mode** for B2B clients. Each institute configures its notice text, contact person, purposes and exemption flags. Phoenix gives tenants tooling for consent, rights and breach handling. *(s.8(1)–(2))*
- [ ] **[platform] Records of processing and a DPIA-style review** for children's-data features. Not mandatory unless Phoenix becomes an SDF; recommended. *(design choice; s.10 and R.13 apply only to SDFs)*

---

## 5. Open questions (for counsel or a later Gazette check)

1. **Scope of the education exemption.** Do Phoenix's schools, colleges or coaching entities count as "educational institutions" (Sch. 4 Note (c))? Does any CRM processing (for example monitoring enrolled students' engagement) count as "tracking and behavioural monitoring ... for the educational activities"? Admissions marketing to prospects is assumed **not** exempt.
2. **"Targeted advertising directed at children."** Does it cover parent-addressed ads selected by the child's age, grade or exam results? The conservative design assumes yes, if the targeting uses the child's data.
3. **Parent-child relationship.** R.10 requires checking that the person is an identifiable adult, not that they are the child's parent. Does Phoenix need relationship evidence (for example from school records)?
4. **R.10(1)(b)(i).** Are ID details typed in by the parent (no government-source check) enough? What counts as "reliable details ... available with the Data Fiduciary" under R.10(1)(a), for example a parent who previously paid fees online?
5. **DigiLocker.** Phoenix's onboarding as a requester, and whether aggregator-mediated flows count as "made available and verified by a Digital Locker service provider". No DPDP-specific government age-token service was found.
6. **R.14(3) wording.** The gazetted text is garbled. Does the 90-day limit bind all rights requests (as PIB says) or only grievances? Engineering assumes all.
7. **Languages.** Must every one of the 22 Eighth Schedule languages be available, or only an "option" covering the audience's languages?
8. **Compression proposal.** The January 2026 proposal to shorten the 18-month window to 12 months (for SDFs, possibly also R.8(3)) had not been notified as of the last sources (Sept/Oct 2026). Re-check the Gazette before each milestone.
9. **Board status.** Has the Chairperson or Members been appointed, and is the complaint portal or app live? Sources conflict (**unconfirmed**).
10. **Consent Managers.** Who has registered after 13 Nov 2026, and what standards and APIs has the Board published?
11. **Notifications not found.** No s.16 restricted list, R.15 order, s.17(3) startup exemption, s.9(5) age threshold or SDF notification was found.
12. **R.8(3) versus an erasure request.** How much personal data, beyond logs, must survive an erasure request for one year? The e-book illustration suggests order details and personal data. Agree the vault's scope.
13. **Retention under other laws.** Fee and tax records (GST/IT) and education-regulator record-keeping periods were not researched here.
14. **SPDI Rules 2011 until 13 May 2027.** The SPDI text was not verified in this research, because the earlier download failed.
15. **Phoenix's role in each B2B contract** (processor or joint fiduciary), especially if Phoenix uses tenant data for its own analytics or AI.
16. **Bought or partner leads.** What evidence shows a third party's consent extends to Phoenix?

---

## 6. Sources (with access dates)

Primary sources. Files were downloaded on 5 Nov 2026 to `research/dl-dpdp/` and `research/dl-digilocker/`, and read on 6 Nov 2026.

1. **Digital Personal Data Protection Act, 2023** (No. 22 of 2023), Gazette of India Extraordinary, 11 Aug 2023. MeitY copy: https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf. Local: `dl-dpdp/act-meity.pdf`, `act.txt`. Accessed 5–6 Nov 2026.
2. **G.S.R. 843(E)**, 13 Nov 2025: commencement of the Act. eGazette CG-DL-E-14112025-267647. Local `eg-267647.*`. Accessed 5–6 Nov 2026.
3. **G.S.R. 844(E)**, 13 Nov 2025: establishment of the Data Protection Board, headquartered in the NCR. eGazette CG-DL-E-14112025-267648. Accessed 5–6 Nov 2026.
4. **G.S.R. 845(E)**, 13 Nov 2025: the Board to have four members. eGazette CG-DL-E-14112025-267649. Accessed 5–6 Nov 2026.
5. **G.S.R. 846(E)**, 13 Nov 2025: Digital Personal Data Protection Rules, 2025. eGazette CG-DL-E-14112025-267650 (No. 760). MeitY copy: https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf. Local `gsr846.pdf/.txt`. Accessed 5–6 Nov 2026.
6. **G.S.R. 892(E)**, 10 Dec 2025: corrigendum to G.S.R. 846(E) ("of this Gazette" becomes "in the Official Gazette" in R.1; Sch. 4 note lettering). eGazette CG-DL-E-12122025-268455. Accessed 5–6 Nov 2026.
7. **S.O. 5458(E)**, 5 Oct 2026: Digital Personal Data Protection (Removal of Difficulties) Order, 2026, published 6 Oct 2026. eGazette CG-DL-E-07102026-276885. Local `rod-2026.*`. Accessed 5–6 Nov 2026.
8. **PIB release 2190014**, 14 Nov 2025, "Government notifies DPDP Rules ...". https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014. Accessed 5–6 Nov 2026.
9. **PIB backgrounder** "DPDP Rules, 2025 Notified", 17 Nov 2025. Local `pib-backgrounder.pdf`. Accessed 5–6 Nov 2026.
10. **PIB release 2261823**, 16 May 2026 (MeitY workshop; "fully enforceable from 13 May 2027"). https://www.pib.gov.in/PressReleasePage.aspx?PRID=2261823. Accessed 5–6 Nov 2026.
11. **CERT-In Directions** No. 20(3)/2022-CERT-In, 28 Apr 2022, under IT Act s.70B(6). Local `certin.txt`. Accessed 5–6 Nov 2026.
12. **TRAI**, Telecom Commercial Communications Customer Preference (Second Amendment) Regulations, 2025 (1 of 2025), 12 Feb 2025. Local `trai-2025.*`. Accessed 5–6 Nov 2026.
13. **NeGD/MeitY DigiLocker Requester API Specification v1.12** (Sept 2023). Local `dl-digilocker/requester-v1_12.pdf`, `req.txt`. Accessed 5–6 Nov 2026.
14. **DSCI, "FAQs on Data Protection Board"** (2026). https://www.dsci.in/files/content/documents/2026/faq-on-data-protection-board.pdf. Local `dsci-faq.*`. Accessed 5–6 Nov 2026. Used only for the Board process summary.
15. **MeitY/NeGD "Code for Consent: The DPDP Innovation Challenge" BRD** (Apr 2025). Local `c4c.*`. Context only: consent-management system features such as lifecycle, multilingual support and immutable audit logs. Not a legal requirement.
16. **Constitution of India, Eighth Schedule** (list of 22 languages). Stated from the constitutional text; the local `legis-coi.html` did not render. Verify before shipping.

Secondary sources, used only for status checks and marked **unconfirmed** where relied on. All accessed 6 Nov 2026.

17. MirvoLegal, "DPDP Rules, 2025: Compliance Timeline for Data Fiduciaries (as at September 2026)". https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/ (law stated as at 20 Sep 2026).
18. Khurana & Khurana on Legal500, "Compression Of DPDP Enforcement Timeline Proposed By MeitY" (18 Mar 2026). https://www.legal500.com/intelligence/india/privacy/compression-of-dpdp-enforcement-timeline-proposed-by-meity
19. Business Standard, "Meity may cut compliance timeline for key DPDP rules to 12 months" (Jan 2026). https://www.business-standard.com/technology/tech-news/meity-may-cut-compliance-timeline-for-key-dpdp-rules-to-12-months-126012201293_1.html (seen in search results; the fetch was blocked with HTTP 403).
20. LiveLaw, "India's Data Protection Board: Established In Law, Absent In Fact" (Aug 2026), and India Data Law, "Is the Data Protection Board of India operational?" (Aug 2026). https://www.livelaw.in/articles/india-data-protection-board-established-law-543751 and https://indiadatalaw.org/is-the-board-operational/ (seen in search-result summaries only).
21. Search-result summaries on the s.16 negative list (for example https://www.dsci.in/files/content/documents/2025/cross-border-flow-of-data.pdf and https://buttondown.com/the_desk/archive/no-country-is-restricted-your-data-still-cannot/), stating that no restricted list had been notified as of Sept 2026.
