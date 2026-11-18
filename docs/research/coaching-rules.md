# Coaching-centre rules in India: registration, refunds, age and advertising

Research for the Phoenix Group CRM. Prepared 6 November 2026. Audience: engineers and product owners building the contacts, deals, messaging, AI, automation, money, admissions, analytics and platform modules.

Status key used below:
- **Verified (primary)**: read in the official or gazette text (or a faithful reproduction of it), clause cited.
- **Reported**: taken from an official press release or a parliamentary reply, but the underlying instrument was not read.
- **Unconfirmed**: secondary or news source only, or not found. Do not hard-code these without legal sign-off.

This is research, not legal advice. Every hard rule in section 5 should be confirmed by Phoenix's counsel before launch, especially the open questions in section 6.

---

## 1. Summary

1. **The Ministry of Education (MoE) "Guidelines for Registration and Regulation of Coaching Center 2024" are model guidelines, not a law.** They were sent to States/UTs on 16 January 2024 (letter No. 5-35/2023-PN-II) "for consideration by States/UTs by way of appropriate legal framework". They bind a coaching centre only when its State/UT adopts them through its own Act, rules or guidelines. In practice they are the national baseline that most state instruments copy, often with changes. (Verified)
2. **MoE baseline numbers** (Verified, clause cited):
   - Scope: a "coaching center" teaches **more than 50 students** (cl. 4).
   - Prior registration is required, and each branch registers separately (cl. 5).
   - **No enrolment below 16 years of age, "or the student enrolment should be only after secondary school examination"** (cl. 6(i)(c) and cl. 10.2(iii)).
   - **No misleading promises or guarantee of rank or good marks** (cl. 6(i)(b)), and no misleading advertisement about quality, facilities or results (cl. 6(i)(d)).
   - The website must show tutors' qualifications, courses, duration, hostel, fees, easy exit policy, fee refund policy, and the number coached vs the number who got admission to higher education institutions (cl. 6(ii)).
   - **Students who paid in full and leave mid-course get a pro-rata refund for the remaining period "within 10 days"**, plus hostel and mess fees (cl. 8(iv)).
   - **The fee cannot be raised during the course** (cl. 8(v)). Prospectus, notes and material are free (cl. 8(iii)).
   - At most 5 hours of classes a day (cl. 10.1(viii)).
   - Assessment results must not be made public (cl. 10.2(xi)).
   - No batch segregation by academic performance (cl. 12(vii)).
   - Complaints are decided within 30 days (cl. 16).
   - Penalties are Rs 25,000, then Rs 1,00,000, then revocation (cl. 17(2)).
3. **The Supreme Court made mental-health safeguards binding everywhere.** In *Sukdeb Saha v. State of Andhra Pradesh* (judgment of 25 July 2025, 2025 INSC 893), it issued 15 guidelines under Articles 32 and 141. They are binding on all educational institutions, coaching centres included, until legislation or regulation replaces them. It also directed all States/UTs to notify coaching-centre rules within two months (para 37). Relevant to the CRM:
   - A counsellor is required where 100 or more students are enrolled.
   - No batch segregation by performance, and no public shaming.
   - Helplines, including Tele-MANAS, must be shown on websites.
   - Anonymised wellness records and an annual report are required.
   (Verified)
4. **State adoption is uneven and the details differ.** A Rajya Sabha written reply of 12 August 2026 lists the instruments adopted after the MoE guidelines (Reported). They include:
   - Rajasthan Act 2025, Jharkhand Act 2025, Assam Act 2025, Haryana Act 2024.
   - Andhra Pradesh and Himachal Pradesh Rules 2026.
   - Guidelines in Tamil Nadu, Puducherry and Andaman & Nicobar (2026), and Tripura and Nagaland (2025).

   Phoenix also verified J&K Rules (January 2026). It has reports, not text, for Meghalaya (March 2026) and Madhya Pradesh (October 2026). Older laws exist in Bihar (2010), Goa (2001), UP (2002), Karnataka (2001 rules) and Manipur (2017). Key differences from the MoE baseline:
   - **Rajasthan Act No. 16 of 2025** (Verified):
     - Threshold is more than **100** students.
     - The enacted text has **no minimum-age clause**.
     - Pro-rata refund within **10 days**, with hostel and mess refunded "in the same manner".
     - Parents must be offered **at least four equal instalments**.
     - The **entire fee** is refunded if registration is cancelled or the centre closes.
     - Penalties are Rs 50,000, then Rs 2,00,000, then cancellation.
     - It comes into force only on a notified date. **That commencement notification was not found** (Unconfirmed).
   - **Jharkhand Act (Jharkhand Act 1 of 2026)** (Verified):
     - Threshold is more than 50 students, **physical, online or hybrid**.
     - Under-16s, or students who have not passed matriculation, may enrol **only with explicit written informed parental consent**.
     - Students register on a state portal and get a "CED-ID". Success claims must show the CED-ID and the course actually taken.
     - Refunds follow the centre's own published policy (no fixed day count).
     - Penalties up to Rs 5 lakh, then up to Rs 10 lakh.
   - **J&K Rules** (Verified):
     - Threshold is more than **20** students.
     - **Full refund if the student withdraws within 10 days of registration.**
     - Pro-rata refund on mid-course exit.
     - **Online-only fee payment.**
5. **The CCPA coaching-advertising guidelines are binding nationally.** These are the "Guidelines for Prevention of Misleading Advertisement in Coaching Sector, 2024", notified 13 November 2024 under s.18 of the Consumer Protection Act 2019. They apply to "all forms of advertisements by any person including an endorser engaged in coaching sector" (cl. 1(3)). Phoenix's WhatsApp, SMS and email templates and its AI replies that promote a coaching course are advertisements in this sense. (Verified)
   - **Banned claims (cl. 3):**
     - false claims about course, duration, faculty credentials, fee, or exit and refund policy;
     - false claims about the number of selections, rank or success rate;
     - "guaranteed selection", job security, promotions, salary increase, or admission;
     - leading the consumer to believe that enrolment ensures a good rank or high marks;
     - false urgency or scarcity.
   - **Mandatory (cl. 4):**
     - Next to a topper's photo, disclose the rank, the course name and duration, and whether the course was paid.
     - Disclaimers must be in the same font as the claim.
     - Claim recognition or approval (AICTE, UGC, etc.) only if true.
     - **Use a successful candidate's name, photo, video or testimonial only with written consent taken after the selection.**
   - **Enforcement:** CCPA penalties under s.21 CPA go up to Rs 10 lakh, and up to Rs 50 lakh for each subsequent contravention. By 23 Feb 2026 CCPA had issued 57 notices and imposed Rs 1,24,60,000 on 29 coaching institutes (PIB, Reported). Concealing which course a topper actually took was held to be a violation, and a repeat offender was fined Rs 15 lakh.
6. **What this means for Phoenix, in one line per module:**
   - **Admissions:** capture DOB and secondary-exam status for every coaching enrolment, and apply a jurisdiction-specific age gate.
   - **Money:** build a refund engine with a 10-day SLA. It computes pro-rata tuition plus hostel and mess, never charges separately for material, and locks the fee at enrolment. It also needs instalment and payment-mode rules per state.
   - **Messaging and AI:** a prohibited-claims linter and guardrail, evidence-backed result claims, post-selection consent records, no public rank lists, and no false urgency.
   - **Platform:** a versioned, per-branch "jurisdiction policy profile", because states differ on threshold, age, refund timing, instalments and penalties.

---

## 2. Does this apply to Phoenix? (scoping)

| Phoenix activity | Which rules bite | Notes |
|---|---|---|
| Phoenix itself runs coaching (tuition or entrance-exam prep for more than the state threshold of students) and uses the CRM for B2C admissions | All of them: state instrument (registration, age, fees and refunds, counselling, disclosures), SC mental-health guidelines, CCPA coaching guidelines, CPA 2019 | Thresholds: MoE more than 50; CCPA "Coaching Center" more than 50; Rajasthan more than 100; Jharkhand more than 50, including online and hybrid; J&K more than 20. |
| Phoenix runs school or college admissions only (not coaching) | Mostly out of scope of these coaching rules; general CPA 2019 rules on misleading ads and unfair trade practices still apply | Product must confirm which B2C offerings are "coaching". See open question Q1. |
| Phoenix sells the CRM to coaching institutes (B2B) | The **tenant** is the regulated entity. Phoenix must ship features that let tenants comply, and must not ship features that make violations easy (for example fake-scarcity timers or auto-generated "guaranteed selection" copy). | Phoenix may itself be exposed. CPA s.21(4) lets CCPA penalise "any person ... found to publish, or is a party to the publication of, a misleading advertisement" (up to Rs 10 lakh). Phoenix delivers tenant messages and generates AI copy. See Q2. |

Note on CCPA scope: the "Coaching Center" definition has a more-than-50-students threshold (cl. 2(1)(d)). However, cl. 3 and cl. 4 bind "any person who establishes, runs, administers coaching center **or provides coaching**", and "coaching" (cl. 2(1)(c)) has no numeric threshold. Treat the advertising rules as applying to coaching of any size (conservative reading; Q3).

---

## 3. Rules in detail, with citations

### 3.1 MoE "Guidelines for Registration and Regulation of Coaching Center 2024"

- **Instrument:** Letter No. 5-35/2023-PN-II, Government of India, Ministry of Education, Department of Higher Education (PN.II Section), dated 16 January 2024. It is addressed to Chief Secretaries and Administrators of States/UTs. Subject: "Guidelines for Regulation of Coaching Center for consideration by States/UTs by way of appropriate legal framework". Title in cl. 1: "Guidelines for Registration and Regulation of Coaching Center 2024". [S1]
- **Legal nature:** advisory and model. Background para 4 says these institutions "are best regulated by the State / UT governments", and para 20 calls it "model guidelines / policy which States / UTs can adopt". The Rajya Sabha reply of 12 Aug 2026 confirms it was circulated "for taking further action by way of appropriate legal framework". [S1][S9]

**Definitions (cl. 4).**
- "coaching" means tuition, instructions or guidance in any branch of learning imparted to **more than 50 students**. It excludes counselling, sports, dance, theatre and other creative activities.
- "coaching center" means a centre "established, run, or administered by any person to provide coaching for any study programme or competitive examinations or academic support to students at school, college, and university level, for more than 50 students".
- "person" includes a body corporate, trust, firm, society or institution.

**Registration (cl. 5).**
- (i) Prior registration is required before a person "impart[s] coaching or establish[es], run[s], manage[s] or maintain[s] a coaching center".
- (ii) Existing centres apply **within three months from the date of implementation**.
- (iv) **Each branch is a separate coaching center and needs a separate application.**
- (v) The authority decides within three months.
- (vi) The validity period is set by the State.
- (vii) Renewal is due **two months before expiry**.
- (ix) A faceless web portal is to be set up.

**Conditions for registration (cl. 6).** No coaching center shall:
- (a) engage tutors with qualification below graduation;
- (b) "make misleading promises or guarantee of rank or good marks to parents/students for enrolling them in the coaching center";
- (c) "**enroll student below 16 years of age or the student enrolment should be only after secondary school examination**";
- (d) publish or take part in "any misleading advertisement relating to any claim, directly or indirectly, of quality of coaching or the facilities offered therein or the result procured by such coaching center or the student who attended such class";
- (e) be registered without the minimum space per student;
- (f) hire anyone convicted of an offence involving moral turpitude;
- (g) be registered without a counselling system.

**Website (cl. 6(ii)).** The centre "shall have a website with updated details of":
- the qualification of tutors;
- courses/curriculum and duration of completion;
- hostel facilities (if any);
- the fees being charged;
- easy exit policy;
- fee refund policy;
- number of students undertaken coaching from the center;
- number of students finally succeeded in getting admission in Higher Education Institutions, etc.

**Undertakings with the application (cl. 7(i)).**
- (a) Use only the words "registered coaching center". **Do not use "recognized" or "approved"** on any sign board, prospectus, "correspondence or communication of whatever nature or at any place".
- (b) No classes during the students' school hours.
- (c) Tutor qualifications, timetable, fees and general information go on the website and on a notice board.
- (e) Abide by the specified number of students per class.

**Fees (cl. 8). Verbatim text of the refund rule:**
> (i) The tuition fees for different courses/curriculum being charged shall be fair and reasonable and receipts for the fee charged must be made available.
> (ii) The coaching center must issue a prospectus mentioning the different courses/curriculum, their duration of completion, number of classes, lectures, tutorials, hostel facilities (if any), and the fees being charged, easy exit policy, fee refund etc. ...
> (iii) The prospectus, notes and other material shall be supplied by the coaching center to their enrolled students without any separate fees thereof.
> (iv) If the student has paid for the course in full and is leaving the course in the middle of the prescribed period, student will be refunded from out of the fees deposited earlier for the remaining period, on pro-rata basis within 10 days. If the student is staying in the hostel of the coaching center, then the hostel fees and mess fee etc. will also be refunded.
> (v) Under no circumstances, the fee on the basis of which enrolment has been made for a particular course and duration shall be increased during the currency of the course.

What the refund text does **not** say (these are engineering gaps, see Q4 to Q7):
- what the 10 days run from (secondary sources say "of submitting application"; Unconfirmed);
- whether days are calendar or working days;
- the unit of "pro-rata" (days, months or classes);
- the treatment of students paying by instalment (the clause is framed for "paid ... in full");
- whether any administrative deduction is allowed (none is mentioned);
- whether hostel and mess refunds are also pro-rata (the MoE text says only "will also be refunded"; Rajasthan says "in the same manner").

**Infrastructure (cl. 9).**
- (vii) Complaint box or register, plus a grievance committee.
- (iii) Referral services and helplines are displayed.

**Classes (cl. 10.1).**
- (ii) No classes during school hours "so that their regular attendance ... remains unaffected and also to avoid dummy schools".
- (v) Weekly off for students and tutors.
- (vi) No test on the day after the weekly off.
- (viii) **No more than 5 hours a day**, and "neither be too early in the morning nor too late in the evening".

**Code of conduct (cl. 10.2).**
- (i) Batch size is defined in the prospectus and on the website, and is **not increased during the course**.
- (iii) Repeats the **16-years / post-secondary** rule.
- (iv) Students are "well apprised about the difficulty of exams, syllabus, level of intensity of preparation and efforts required ... before enrolling".
- (vi) Inform students about other career options.
- (vii) An optional admission or mock test, after which the centre may convey "realistic expectation" to parents.
- (viii) "**The students and parents shall be made aware that admission in the coaching center is no way guarantee of success** for admission in institutions like medical, engineering, management, law etc. or in the competitive examination."
- (xi) "**Coaching center shall not make public the result of assessment test conducted by it.**" Students whose performance is deteriorating get counselling.

**Counselling (cl. 11).**
- A mechanism for immediate intervention for students in distress.
- Counsellors' and psychologists' names and the times they are available are given to students and parents.
- Career counsellors are on-boarded.
- A four-level mental-health framework (cl. 11(ix)).

**Inclusivity (cl. 12).**
- (i) No discrimination on religion, race, caste, sex, place of birth, descent etc. "during the admission and teaching process".
- (vii) "**Batch segregation on academic performance ground shall not be done** ... Batches should be formed in the order of entry / admission of students and the batch shall not be changed till completion of the course."

**Records and annual report (cl. 13).** Records are kept "as may be prescribed by the appropriate government". An annual report may be submitted.

**Shifting (cl. 14).** A centre may not move from its registered place without prior written approval.

**Complaints (cl. 16).** A student, parent or tutor may complain to the competent authority, which **disposes of it within 30 days**.

**Penalties (cl. 17(2)).** Rs 25,000 for the first offence, Rs 1,00,000 for the second, revocation of registration after that. Cancellation is under cl. 18, and appeals must be filed within 30 days (cl. 19).

### 3.2 Supreme Court, *Sukdeb Saha v. State of Andhra Pradesh & Ors.* (2025 INSC 893; 2025 LiveLaw (SC) 740)

- **Bench and date:** Vikram Nath and Sandeep Mehta JJ., 25 July 2025, in SLP (Crl.) No. 6378 of 2024. [S3] (judgment text read from LiveLaw's reproduction; the J&K notification quotes para 37 identically [S5])
- **Para 35:** the guidelines are issued under Article 32 and declared law under Article 141. They "shall remain in force and be binding until such time as appropriate legislation or regulatory frameworks are enacted".
- **Para 36:** they apply to "all educational institutions across India, including ... coaching institutes, residential academies, and hostels, irrespective of their affiliation".
- **Guidelines most relevant to the CRM:**
  - **I:** a mental-health policy, reviewed annually and public on the website.
  - **II:** "All educational institutions with **100 or more enrolled students** shall appoint/engage at least one qualified counsellor, psychologist, or social worker"; smaller institutions need referral linkages.
  - **IV:** "All educational institutions, more particularly the coaching institutes/centres, shall, as far as possible, refrain from engaging in **batch segregation based on academic performance, public shaming, or assignment of academic targets disproportionate to students' capacities**."
  - **V:** written referral protocols. "Suicide helpline numbers, including **Tele-MANAS** and other national services, shall be prominently displayed in hostels, classrooms, common areas, and **on websites** in large and legible print."
  - **VIII:** confidential reporting of harassment and bullying, with zero tolerance for retaliation. Neglect that contributes to self-harm "shall be treated as institutional culpability".
  - **IX:** parent sensitisation programmes.
  - **X:** "maintain **anonymised records** and prepare an annual report" on wellness interventions, referrals and training.
  - **XII:** structured career counselling, coaching centres included.
  - **XV:** heightened protections in coaching hubs: "Jaipur, Kota, Sikar, Chennai, Hyderabad, Delhi, Mumbai" and others.
- **Directions to governments:**
  - **Para 37:** "All States and Union Territories shall, as far as practicable, notify rules within two months ... mandating registration, student protection norms, and grievance redressal mechanisms for all private coaching centres."
  - **Para 38:** a district-level monitoring committee chaired by the District Magistrate or Collector.
  - **Para 39:** a Union compliance affidavit within 90 days. The matter was listed on 27 Oct 2025 for the compliance report. Later orders were not reviewed (Unconfirmed).

### 3.3 State and UT adoption

**Rajya Sabha written reply, 12 August 2026** (MoS Education Dr Sukanta Majumdar). [S9] (Reported) It says that "a number of States/UTs have brought out guidelines / regulations / legislations" after the MoE guidelines. It names:
- Andhra Pradesh Coaching Institutions (Regulation and Control) Rules, 2026
- Himachal Pradesh Private Coaching Centres (Registration and Regulation) Rules 2026
- Policy and Guidelines for Registration, Control & Regulation of Coaching Institutes in the UT of Puducherry, 2026
- Guidelines for Registration and Regulation of Tamil Nadu Coaching Centres, 2026
- Guidelines ... in Andaman and Nicobar Islands 2026
- the Rajasthan Coaching Centres (Control and Regulation) Act, 2025
- Jharkhand Coaching Centre (Control and Regulation) Act 2025
- Guidelines ... in Tripura, 2025
- the Assam Coaching Institutes (Control and Regulation) Act, 2025
- Guidelines ... in the State of Nagaland, 2025
- Haryana Registration and Regulation of Private Coaching Institutes Act, 2024

The reply also gives the official MoE guidelines page, on the dohe-education.gov.in domain.

**Pre-2024 state laws**, as listed in MoE background para 19 [S1]:
- Bihar Coaching Institute (Control & Regulation) Act, 2010 (Bihar Act 17 of 2010)
- Goa Coaching Classes (Regulation) Act, 2001 (Goa Act 27 of 2001)
- Uttar Pradesh Regulation of Coaching Act, 2002 (UP Act 5 of 2002)
- Karnataka Tutorial Institutions (Registration and Regulation) Rules, 2001
- Manipur Coaching Institute (Control and Regulation) Act, 2017 (Act 8 of 2017)

Their current refund and age terms were not reviewed (Unconfirmed).

#### Comparison of the instruments read in full

| Item | MoE 2024 (model) [S1] | Rajasthan Act 16 of 2025 [S2] | Jharkhand Act 1 of 2026 [S4] | J&K Rules, S.O. 19, Jan 2026 [S5] |
|---|---|---|---|---|
| Status | Advisory to States/UTs | Assent 23 Sep 2025; English text gazetted 24 Sep 2025. **In force only from a notified date (s.1(3)); notification not found** | Assent 20 Jan 2026 (Reported [S14]); in force from Gazette publication (s.1(3)) | In force from Gazette publication (r.1(2)); notified under SC para 37 |
| Student threshold | More than 50 (cl.4) | More than 100 (s.2(d)) | More than 50, "physical or online or hybrid mode" (s.2(c),(d)) | More than 20 (r.3(1)(b),(c)) |
| Minimum age | Below 16, "or ... only after secondary school examination" (cl.6(i)(c), 10.2(iii)) | **No age clause in enacted text** (bill-stage news reported a 16-year bar [S15]; it does not appear in the authorised English text) | Not below 16 **or** not passed matriculation, "without the explicit written informed consent of his/her parents or guardian" (s.13(8)(b); s.14(1) proviso) | "Tuition" means teaching students "of 16 years or above" (r.3(1)(i)) |
| Mid-course refund | Pro-rata for remaining period "within 10 days"; hostel and mess also refunded (cl.8(iv)) | Same, "within ten days"; hostel and mess "in the same manner" (s.13(4)); District Committee can direct it (s.6(2)(i)) | Centre must have policies allowing "timely refund in case the student exit[s]" (s.17(1)(o)); refund policy disclosed (s.13, item (xvi)) | Pro-rata on mid-course exit (r.11(4)) |
| Cooling-off | None | None | None stated | **Full fee refund if the student withdraws within 10 days of registration** (r.8(d)) |
| Faculty change | — | — | — | Faculty or schedule changes notified one week in advance (r.8(a)); after a mid-session faculty change the student may withdraw within 10 days with a proportional refund; the authority's refund decision is binding and must be implemented within 10 days (r.8(e)) |
| Closure | — | **Entire fee refunded** on cancellation of registration or self-closure (s.6(2)(q)) | 90 days' notice of winding up; refunds per the centre's policy, overseen by an officer (s.27) | — |
| Instalments and payment mode | — | Centre must not charge the total fee at once; parents get the option of **at least four equal instalments** within the course (s.6(2)(d)) | "flexibility for students in payment of course fees" (s.17(1)(o)) | "**The mode of fee payment will be online only**" (r.11(6)) |
| Fee increase | Prohibited during the course (cl.8(v)) | Prohibited (s.13(5)) | — | Prohibited (r.11(5)) |
| "Fees" scope | — | Includes **admission fees** and teaching fee (s.2(f)) | — | — |
| Rank or marks guarantee | Prohibited (cl.6(i)(b)) | Prohibited (s.8(1)(ii)) | Prohibited; also imports the CCPA cl.3 list, false urgency included (s.13(8)(c)-(f),(j)); must comply with CCPA guidelines (s.18) | Prohibited (r.5(1)(ii)) |
| Website | cl.6(ii) list | Same, plus "**percentage** of number of students finally succeeded" (s.8(3)) | Extensive: total registered, selected, **percentage of selection**; timetable; batch caps; refund and transfer policy (s.13); all policies on the website and embedded in admission forms, prospectus and ads (s.17(1)(p)) | Tutors, qualifications, courses, fees, policies, student outcomes; "specifically publish fee structure" (r.7) |
| Result claims and testimonials | — | — | Must show the **CED-ID and course enrolment** when publishing success (s.17(1)(l)); **written informed consent** before using name, photo, CED-ID, testimonial or video (s.17(1)(m)) | Publish a results summary each session; send detailed results to the authority (r.8(b)) |
| Student registry | — | — | Every student registers on the state portal and gets a **CED-ID** ("may be linked to Aadhaar"), linked to the centre's CCR-ID (s.14, s.17(1)(a)) | — |
| Class hours | ≤5 h/day (cl.10.1(viii)) | ≤5 h/day (s.11(vii)) | Operating window **06:00 to 21:00** (s.13, course item (iii)) | ≤5 h/day (r.10) |
| Complaints | Authority decides in 30 days (cl.16) | District Committee decides in 30 days (s.18); 24x7 call centre possible (s.4(4)) | Committee orders within 90 days (s.26); centre runs a 24x7 helpline (s.17(1)(q)) | Centre reports each complaint and its resolution to the authority **within a week** (r.8(c)) |
| Penalties | Rs 25k, then Rs 1 lakh, then revocation (cl.17(2)) | Rs 50,000, then Rs 2,00,000, then cancellation; recoverable as land revenue (s.19) | Up to Rs 5 lakh, then up to Rs 10 lakh, then cancellation (s.26(10)) | Rs 25,000, then Rs 50,000, then revocation (r.20) |
| Registration validity | Set by the State | 3 years (s.7(6)) | — (Letter of Intent then registration; performance bank guarantee) | 2 years (r.4(d)) |

Notes on the J&K text: it is an OCR of a scanned notification. The clause text is clear, but the day of the January 2026 date is illegible. News reports place the notification around 4 Feb 2026 [S16].

**States reported but not read** (Unconfirmed details):
- **Meghalaya:** Registration of Private Coaching Centre Rules, 2026, notified 12 March 2026 and citing *Sukdeb Saha* [S16].
- **Madhya Pradesh:** Coaching Centres (Registration and Regulation) Rules, 2026, reported notified around 25-26 Oct 2026. Existing centres register within 90 days of publication; registration valid 3 years; each branch registered separately; 5-hour cap; no classes during school hours; fees, faculty, results, and exit and refund policy disclosed online [S16].
- **Andhra Pradesh:** Rules 2026 issued by G.O. Ms. No. 9 dated 27.03.2026; existing centres register within three months [S16].
- **Maharashtra:** reportedly drafting a framework [S16].

Before go-live in any of these states, obtain the gazette text (Q8).

### 3.4 CCPA "Guidelines for Prevention of Misleading Advertisement in Coaching Sector, 2024"

- **Instrument:** Central Consumer Protection Authority notification, New Delhi, 13 November 2024, issued under s.18 of the Consumer Protection Act 2019. It "shall come into force on the date of its publication" (cl. 1(2)). [S6] (text read from LiveLaw's reproduction of the notification; the official copy is on consumeraffairs.nic.in as linked by PIB [S7])
- **Application (cl. 1(3)):** "These guidelines shall apply to all forms of advertisements by any person including an endorser engaged in coaching sector."
- **Definitions (cl. 2):**
  - "Advertisement" is as defined in CPA s.2(1). That definition is understood to cover print, electronic media, internet and website publicity; verify the wording on India Code.
  - "Coaching" includes academic support, education, guidance, instructions, study programme or tuition. It excludes counselling, sports, dance, theatre and creative activities.
  - "Coaching Center" means one teaching more than fifty students.
  - "Endorser" is as defined in the 2022 Misleading Advertisements Guidelines, cl. 2(f).
  - "Misleading Advertisement" is as defined in CPA s.2(28).

**Clause 3, "Conditions for misleading advertisement" (verbatim):** Any person who establishes, runs, administers coaching center or provides coaching shall be said to be engaged in misleading advertisement, if it:
> (a) makes false claims regarding course(s) offered, duration of completion, credential of faculty, fee, course exit policy including fee-refund;
> (b) makes false claims regarding number of selection, rank in exam or success rate;
> (c) make false claims such as guaranteed selection, job security, job promotions, salary increase, success at different stages of an examination, admission to any institution or lead the consumer to believe that enrolment in coaching will ensure a good rank, high marks;
> (d) falsely represents that the services are of a particular standard or quality;
> (e) creates a false sense of urgency including falsely stating or implying the sense of urgency or scarcity showing false popularity of goods or services so as to mislead a person into making an immediate purchase or require taking an immediate action;
> (f) engages in any other unfair trade practice or misleading advertisement.

**Clause 4, "Obligations of every person engaged in coaching" (verbatim):**
> (1)(a) disclose important information such as rank secured, name and duration of course, whether such course is paid with the candidate's photograph;
> (b) display disclaimer and any other important information prominently. The font of disclaimer and important information in the advertisement shall be the same as that used in the claim;
> (c) accurately represent the service, facilities, resources and infrastructure of the coaching center;
> (d) truthfully represent, if applicable, that the course(s) offered are duly recognised and have the approval of a competent authority such as ... AICTE, UGC, etc.
> (e) maintain transparency in making an advertisement;
> (f) every coaching center shall endeavour on a best effort basis to become a partner in the convergence process of the National Consumer Helpline of the Central Government.
> (2) Any person who is engaged in coaching shall not use name, photographs, testimonial or videos of successful candidate in an advertisement without candidate's written consent. The consent in this regard shall be taken subsequent to the selection.

The 4-page PDF reproduction has a 4th page with no extractable text, probably the signature page. Whether clauses after 4(2) exist could not be confirmed (Q9).

**Enforcement record** (Reported):
- **PIB, 13 Nov 2024** [S7]: 45 notices issued; Rs 54,60,000 imposed on 18 coaching institutes. The National Consumer Helpline (NCH) logged 16,276 student grievances in 2023-24 (5,351 in 2022-23), and helped secure Rs 1.15 crore in refunds between 1 Sep 2023 and 31 Aug 2024 at the pre-litigation stage. The release says violations "will be treated as a contravention of the Consumer Protection Act, 2019".
- **PIB, 23 Feb 2026** [S8]: Rs 15 lakh final order against Vajirao & Reddy Institute, treated as a **subsequent contravention** after an earlier Rs 7 lakh penalty.
  - "Over 645 Selections Out of 1016 Vacancies" was published with toppers' photos while regular courses were advertised alongside. CCPA held that hiding the specific course each candidate took (often only an "Interview Guidance Programme") is concealment of material information, violating consumer rights under CPA s.2(9).
  - 431 enrolment forms did not state the course and were undated.
  - Running total at that date: **57 notices; Rs 1,24,60,000 on 29 institutes.**
- **News, May 2026** [S17]: a further Rs 10 lakh (Motion Education) and Rs 5 lakh (Career Line, Sikar), with totals reported as more than 60 notices and more than Rs 1.39 crore on 31 institutes (Unconfirmed against PIB).

### 3.5 Consumer-protection angles (CPA 2019 and related)

- **Penalties, CPA 2019 s.21** [S10] (bare-act reproduction; verify on India Code):
  - s.21(1): CCPA may direct the discontinuation or modification of a false or misleading ad.
  - s.21(2): penalty on a manufacturer or endorser "which may extend to ten lakh rupees", and up to "fifty lakh rupees" for every subsequent contravention.
  - s.21(3): an endorser can be barred for up to 1 year, or 3 years for repeats.
  - s.21(4): "any person ... found to publish, or is a party to the publication of, a misleading advertisement" can be penalised up to Rs 10 lakh.
  - s.21(5): due-diligence defence for endorsers.
- **Criminal liability, CPA s.89:** for a manufacturer or service provider who causes a false or misleading ad, up to 2 years and a Rs 10 lakh fine; for subsequent offences, up to 5 years and Rs 50 lakh [S10] (summary of bare-act text; verify on India Code).
- **Unfair contracts and "non-refundable" clauses:** consumer commissions have repeatedly refused to enforce blanket "fees once paid are not refundable" clauses against coaching students. Reported examples are an NCDRC order upholding a refund against FIITJEE after early withdrawal, and *Sehgal School of Competition v. Dalbir Singh* [S11] (secondary reporting; case citations and holdings **Unconfirmed**). There is also a contrary line that education is not a "service" (for example *Daya Chand Prasad*, 2015, reported). Practical rule: do not ship coaching contract or receipt templates with blanket non-refundability.
- **Dark patterns:** the CCPA Guidelines for Prevention and Regulation of Dark Patterns, 2023 were notified 30 Nov 2023 under s.18 CPA. They list 13 practices in Annexure 1, including false urgency, basket sneaking, confirm shaming, forced action, subscription trap, interface interference, bait and switch, drip pricing, disguised advertisement, nagging, trick question, SaaS billing and rogue malware [S12] (secondary summaries; verify Annexure 1 wording). These apply to Phoenix's payment pages and lead forms as a "platform".
- **National Consumer Helpline (NCH):** CCPA cl. 4(1)(f) asks centres to join NCH convergence on a best-effort basis. NCH is the main pre-litigation refund channel (see the enforcement figures above).

### 3.6 Cross-reference: children's data (DPDP)

- **Definition:** the DPDP Act 2023 s.2(f) defines "child" as an individual who has not completed eighteen years.
- **Consent:** s.9(1) requires verifiable consent of the parent before processing a child's personal data.
- **No targeting:** s.9(3) bars "tracking or behavioural monitoring of children or targeted advertising directed at children".
- **Rules:** the DPDP Rules 2025 (G.S.R. 846(E), 13 Nov 2025) put Rule 10 (verifiable parental consent for children) in force **18 months after publication** (Rule 1(4)). [S13]
- **Overlap with coaching rules:** the coaching age floor (16) and the DPDP child threshold (18) are different, so 16- and 17-year-old coaching students are still "children" for data purposes. Commencement of the Act's own s.9 is out of scope here; take it from the separate DPDP research.

---

## 4. Implications for Phoenix (analysis)

1. **Age capture (admissions).** Every coaching enrolment needs date of birth and secondary-exam status, both captured and evidenced.
   - **MoE reading (ambiguous):** cl. 6(i)(c) can be read two ways. Under (A) the student must be at least 16 **and** have finished the secondary exam. Under (B) either condition is enough. Jharkhand's text (s.13(8)(b)) reads as (A), with a parental-consent override. Default to (A) until counsel decides (Q10).
   - **Rajasthan:** no age gate in the Act, though the profile should still record age.
   - **J&K:** a 16+ gate.
   - **Jharkhand:** allow under-16 or non-matric only with a stored, explicit written informed parental consent.
   - **Leads for under-age students** (for example Class 8 to 10 "foundation" courses) must not progress to enrolment or payment where a hard gate applies. This is a product and commercial decision (Q11).
2. **Refunds (money).** Both the MoE and Rajasthan rules require a pro-rata refund within 10 days, covering hostel and mess fees too. J&K adds a full-refund window in the first 10 days and a faculty-change exit. Rajasthan adds a full refund if the centre closes and a minimum of 4 equal instalments. Nothing authorises deductions, and material must be free, so the default is no deductions.
   - **Time basis:** the clock is safest measured in calendar days from receipt of the written or recorded withdrawal request.
   - **Instalment payers:** refund the unconsumed portion of what was paid (a conservative extension of a rule framed for full payment). Waive future instalments.
3. **Messaging and AI.** Any promotional message is an "advertisement" under CCPA cl. 1(3).
   - **Never say:** guarantee or assured selection, rank, marks, admission, job, or salary increase. Avoid any wording that implies enrolment ensures a good rank.
   - **No unsubstantiated success statistics.**
   - **No fake scarcity** ("only 3 seats left", fake countdowns).
   - **No "recognised" or "approved"** unless an approval record exists. MoE cl. 7(i)(a) bars these words outright for registered coaching centres.
   - **Topper ads:** must show rank, course name and duration, and paid or free status in the same font. They need post-selection written consent, and must not hide which course the topper actually took (Vajirao order).
   - **Test results:** do not broadcast internal test ranks (MoE cl. 10.2(xi)). Do not shame publicly (SC IV).
   - **Child-directed ads:** do not target ads at under-18s on the basis of tracking (DPDP s.9(3), once in force).
4. **Disclosures.** Tenants need a generated, versioned disclosure pack for the website and prospectus. It should cover tutors, courses, duration, number of classes, batch size, fees, exit and refund policy, hostel, results statistics with consistent denominators, counsellors and helplines. Each enrolment should record which version the family saw.
5. **Jurisdiction differences.** Rules vary by state (threshold, age, refund timing, instalments, payment mode, penalties, registry IDs) and change frequently: at least eight new instruments were adopted in 2025-26. The rules must therefore be data, versioned per branch with effective dates, not code.

---

## 5. CRM requirements checklist

Conventions:
- "Profile" means the jurisdiction policy profile attached to a tenant branch (see PL-1).
- "Baseline" means the MoE 2024 values, used when a branch's state has no adopted instrument loaded.
- Each item cites its source rule.

### Platform
- [ ] **PL-1 [platform] Jurisdiction policy profile.** A versioned record per branch.
  - Fields:
    - state/UT;
    - instrument name and citation;
    - in-force flag and effective-from date;
    - student-count threshold;
    - `age_rule` (none / min16_and_secondary / min16_or_secondary / min16_or_parental_consent);
    - `refund_sla_days`;
    - `refund_clock_start` (request_received);
    - `cooling_off_days` (J&K 10);
    - `min_equal_instalments` (Rajasthan 4);
    - `allowed_payment_modes` (J&K online-only);
    - `full_refund_on_closure` (Rajasthan true);
    - `max_class_hours_per_day` (5);
    - `operating_window` (Jharkhand 06:00 to 21:00);
    - `complaint_report_to_authority_days` (J&K 7);
    - `registry_id_required` (Jharkhand CED-ID).
  - Ship seeded profiles for MoE baseline, Rajasthan, Jharkhand and J&K from section 3.3. Mark the Rajasthan profile "not yet in force" until a commencement notification is confirmed.
  - Source: MoE cl. 4-10; Raj s.2, 6, 13; JH s.2, 13, 14, 17; J&K r.3, 8, 11.
- [ ] **PL-2 [platform] Branch = registration unit.** Store per branch: registration certificate number, issuing authority, issue and expiry dates, and registered address. A branch move requires an approval record (MoE cl. 5(iv), 14; Raj s.7(4), 16).
- [ ] **PL-3 [platform] Tenant onboarding declaration (B2B).** The tenant declares whether it provides coaching, its student-count band, its states and branches, and whether it runs hostels. Coaching-compliance features are enabled automatically when the band exceeds the profile threshold (MoE cl. 4; CCPA cl. 2).
- [ ] **PL-4 [platform] Disclosure-pack generator.** Produces website and prospectus content:
  - tutor qualifications; courses; duration; number of classes, lectures and tutorials; batch size; hostel and mess; fees; easy exit policy; fee refund policy;
  - coached vs succeeded counts (plus percentage where the profile requires);
  - counsellor names and timings; helplines;
  - the "registered coaching center" wording.

  Versioned and published with a hash (MoE cl. 6(ii), 7(i)(c), 8(ii), 10.2(i), 11(ii); Raj s.8(3), 13(2); JH s.13, 17(1)(p); J&K r.7).
- [ ] **PL-5 [platform] Immutable audit log** of claim approvals, consent artefacts, refund computations and disclosure versions. This is the substantiation evidence CCPA asked for in the Vajirao order (S8).
- [ ] **PL-6 [platform] Records retention.** Retention is configurable per profile ("as may be prescribed": MoE cl. 13; Raj s.15; JH s.23). Default to retaining financial and refund records for at least 8 years (accounting practice; confirm with counsel, Q12).

### Admissions
- [ ] **AD-1 [admissions] Mandatory eligibility data on every coaching enrolment:**
  - student DOB;
  - current class or grade;
  - secondary (Class 10 / matriculation) exam passed (Y/N, board, year);
  - school name and school timings;
  - parent or guardian link.

  Age is computed in IST as of the enrolment date and the course start date (MoE cl. 6(i)(c), 10.2(iii)).
- [ ] **AD-2 [admissions] Age gate per `age_rule`.**
  - Baseline: block "Enrolled" unless age ≥16 AND secondary passed. The (B) reading can be configured only with a recorded legal sign-off (Q10).
  - J&K: age ≥16.
  - Jharkhand: under-16 or non-matric is allowed only with a stored explicit written informed parental-consent artefact (JH s.13(8)(b), s.14(1)).
  - Rajasthan: no gate, but still capture the data.
  - Overrides require a role, a reason and an audit entry.
- [ ] **AD-3 [admissions] Pre-enrolment disclosure and acknowledgement step**, recorded with the parent's and student's acknowledgement, a timestamp, the channel and the disclosure version. It shows:
  - exam difficulty, syllabus, intensity and effort required (MoE 10.2(iv));
  - other career options (10.2(vi));
  - the statement "admission in the coaching center is no way guarantee of success" (10.2(viii));
  - fees, exit and refund policy, and batch size (8(ii), 10.2(i)).
- [ ] **AD-4 [admissions] Optional aptitude or mock-test record** before enrolment, with the realistic-expectation note shared with parents (MoE 10.2(vii); Raj s.12(vi) "option of aptitude test").
- [ ] **AD-5 [admissions] Batch allocation.**
  - Assign batches in order of admission only.
  - Block allocation rules based on test scores, and lock the batch until course completion (MoE 12(vii); Raj s.12(ix); SC Guideline IV).
  - Enforce the published batch cap (MoE 10.2(i)).
- [ ] **AD-6 [admissions] School-hours conflict check.** Block a timetable that overlaps the student's school hours (MoE 7(i)(b), 10.1(ii); Raj s.9(1)(b), 6(2)(m)).
- [ ] **AD-7 [admissions] Non-discrimination.** Religion, caste, race, sex, place of birth and descent must not be usable as admission criteria or scoring features. If collected for scholarships or reservation schemes, store them separately with restricted access (MoE 12(i)). Jharkhand: no separate classes for students admitted under subsidised schemes (s.13(8)(g)).
- [ ] **AD-8 [admissions] Jharkhand student registry.** A field for the CED-ID, required before "Enrolled" when `registry_id_required`. Show the centre's CCR-ID. Aadhaar linkage is optional ("may be"), so do not collect Aadhaar unless the tenant opts in (JH s.14, 17(1)(a)).
- [ ] **AD-9 [admissions] Counsellor routing.** Each enrolment links to the branch counselling contact. Flag branches with 100 or more enrolled students that have no counsellor record (SC Guideline II).

### Money
- [ ] **MO-1 [money] Fee lock.** The fee schedule is snapshotted at enrolment and cannot be raised for that enrolment; price changes apply only to new enrolments (MoE 8(v); Raj s.13(5); J&K r.11(5)).
- [ ] **MO-2 [money] No separate charge for prospectus, notes or study material.** Block such invoice line types in regulated profiles (MoE 8(iii); Raj s.13(3); J&K r.11(3)).
- [ ] **MO-3 [money] Receipt for every payment**, immediately, on all channels (MoE 8(i); Raj s.13(1); J&K r.11(1)).
- [ ] **MO-4 [money] Instalments.**
  - Rajasthan: offer at least 4 equal instalments within the course duration and never force a lump sum (Raj s.6(2)(d)).
  - Jharkhand: the payment-flexibility policy is disclosed (s.17(1)(o)).
- [ ] **MO-5 [money] Payment modes.** Restrict to online modes when `allowed_payment_modes = online` (J&K r.11(6)).
- [ ] **MO-6 [money] Refund engine: withdrawal intake.**
  - A withdrawal request can come from any channel (form, WhatsApp, email, counter, AI chat). It creates a Withdrawal record with `received_at` (IST) and an acknowledgement to the parent.
  - The CRM must not require a reason or an exit interview before the clock starts.
  - Retention offers must not delay processing.
- [ ] **MO-7 [money] Refund engine: computation.**
  - Formula: `refund = tuition_fees_paid × remaining_units / total_units`, plus hostel and mess on the same basis. `units` are calendar days of the prescribed course period by default, or classes if the prospectus defines the course by classes. The unit is recorded on the enrolment.
  - Use integer paise and round in the student's favour.
  - Deductions default to zero. A deduction is allowed only if the profile permits it and it was disclosed in the acknowledged policy version (Q6).
  - Rajasthan: the base includes admission fees (s.2(f)).
  - Instalment payers: refund paid minus consumed, and cancel future instalments (Q5).
  - Source: MoE 8(iv); Raj s.13(4).
- [ ] **MO-8 [money] Refund SLA.**
  - Payout is due within `refund_sla_days` (10) of `received_at`, in calendar days (conservative, Q4).
  - Timers alert at day 5 and day 8 and escalate on breach.
  - Each refund stores computation inputs, approver, UTR or payout reference, and payout timestamp.
  - Payout goes to the original payer instrument by default.
- [ ] **MO-9 [money] Cooling-off.** When `cooling_off_days` is set (J&K 10), give a full refund of all fees on withdrawal within N days of registration (J&K r.8(d)).
- [ ] **MO-10 [money] Faculty-change exit.**
  - A faculty or schedule change on a batch must be logged at least 7 days ahead (J&K r.8(a)).
  - The change opens a 10-day withdrawal window for affected students, with a proportional refund. Authority refund orders are implemented within 10 days (J&K r.8(e)).
- [ ] **MO-11 [money] Closure or cancellation bulk refund.** When a branch is marked cancelled or self-closed, generate full-fee refunds for all active enrolments in Rajasthan profiles (Raj s.6(2)(q)). In Jharkhand, generate policy-based refunds plus a 90-day wind-up checklist (JH s.27).
- [ ] **MO-12 [money] Contract and receipt template guard.** Block "non-refundable" and "fees once paid will not be refunded" wording on tuition, hostel and mess lines in coaching profiles (CPA unfair contract risk, S11; MoE 8(iv)).
- [ ] **MO-13 [money] Authority-directed refunds.** A refund type "ordered by competent authority or District Committee" with its order reference and a 10-day implementation SLA (Raj s.6(2)(i); J&K r.8(e)).

### Messaging
- [ ] **ME-1 [messaging] Prohibited-claims linter on every template and campaign** (WhatsApp, SMS, email, landing pages, ad copy). It covers English, Hindi and Hinglish, plus the tenant's languages. Block or require compliance approval for:
  - "guarantee" or "guaranteed" or "assured" with selection, rank, marks, admission, job or salary;
  - "100% selection" or "100% result";
  - "pakka selection" and similar;
  - "sure-shot";
  - claims of a "top rank" without evidence;
  - "job security";
  - "promotion" or "salary hike";
  - wording that implies enrolment ensures rank or marks.

  Source: MoE 6(i)(b); CCPA 3(b),(c); Raj s.8(1)(ii); JH s.13(8)(c),(d).
- [ ] **ME-2 [messaging] Results and topper claims need an Evidence record.** The record holds: candidate, exam, year, rank or roll reference, the course actually taken, its duration, paid or free status, enrolment form and fee receipt, and a written consent dated **after** the result.
  - The template renderer auto-inserts "rank, course name and duration, paid/free" next to the photo in the same font and size as the claim.
  - Aggregate claims ("X selections") must be computed from evidence records, with the scope stated (which courses).
  - Source: CCPA 3(b), 4(1)(a),(b), 4(2); PIB Vajirao order S8; JH s.17(1)(l),(m).
- [ ] **ME-3 [messaging] Testimonial consent gate.** Block use of a candidate's name, photo, video or testimonial unless a consent record exists with `consented_at > result_date`. Consent is revocable, and revocation pulls the asset from future sends (CCPA 4(2); JH s.17(1)(m)).
- [ ] **ME-4 [messaging] Scarcity and urgency variables.**
  - "Seats left" placeholders must bind to the live batch inventory (AD-5 cap).
  - Countdown or deadline placeholders must bind to a real dated event.
  - Static scarcity text is blocked (CCPA 3(e); Dark Patterns Guidelines S12).
- [ ] **ME-5 [messaging] Recognition and approval wording.** Block "recognised", "approved", "govt approved", "AICTE/UGC approved" unless an approval record (authority, reference, scope) exists. In coaching profiles, insert the "registered coaching center" wording and the registration number from PL-2 (MoE 7(i)(a); CCPA 4(1)(d)).
- [ ] **ME-6 [messaging] No public test results.**
  - Block broadcast or group sends containing other students' test scores or ranks, and leaderboards.
  - Individual results go privately to the student and their parent only.
  - No "low performer" bulk lists to parents.
  - Source: MoE 10.2(xi); Raj s.12(viii); SC Guideline IV.
- [ ] **ME-7 [messaging] Disclaimer rendering.** For image or video templates, the disclaimer layer uses the same font and size as the headline claim (CCPA 4(1)(b)).
- [ ] **ME-8 [messaging] Helpline footer.** A per-tenant option to append the mental-health helpline (Tele-MANAS) to student-facing communications and to the website disclosure pack (SC Guideline V). Confirm numbers before shipping: Tele-MANAS 14416 and NCH 1915 are from general knowledge and were not verified in this research.
- [ ] **ME-9 [messaging] No ad targeting of minors by tracking.** Campaign audiences may not be built from behavioural tracking of contacts under 18 (DPDP s.9(3), once in force; S13).

### AI
- [ ] **AI-1 [ai] Guardrail policy for AI replies and AI-drafted copy.** The AI must never:
  - promise or imply selection, rank, marks, admission, job or salary outcomes;
  - state success rates or topper counts unless retrieved from the verified Evidence store (ME-2), with scope and source shown;
  - create urgency or scarcity not backed by live inventory;
  - claim recognition or approval without a record;
  - reveal any student's test results to anyone other than that student and their parent.

  Source: CCPA cl. 3 and 4; MoE 6(i)(b), 10.2(viii), 10.2(xi).
- [ ] **AI-2 [ai] Required statements.** When a family asks about outcomes, the AI must say that admission to coaching does not guarantee success (MoE 10.2(viii)) and offer the counsellor or aptitude test (10.2(vii)).
- [ ] **AI-3 [ai] Refund and withdrawal handling.**
  - The AI answers from the branch's current refund policy and profile (pro-rata, 10-day SLA, cooling-off, instalments).
  - A withdrawal intent creates the MO-6 record immediately.
  - The AI must not discourage, delay or bargain against a refund.
- [ ] **AI-4 [ai] Age capture in AI lead flows.** Ask for DOB and class before quoting enrolment. Under-age students per AD-2 are routed to "not eligible / information only", with no payment links.
- [ ] **AI-5 [ai] Distress escalation.** Signals of self-harm or distress from students or parents trigger immediate hand-off to the branch counsellor or duty person and show helplines. They are logged as anonymised wellness records (SC Guidelines V, X; MoE cl. 11(i)).
- [ ] **AI-6 [ai] Output log and red-team suite.** Store AI outputs sent to contacts for audit (PL-5). Maintain a regression suite of prohibited-claim prompts in English, Hindi and Hinglish; the release gate requires zero violations.

### Contacts
- [ ] **CO-1 [contacts] Student fields:** DOB, class, secondary-exam status, school and school hours, guardian relation, CED-ID (Jharkhand), and accommodation (hostel or mess) flags.
- [ ] **CO-2 [contacts] Consent objects:**
  - (a) testimonial or publicity consent (scope, date, revocation);
  - (b) Jharkhand under-16 or non-matric parental consent;
  - (c) DPDP verifiable parental consent for under-18s, cross-referencing the DPDP research.
- [ ] **CO-3 [contacts] Sensitive attributes** (caste, religion, disability) are stored only if needed for scholarships or accessibility, restricted by role, and excluded from segmentation and scoring (MoE 12; SC VII).

### Deals
- [ ] **DE-1 [deals] Stage gates.** "Enrolled" or "Won" for a coaching deal requires:
  - AD-2 eligibility passed;
  - AD-3 disclosure acknowledged;
  - MO-1 fee snapshot;
  - the refund-policy version attached;
  - a batch with free capacity (AD-5).
- [ ] **DE-2 [deals] Withdrawal stage.** A dedicated "Withdrawn – refund pending/paid" stage linked to MO-6 to MO-8. It is not merged into "Lost". Withdrawals are not penalised in salesperson scoring in a way that incentivises blocking refunds.

### Automation
- [ ] **AU-1 [automation] Registration renewal reminders** at 90 and 60 days before branch certificate expiry (MoE 5(vii); Raj s.7(7)). Initial registration tasks for existing centres within 3 months of a profile's effective date (MoE 5(ii); Raj s.7(2); MP reported 90 days).
- [ ] **AU-2 [automation] Refund SLA timers** (MO-8) and authority-order timers (MO-13).
- [ ] **AU-3 [automation] Complaint register with SLAs.**
  - Each complaint gets an intake acknowledgement.
  - Where the profile requires it, it is reported to the authority within 7 days (J&K r.8(c)).
  - Track authority disposal at 30 days (MoE 16; Raj s.18) or 90 days (JH s.26).
  - Complaints can be anonymous or confidential for harassment and bullying (SC VIII).
- [ ] **AU-4 [automation] Timetable validator.**
  - At most 5 class hours per student per day.
  - A weekly off.
  - No test on the day after the weekly off.
  - Within the profile operating window (JH 06:00 to 21:00).
  - No overlap with school hours.

  Source: MoE 10.1(v),(vi),(viii); Raj s.11; JH s.13.
- [ ] **AU-5 [automation] Faculty or schedule change notice.** Changes require 7 days' advance notice to students, and the notice triggers MO-10 where applicable (J&K r.8(a),(e)).
- [ ] **AU-6 [automation] Disclosure staleness check.** Alert when the website disclosure pack (PL-4) is older than the latest change to fees, faculty, batch caps or results.

### Analytics
- [ ] **AN-1 [analytics] Results statistics.** Computed from enrolment and Evidence records with fixed definitions:
  - number coached;
  - number who succeeded in getting admission to higher education institutions (MoE 6(ii));
  - **percentage** (Raj s.8(3); JH "percentage of selection").

  The same numbers feed PL-4 and any ME-2 claim, so advertised and disclosed figures cannot diverge.
- [ ] **AN-2 [analytics] Compliance dashboard:**
  - refund SLA attainment and breaches;
  - complaint ageing;
  - eligibility overrides;
  - blocked-claim counts by template;
  - consent coverage of published testimonials.
- [ ] **AN-3 [analytics] Anonymised wellness and annual report export**: interventions, referrals and training sessions (SC Guideline X; JH s.17(1)(t) annual report).
- [ ] **AN-4 [analytics] No performance-based segmentation** of students into batches or parent campaigns (MoE 12(vii); SC IV). Performance analytics stay per-student and private.

---

## 6. Open questions (need counsel or product decisions)

1. **Q1. Which Phoenix B2C offerings are "coaching"** (tuition or exam prep above the threshold) and which are school or college admissions outside these rules? Which states do Phoenix's own centres operate in?
2. **Q2. Phoenix's own exposure as a B2B platform.** Is Phoenix "a party to the publication" (CPA s.21(4)) when it delivers tenant messages or generates AI copy? Should the linter be blocking by default for tenants, or advisory?
3. **Q3. CCPA scope below 50 students.** Do cl. 3 and 4 bind coaching providers with 50 or fewer students, given the "or provides coaching" wording?
4. **Q4. Start and basis of the 10 days.** Does the clock run from the request, from approval, or from the last attended class? Calendar or working days? Must the money be received, or only initiated, within 10 days? The MoE, Rajasthan and J&K texts are silent.
5. **Q5. Instalment payers.** Do the pro-rata rules (framed for "paid ... in full") apply, and how?
6. **Q6. Deductions.** Is any administrative or processing deduction lawful? None is mentioned in the MoE or Rajasthan texts, and material must be free.
7. **Q7. Hostel and mess.** In MoE-baseline states, is the refund pro-rata or something else?
8. **Q8. Gazette texts not yet read:** Andhra Pradesh, Himachal Pradesh, Madhya Pradesh, Meghalaya, Tamil Nadu, Puducherry, Andaman & Nicobar, Tripura, Nagaland, Assam, Haryana, plus Bihar, Goa, UP, Karnataka and Manipur. Their age, refund and instalment terms need to be loaded into PL-1 before go-live in those states.
9. **Q9. CCPA text.** Confirm the official consumeraffairs.nic.in PDF matches the reproduction and that nothing follows cl. 4(2).
10. **Q10. MoE age clause.** Does "below 16 years of age **or** ... only after secondary school examination" mean both conditions apply (reading A, the default) or either one suffices (reading B)?
11. **Q11. Foundation courses for Classes 6 to 10.** Is Phoenix willing to stop or restructure them in states with a hard 16+ gate, or to cap them below the student threshold?
12. **Q12. Retention periods** for enrolment, refund and complaint records per state ("as may be prescribed").
13. **Q13. Rajasthan commencement.** Has the Act been brought into force, and have its rules been notified (registration fee, portal, prescribed forms)? Not found as of 6 Nov 2026.
14. **Q14. Online coaching.** The MoE guidelines are centre-oriented, while Jharkhand expressly covers online and hybrid. How should Phoenix's online courses be treated in other states?
15. **Q15. Helpline numbers.** Confirm the current Tele-MANAS and NCH numbers and preferred display text before ME-8 ships.

---

## 7. Sources (all accessed 6 November 2026)

- [S1] Ministry of Education, Dept. of Higher Education, letter No. 5-35/2023-PN-II dated 16.01.2024 and "Guidelines for Regulation of Coaching Center, January 2024" (13-page PDF). https://www.dohe-education.gov.in/static/uploads/2026/07/bfa0f6e58701e2cc628a7abfb74191a6.pdf. Official page: https://www.dohe-education.gov.in/documents/acts-and-policies/guidelines-for-regulation-of-coaching-center-ADNyEDOtQWa. The old URL https://education.gov.in/sites/upload_files/mhrd/files/document-reports/Guideliens_Coaching_Centres_en.pdf now returns 404.
- [S2] The Rajasthan Coaching Centres (Control and Regulation) Act, 2025 (Act No. 16 of 2025), authorised English translation, Rajasthan Gazette notification No. F. 2(16)Vidhi/2/2025 dated 24 Sep 2025 (PRS copy). https://prsindia.org/files/bills_acts/acts_states/rajasthan/2025/Act16of2025RJ.pdf
- [S3] Supreme Court of India, *Sukdeb Saha v. State of Andhra Pradesh & Ors.*, judgment dated 25.07.2025, 2025 INSC 893 (LiveLaw reproduction, 2025 LiveLaw (SC) 740). https://www.livelaw.in/pdf_upload/2025-livelaw-sc-740-sukdeb-saha-v-state-of-andhra-pradesh-25-jul-2025-612852.pdf. Report: https://www.livelaw.in/supreme-court/in-neet-aspirants-death-case-supreme-court-issues-guidelines-to-protect-mental-health-of-students-in-colleges-coaching-centres-298795
- [S4] The Jharkhand Coaching Centre (Control and Regulation) Act, 2025 (Jharkhand Act 01, 2026), Jharkhand Gazette (PRS copy). https://prsindia.org/files/bills_acts/acts_states/jharkhand/2026/Act1of2026JH.pdf
- [S5] Government of UT of Jammu & Kashmir, School Education Department, Notification S.O. 19, January 2026: coaching/study centre rules issued under SC para 37. https://law.jk.gov.in/download.php?id=4230
- [S6] Central Consumer Protection Authority, Notification dated 13 November 2024, "Guidelines for Prevention of Misleading Advertisement in Coaching Sector, 2024" (LiveLaw reproduction). https://livelaw.in/pdf_upload/guidelines-for-prevention-of-misleading-advertisement-in-coaching-sector-2024-571711.pdf. Official copy as linked by PIB: https://consumeraffairs.nic.in/sites/default/files/file-uploads/latestnews/Guidelines%20for%20Prevention%20of%20Misleading%20Advertisement%20in%20Coaching%20Sector%2C%202024.pdf (not retrievable from this environment).
- [S7] PIB (Ministry of Consumer Affairs), "Central Consumer Protection Authority Issues Guidelines for 'Prevention of Misleading Advertisement in Coaching Sector'", 13 Nov 2024. https://pib.gov.in/PressReleasePage.aspx?PRID=2073013
- [S8] PIB, "CCPA Imposes ₹15 Lakh Penalty on Coaching Institute for Misleading Advertisement", 23 Feb 2026. https://www.pib.gov.in/PressReleasePage.aspx?PRID=2231796
- [S9] PIB, "Parliament Question: Regulation and Oversight of Private Coaching Institution" (Rajya Sabha written reply, MoS Education), 12 Aug 2026. https://www.pib.gov.in/PressReleasePage.aspx?PRID=2298513
- [S10] Consumer Protection Act, 2019, s.21 and s.89 (bare-act reproduction; verify against India Code). https://www.advocatekhoj.com/library/bareacts/consumerprotection2019/21.php ; https://www.advocatekhoj.com/library/bareacts/consumerprotection2019/89.php
- [S11] Secondary reporting on consumer-commission coaching refund cases (FIITJEE; *Sehgal School of Competition v. Dalbir Singh*): https://www.moneylife.in/article/students-can-sue-for-refund-of-fees/37790/64719.html ; https://www.courtkutchehry.com/judgements/620135/sehgal-school-of-competition-vs-dalbir-singh ; https://www.mondaq.com/india/dodd-frank-consumer-protection-act/1631936/ (holdings Unconfirmed)
- [S12] Guidelines for Prevention and Regulation of Dark Patterns, 2023 (CCPA, 30 Nov 2023): secondary summaries. https://www.jsalaw.com/newsletters-and-updates/ccpa-issues-guidelines-for-prevention-and-regulation-of-dark-patterns-2023/ ; https://mondaq.com/india/consumer-trading-unfair-trading/1398262/
- [S13] Digital Personal Data Protection Act, 2023 (s.2(f), s.9) and DPDP Rules, 2025, G.S.R. 846(E) dated 13 Nov 2025 (Rule 1, Rule 10), Gazette of India (copies previously downloaded for the DPDP research workstream).
- [S14] NewsDrum, "Jharkhand Guv clears bill to regulate coaching centres in state" (Jan 2026). https://www.newsdrum.in/national/jharkhand-guv-clears-bill-to-regulate-coaching-centres-in-state-11016953
- [S15] Careers360, bill-stage report on Rajasthan coaching bill ("no enrollment below 16"). https://news.careers360.com/rajasthan-passes-coaching-regulation-bill-2025-no-enrollment-below-16-mandatory-registration-for-institutes (contradicted by the enacted text, S2)
- [S16] News on 2026 state rules: Kashmir Observer (J&K, 4 Feb 2026) https://kashmirobserver.net/2026/02/04/jk-notifies-new-rules-for-coaching-centres/ ; Shillong Times (Meghalaya, 27 Mar 2026) https://theshillongtimes.com/2026/03/27/coaching-centres-told-to-register-with-edn-dept/ ; Free Press Journal (MP, Oct 2026) https://www.freepressjournal.in/bhopal/madhya-pradesh-coaching-centre-rules-2026-come-into-force-registration-mandatory-within-90-days-cctv-and-mental-health-counsellors-required ; The Hitavada (MP, 26 Oct 2026) https://www.thehitavada.com/Encyc/2026/10/26/mp-tightens-noose-on-coaching-centres-90-day-registration-mental-health-counsellors-and-cctv-mandatory.html ; APTeachers (AP G.O. Ms. No. 9, 27.03.2026) https://www.apteachers.in/2026/03/the-andhra-pradesh-coaching.html ; Careers360 (Maharashtra draft) https://news.careers360.com/maharashtra-introduce-policy-regulate-jee-neet-cet-coaching-centres-registration-fee-structure-misleading-claims-guidelines-report/amp
- [S17] ANI, "CCPA fines coaching centres combined Rs 15 lakh for misleading advertisements, unfair trade practices", 16 May 2026. https://aninews.in/news/national/general-news/ccpa-fines-coaching-centres-combined-rs-15-lakh-for-misleading-advertisements-unfair-trade-practices20260516012137/

