import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { hashPassword } from '../../lib/crypto.js';
import { productKind } from '../../core/crm/constants.js';
import { displayName, normalizeName } from '../../core/crm/normalize.js';
import { reindexSearch } from '../../core/crm/search.js';
import { insertTimelineEvents } from '../../core/crm/timeline.js';

// Demo CRM data for local development (docs/crm/PHASE2_CONTRACT.md §14): product lines and
// products, pipelines with SLAs and rules, lost reasons and custom fields for Pi Vector, SatnPaper
// and Excel; about 80 families and 15 institutes; about 200 leads across stages, owners and every
// channel, with their timelines, tasks and consent records; and the search index.
//
// Everything is generated from a fixed seed, so every run produces the same people. Phone numbers
// use the fake +91 90000 0xxxx range and emails are @example.com. Skipped when CRM data exists.

const GROUP_CODE = 'phoenix';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();

// ---------- Deterministic randomness ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261106);
const between = (min, max) => min + Math.floor(random() * (max - min + 1));
const chance = (p) => random() < p;
const pick = (items) => items[Math.floor(random() * items.length)];
function weighted(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}
const at = (ms) => new Date(Math.min(ms, NOW - MINUTE));
const OLDER_GRADES = ['11', '12', 'dropper', 'gap_year'];

// ---------- People ----------

const SURNAMES = [
  'Sharma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Mehta', 'Joshi', 'Kulkarni', 'Deshpande', 'Rao', 'Menon', 'Pillai',
  'Banerjee', 'Mukherjee', 'Das', 'Singh', 'Gill', 'Khan', 'Siddiqui', 'Fernandes', "D'Souza", 'Kapoor', 'Malhotra',
  'Agarwal', 'Jain', 'Saxena', 'Mishra', 'Tiwari', 'Naidu', 'Hegde', 'Shetty', 'Kamath', 'Bhat', 'Dutta', 'Ghosh',
  'Chauhan', 'Arora', 'Bhatia', 'Sethi', 'Sinha', 'Krishnan', 'Venkatesh', 'Narayanan', 'Srivastava', 'Gupta',
  'Verma', 'Shah', 'Chopra', 'Bose', 'Qureshi',
];
const MOTHERS = ['Priya', 'Anjali', 'Neha', 'Pooja', 'Kavita', 'Sunita', 'Meera', 'Lakshmi', 'Deepa', 'Shalini', 'Rekha', 'Swati', 'Nandini', 'Radhika', 'Farah', 'Ayesha', 'Simran', 'Gurpreet', 'Sneha', 'Vandana'];
const FATHERS = ['Rajesh', 'Suresh', 'Amit', 'Vikram', 'Sanjay', 'Arvind', 'Manoj', 'Rakesh', 'Anil', 'Ravi', 'Prakash', 'Srinivas', 'Venkat', 'Imran', 'Harpreet', 'Nitin', 'Ajay', 'Karthik', 'Ganesh', 'Deepak'];
const SONS = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Sai', 'Reyansh', 'Ishaan', 'Rohan', 'Aryan', 'Dhruv', 'Atharv', 'Advait', 'Vihaan', 'Neel', 'Yash', 'Parth', 'Siddharth', 'Varun', 'Krish', 'Ayaan'];
const DAUGHTERS = ['Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Ishita', 'Kavya', 'Myra', 'Anika', 'Riya', 'Tara', 'Meher', 'Zara', 'Navya', 'Prisha', 'Avni', 'Kiara', 'Aditi', 'Shreya', 'Tanvi', 'Mahika'];
const SCHOOLS = [
  'Sunrise Public School', 'Lotus Valley School', 'Green Meadows International', 'Blue Bells Convent School', 'Vidya Niketan',
  'Riverdale High School', 'Orchid International School', 'Pinewood Academy', 'Silver Birch School', 'Heritage Vidyalaya',
];

let phoneCounter = 0;
let emailCounter = 0;
const nextIndianPhone = () => {
  phoneCounter += 1;
  const digits = String(phoneCounter).padStart(5, '0');
  return { value: `+91 90000 ${digits}`, normalized: `+9190000${digits}` };
};
const nextDubaiPhone = () => {
  phoneCounter += 1;
  const digits = String(phoneCounter).padStart(4, '0');
  return { value: `+971 50 000 ${digits}`, normalized: `+97150000${digits}` };
};
const emailFor = (first, last) => {
  emailCounter += 1;
  const local = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
  return `${local}${emailCounter}@example.com`;
};

// ---------- Company catalogs ----------

const B2C_STAGES = [
  { key: 'new_enquiry', name: 'New enquiry', category: 'open', probability: 5, sla: 4, colour: '#626A78' },
  { key: 'contacted', name: 'Contacted', category: 'open', probability: 15, sla: 48, colour: '#2840D8' },
  { key: 'demo_booked', name: 'Demo booked', category: 'open', probability: 35, sla: 72, colour: '#6D28D9', required: ['productLineId', 'students', 'custom.grade'] },
  { key: 'demo_done', name: 'Demo done', category: 'open', probability: 55, sla: 48, colour: '#0E7490' },
  { key: 'fee_proposed', name: 'Fee proposed', category: 'open', probability: 75, sla: 120, colour: '#9A4A00', required: ['productId', 'valueMinor'] },
  { key: 'enrolled', name: 'Enrolled', category: 'won', probability: 100, colour: '#067647', required: ['productId', 'valueMinor'], allowedFrom: ['demo_done', 'fee_proposed'] },
  { key: 'lost', name: 'Lost', category: 'lost', probability: 0, colour: '#B42318' },
];

const B2B_STAGES = [
  { key: 'new', name: 'New', category: 'open', probability: 5, sla: 24, colour: '#626A78' },
  { key: 'qualified', name: 'Qualified', category: 'open', probability: 15, sla: 72, colour: '#2840D8', required: ['accountId', 'custom.student_count'] },
  { key: 'discovery_call', name: 'Discovery call', category: 'open', probability: 25, sla: 120, colour: '#4338CA' },
  { key: 'product_demo', name: 'Product demo', category: 'open', probability: 40, sla: 120, colour: '#6D28D9', required: ['productLineId'] },
  { key: 'trial', name: 'Trial', category: 'open', probability: 55, sla: 336, colour: '#0E7490' },
  { key: 'quote_sent', name: 'Quote sent', category: 'open', probability: 70, sla: 168, colour: '#9A4A00', required: ['productId', 'valueMinor'] },
  { key: 'negotiation', name: 'Negotiation', category: 'open', probability: 85, sla: 168, colour: '#B45309' },
  { key: 'contract_signed', name: 'Contract signed', category: 'won', probability: 100, colour: '#067647', required: ['productId', 'valueMinor', 'expectedCloseOn'], allowedFrom: ['quote_sent', 'negotiation'] },
  { key: 'lost', name: 'Lost', category: 'lost', probability: 0, colour: '#B42318' },
];

const B2C_LOST = [
  ['Fee too high', false],
  ['Chose another institute', false],
  ['Not interested any more', false],
  ["Couldn't reach them", false],
  ["Batch timing doesn't suit", false],
  ['Wrong number or spam', false],
  ['Other', true],
];
const B2B_LOST = [
  ['Went with a competitor', true],
  ['No budget this year', false],
  ['Not the decision maker', false],
  ['Missing features', true],
  ['Timeline too far out', false],
  ['Stopped responding', false],
];

const opt = (value, label) => ({ value, label });
const BOARD_OPTIONS = [opt('cbse', 'CBSE'), opt('icse', 'ICSE'), opt('ib', 'IB'), opt('igcse', 'IGCSE'), opt('state', 'State board'), opt('other', 'Other')];
const MODE_OPTIONS = [opt('online', 'Online'), opt('centre', 'At the centre'), opt('hybrid', 'Hybrid')];
const TIMING_OPTIONS = [opt('weekday_morning', 'Weekday mornings'), opt('weekday_evening', 'Weekday evenings'), opt('weekend', 'Weekends')];
const B2B_FIELDS = [
  { key: 'student_count', label: 'Students at the institute', type: 'number', appliesTo: 'b2b', help: 'Drives per-student pricing' },
  { key: 'branch_count', label: 'Branches', type: 'number', appliesTo: 'b2b' },
  { key: 'current_software', label: 'Current software', type: 'text', appliesTo: 'b2b' },
  {
    key: 'decision_timeline',
    label: 'Decision timeline',
    type: 'select',
    appliesTo: 'b2b',
    options: [opt('this_month', 'This month'), opt('this_quarter', 'This quarter'), opt('next_quarter', 'Next quarter'), opt('later', 'Later')],
  },
  {
    key: 'budget_band',
    label: 'Budget',
    type: 'select',
    appliesTo: 'b2b',
    options: [opt('under_1l', 'Under ₹1 lakh'), opt('l1_5', '₹1–5 lakh'), opt('l5_15', '₹5–15 lakh'), opt('over_15l', 'Over ₹15 lakh')],
  },
];

const gradeOptions = (grades) => grades.map((g) => (g === 'dropper' ? opt('dropper', 'Dropper (repeat year)') : g === 'gap_year' ? opt('gap_year', 'Gap year') : opt(`class_${g}`, `Class ${g}`)));

// fee: indicative fee in minor units, used for demo deal values only (prices arrive with the money phase)
const CATALOG = {
  satnpaper: [
    { key: 'sat_group_batch', name: 'SAT group batches', kind: 'group_batch', grades: ['10', '11', '12'], products: [
      { code: 'SAT-GB-WKND', name: 'SAT Weekend Batch (12 weeks)', fee: 5_500_000, attributes: { mode: 'online', durationWeeks: 12, exam: 'SAT' } },
      { code: 'SAT-GB-EVE', name: 'SAT Weekday Evening Batch (10 weeks)', fee: 4_800_000, attributes: { mode: 'online', durationWeeks: 10, exam: 'SAT' } },
    ] },
    { key: 'sat_mentorship', name: 'SAT 1:1 mentorship', kind: 'mentorship_1to1', grades: ['11', '12', 'gap_year'], products: [
      { code: 'SAT-1ON1-24', name: 'SAT 1:1 Mentorship, 24 sessions', fee: 18_000_000, attributes: { mode: 'online', sessions: 24, exam: 'SAT' } },
      { code: 'SAT-1ON1-12', name: 'SAT 1:1 Mentorship, 12 sessions', fee: 9_500_000, attributes: { mode: 'online', sessions: 12, exam: 'SAT' } },
    ] },
    { key: 'sat_crash', name: 'SAT crash courses', kind: 'crash_course', grades: ['11', '12', 'gap_year'], products: [
      { code: 'SAT-CRASH-4W', name: 'SAT 4-week Crash Course', fee: 1_800_000, attributes: { mode: 'online', durationWeeks: 4, exam: 'SAT' } },
    ] },
    { key: 'sat_tests', name: 'SAT test series', kind: 'test_series', grades: ['10', '11', '12', 'gap_year'], products: [
      { code: 'SAT-TS-10', name: 'SAT Full-length Test Series (10 tests)', fee: 600_000, attributes: { tests: 10, exam: 'SAT' } },
    ] },
    { key: 'us_admissions', name: 'US admissions programs', kind: 'program', grades: ['9', '10', '11'], products: [
      { code: 'SAT-USADM', name: 'SAT + US Admissions Program', fee: 35_000_000, attributes: { mode: 'hybrid', durationWeeks: 40 } },
      { code: 'AP-PREP', name: 'AP Exam Prep Program', fee: 7_500_000, attributes: { mode: 'online', exam: 'AP' } },
    ] },
    { key: 'testhub', name: 'SatnPaper TestHub', kind: 'software_test_platform', products: [
      { code: 'TH-STD', name: 'TestHub Standard (per student, yearly)', fee: 40_000, attributes: { billing: 'per_student_year' } },
      { code: 'TH-PRO', name: 'TestHub Pro (per student, yearly)', fee: 65_000, attributes: { billing: 'per_student_year' } },
    ] },
    { key: 'campus_erp', name: 'SatnPaper Campus ERP', kind: 'software_erp', products: [
      { code: 'ERP-BRANCH', name: 'Campus ERP (per branch, yearly)', fee: 12_000_000, attributes: { billing: 'per_branch_year' } },
      { code: 'ERP-ADM', name: 'Campus ERP admissions add-on', fee: 4_000_000, attributes: { billing: 'per_branch_year', addOn: true } },
    ] },
  ],
  pivector: [
    { key: 'jee_classroom', name: 'JEE classroom batches', kind: 'group_batch', grades: ['9', '10', '11', 'dropper'], products: [
      { code: 'JEE-2Y', name: 'JEE Main 2-year Classroom Batch', fee: 24_000_000, attributes: { mode: 'centre', durationWeeks: 96, exam: 'JEE Main' } },
      { code: 'JEE-DROP', name: 'JEE Main Dropper Batch (1 year)', fee: 16_000_000, attributes: { mode: 'centre', durationWeeks: 48, exam: 'JEE Main' } },
    ] },
    { key: 'jee_mentorship', name: 'JEE 1:1 mentorship', kind: 'mentorship_1to1', grades: ['11', '12', 'dropper'], products: [
      { code: 'JEE-1ON1-PHY', name: 'JEE Advanced 1:1 Physics Mentorship', fee: 12_000_000, attributes: { mode: 'hybrid', sessions: 40, exam: 'JEE Advanced' } },
    ] },
    { key: 'jee_crash', name: 'JEE crash courses', kind: 'crash_course', grades: ['12', 'dropper'], products: [
      { code: 'JEE-CRASH-45', name: 'JEE Main 45-day Crash Course', fee: 2_500_000, attributes: { mode: 'hybrid', durationWeeks: 7, exam: 'JEE Main' } },
    ] },
    { key: 'jee_tests', name: 'JEE test series', kind: 'test_series', grades: ['11', '12', 'dropper'], products: [
      { code: 'JEE-AITS', name: 'JEE Main All-India Test Series', fee: 800_000, attributes: { tests: 25, exam: 'JEE Main' } },
    ] },
    { key: 'olympiad', name: 'Olympiad programs', kind: 'program', grades: ['8', '9', '10'], products: [
      { code: 'OLY-FND', name: 'Physics Olympiad Foundation (Class 8–10)', fee: 4_000_000, attributes: { mode: 'centre', grades: ['8', '9', '10'] } },
    ] },
    { key: 'test_engine', name: 'Pi Vector Test Engine', kind: 'software_test_platform', products: [
      { code: 'PVTE-INST', name: 'Test Engine institute licence (yearly)', fee: 25_000_000, attributes: { billing: 'per_institute_year' } },
    ] },
    { key: 'coaching_erp', name: 'Pi Vector Coaching ERP', kind: 'software_erp', products: [
      { code: 'PVERP-STD', name: 'Coaching ERP Standard (per branch, yearly)', fee: 9_000_000, attributes: { billing: 'per_branch_year' } },
    ] },
  ],
  excel: [
    { key: 'board_batches', name: 'Board exam batches', kind: 'group_batch', grades: ['9', '10', '12'], products: [
      { code: 'EX-B10-CBSE', name: 'Class 10 CBSE Board Batch', fee: 5_500_000, attributes: { mode: 'centre', grades: ['10'] } },
      { code: 'EX-B12-SCI', name: 'Class 12 Science Board Batch', fee: 7_500_000, attributes: { mode: 'centre', grades: ['12'] } },
    ] },
    { key: 'neet_crash', name: 'NEET crash courses', kind: 'crash_course', grades: ['12'], products: [
      { code: 'EX-NEET-60', name: 'NEET 60-day Crash Course', fee: 3_000_000, attributes: { mode: 'hybrid', durationWeeks: 9, exam: 'NEET' } },
    ] },
    { key: 'neet_tests', name: 'NEET test series', kind: 'test_series', grades: ['11', '12'], products: [
      { code: 'EX-NEET-TS', name: 'NEET Mock Test Series (20 tests)', fee: 750_000, attributes: { tests: 20, exam: 'NEET' } },
    ] },
    { key: 'tutoring', name: '1:1 tutoring', kind: 'mentorship_1to1', grades: ['8', '9', '10'], products: [
      { code: 'EX-1ON1-MATH', name: 'Maths 1:1 Tutoring (Class 9–10)', fee: 6_000_000, attributes: { mode: 'hybrid', sessions: 48 } },
    ] },
    { key: 'foundation', name: 'Foundation programs', kind: 'program', grades: ['8', '9', '10'], products: [
      { code: 'EX-FND', name: 'Foundation Program (Class 8–10)', fee: 9_000_000, attributes: { mode: 'centre', grades: ['8', '9', '10'] } },
    ] },
  ],
};

const COMPANY_SETUP = {
  satnpaper: {
    prefix: 'SP',
    b2c: { unit: 'sat-admissions', owners: ['kabir@phoenix.test', 'ritika@phoenix.test'] },
    b2b: { unit: 'software-sales', owners: ['sales.satnpaper@phoenix.test'] },
    families: 40,
    grades: ['9', '10', '11', '12', 'gap_year'],
    studentGrades: ['10', '11', '11', '12', '12'],
    exams: [opt('sat', 'SAT'), opt('act', 'ACT'), opt('ap', 'AP exams'), opt('psat', 'PSAT')],
    examFor: () => weighted([['sat', 8], ['act', 1], ['ap', 1]]),
    profileExam: 'SAT',
    cities: [['Pune', 'Maharashtra'], ['Mumbai', 'Maharashtra'], ['Bengaluru', 'Karnataka'], ['Hyderabad', 'Telangana'], ['New Delhi', 'Delhi'], ['Chennai', 'Tamil Nadu'], ['Kolkata', 'West Bengal'], ['Ahmedabad', 'Gujarat']],
    domain: 'satnpaper.example',
    campaigns: ['sat_2027_launch', 'sat_diwali_offer', 'sat_score_boost'],
    extraFields: [
      { key: 'batch_timing', label: 'Preferred batch timing', type: 'select', appliesTo: 'b2c', options: TIMING_OPTIONS },
      { key: 'target_score', label: 'Target SAT score', type: 'number', appliesTo: 'b2c', help: 'Out of 1600' },
    ],
  },
  pivector: {
    prefix: 'PV',
    b2c: { unit: 'admissions', owners: ['admin.pivector@phoenix.test'] },
    b2b: { unit: null, owners: ['admin.pivector@phoenix.test'] },
    families: 24,
    grades: ['8', '9', '10', '11', '12', 'dropper'],
    studentGrades: ['9', '10', '11', '11', '12', 'dropper'],
    exams: [opt('jee_main', 'JEE Main'), opt('jee_advanced', 'JEE Advanced'), opt('bitsat', 'BITSAT'), opt('olympiad', 'Olympiad')],
    examFor: () => weighted([['jee_main', 6], ['jee_advanced', 3], ['olympiad', 1]]),
    profileExam: 'JEE Main',
    cities: [['New Delhi', 'Delhi'], ['Gurugram', 'Haryana'], ['Noida', 'Uttar Pradesh'], ['Faridabad', 'Haryana'], ['Ghaziabad', 'Uttar Pradesh']],
    domain: 'pivector.example',
    campaigns: ['jee_2028_foundation', 'jee_crash_jan', 'olympiad_camp'],
    extraFields: [],
  },
  excel: {
    prefix: 'EX',
    b2c: { unit: 'admissions', owners: ['admin.excel@phoenix.test'] },
    b2b: null,
    families: 18,
    grades: ['8', '9', '10', '11', '12'],
    studentGrades: ['8', '9', '10', '10', '12'],
    exams: [opt('cbse_boards', 'CBSE boards'), opt('icse_boards', 'ICSE boards'), opt('neet', 'NEET'), opt('mht_cet', 'MHT CET')],
    examFor: () => weighted([['cbse_boards', 4], ['icse_boards', 2], ['neet', 3], ['mht_cet', 1]]),
    profileExam: 'Boards',
    cities: [['Mumbai', 'Maharashtra'], ['Thane', 'Maharashtra'], ['Navi Mumbai', 'Maharashtra']],
    domain: 'excel.example',
    campaigns: ['boards_2027', 'neet_crash_dec'],
    extraFields: [{ key: 'batch_timing', label: 'Preferred batch timing', type: 'select', appliesTo: 'b2c', options: TIMING_OPTIONS }],
  },
};

const INSTITUTES = [
  { name: 'Apex Coaching Centre', kind: 'coaching_institute', city: ['Kota', 'Rajasthan'], branches: 3, students: 1800, software: 'Spreadsheets', companies: ['satnpaper'] },
  { name: 'Brilliant Minds Academy', kind: 'coaching_institute', city: ['Jaipur', 'Rajasthan'], branches: 2, students: 950, software: 'Another test platform', companies: ['satnpaper', 'pivector'] },
  { name: 'Vidyarthi Tutorials', kind: 'coaching_institute', city: ['Nagpur', 'Maharashtra'], branches: 1, students: 420, software: 'Paper registers', companies: ['satnpaper'] },
  { name: 'Aim High Classes', kind: 'coaching_institute', city: ['Indore', 'Madhya Pradesh'], branches: 4, students: 2600, software: 'In-house ERP', companies: ['pivector'] },
  { name: 'Pinnacle IIT Academy', kind: 'coaching_institute', city: ['Hyderabad', 'Telangana'], branches: 6, students: 5200, software: 'Another ERP', companies: ['pivector', 'satnpaper'] },
  { name: "Scholars' Point", kind: 'coaching_institute', city: ['Lucknow', 'Uttar Pradesh'], branches: 2, students: 780, software: 'Spreadsheets', companies: ['satnpaper'] },
  { name: 'Summit Test Prep', kind: 'coaching_institute', city: ['Bengaluru', 'Karnataka'], branches: 1, students: 300, software: 'Generic LMS', companies: ['satnpaper'] },
  { name: 'Excelsior Institute', kind: 'coaching_institute', city: ['Patna', 'Bihar'], branches: 3, students: 2100, software: 'None', companies: ['pivector'] },
  { name: 'Greenwood International School', kind: 'school', city: ['Pune', 'Maharashtra'], branches: 1, students: 2400, software: 'Another ERP', companies: ['satnpaper'] },
  { name: 'Silver Oak Public School', kind: 'school', city: ['Ahmedabad', 'Gujarat'], branches: 2, students: 3100, software: 'In-house ERP', companies: ['satnpaper'] },
  { name: 'Lakeview Senior Secondary School', kind: 'school', city: ['Bhopal', 'Madhya Pradesh'], branches: 1, students: 1700, software: 'Paper registers', companies: ['pivector'] },
  { name: "St. Anne's Convent School", kind: 'school', city: ['Chandigarh', 'Chandigarh'], branches: 1, students: 1500, software: 'Spreadsheets', companies: ['satnpaper'] },
  { name: 'Sahyadri Junior College', kind: 'college', city: ['Nashik', 'Maharashtra'], branches: 1, students: 1200, software: 'Another test platform', companies: ['satnpaper'] },
  { name: 'Meera Iyer Mentoring', kind: 'independent_mentor', city: ['Chennai', 'Tamil Nadu'], branches: 1, students: 60, software: 'None', companies: ['satnpaper'] },
  { name: 'Rahul Desai Maths Studio', kind: 'independent_mentor', city: ['Vadodara', 'Gujarat'], branches: 1, students: 85, software: 'Generic LMS', companies: ['pivector'] },
];

const STAFF_ROLES = [
  { title: 'Director', role: 'decision_maker', primary: true },
  { title: 'Academic head', role: 'influencer' },
  { title: 'Accounts manager', role: 'billing' },
];

// ---------- Messages ----------

// What families write, by product line. {child} is "son" or "daughter".
const B2C_MESSAGES = {
  sat_group_batch: [
    'Hi, my {child} is in Class {grade} and wants to take the SAT next year. Do you have weekend batches?',
    'Can we get a free demo class for the SAT batch this weekend?',
  ],
  sat_mentorship: [
    'Hello, looking for 1:1 SAT coaching for my {child}, target 1500+. What are the fees?',
    'Is one-to-one SAT mentoring available in the evenings? {student} is in Class {grade}.',
  ],
  sat_crash: ["Hi! Saw your Instagram ad. Is the SAT crash course fully online? {student}'s test is in six weeks."],
  sat_tests: ["What is the fee for the SAT test series? {student} has been studying on {their} own and wants full-length practice."],
  us_admissions: ['Good evening. {student} wants to apply to US universities. Do you help with both the SAT and applications?'],
  jee_classroom: [
    'Namaste, my {child} is in class {grade}. We want to start JEE preparation. Is there a 2-year batch at your Delhi centre?',
    'What are the fees for the dropper batch? We are in {city}.',
  ],
  jee_mentorship: ['Hi, need physics mentorship for JEE Advanced. Is 1:1 available on weekends?'],
  jee_crash: ['Hello sir, is the JEE crash course still open for January? {student} is in class {grade}.'],
  jee_tests: ['Do you have an all-India test series for JEE Main? Please share the fee and schedule.'],
  olympiad: ['My {child} cleared NSEP stage 1. Do you have an Olympiad program for class {grade}?'],
  board_batches: [
    'Hi, need coaching for Class {grade} boards, maths and science. We are in {city}.',
    'Do you have board batches for class {grade}? Weekend timings preferred.',
  ],
  neet_crash: ['Hello, is the NEET crash course offline or online? Fees please. {student} is in class {grade}.'],
  neet_tests: ['Does the NEET mock test series have full-length papers with analysis?'],
  tutoring: ['My {child} needs 1:1 maths tutoring, class {grade}. Can someone call me after 6 pm?'],
  foundation: ['Interested in the foundation program for class {grade}. When does the new batch start?'],
};
const STUDENT_MESSAGES = ["Hi, I'm {student}, in class {grade}. I'm interested in {line}. Can you share the details and fees?"];
const CALL_SUMMARY = 'Incoming call: {parent} asked about {line} for their {child} in class {grade}. Wants a call back {when}.';
const LEAD_FORM = 'Lead form answers. Grade: {grade}. Interested in: {line}. City: {city}.';

/** Fill a message template. */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] !== undefined ? String(values[key]) : match));
}

const B2B_MESSAGES = [
  'We are a coaching institute with {students} students and want an online test platform for weekly tests. Can we get a demo?',
  'Looking for an ERP for fee collection, attendance and admissions across {branches} branches. Please share pricing.',
  'Our current tool is {software}. We are evaluating alternatives for the next academic year.',
  'Please call our director to discuss the test platform. We need it before the March batch starts.',
];
const NOTES = [
  'Parent prefers WhatsApp over calls. Best time is after 7 pm.',
  'Student is strong in maths, weaker in reading. Suggested the diagnostic test first.',
  'Asked for an instalment option. Told them finance will share the plan with the proposal.',
  'Elder sibling studied with us. Family is happy with the mentors.',
  'Wants to compare with another institute before deciding. Follow up on Friday.',
  'Demo went well. Student asked good questions about the practice tests.',
];
const B2B_NOTES = [
  'Director wants pricing per student for 2 years upfront.',
  'IT head asked about data import from their spreadsheets. Shared the import template.',
  'They need Hindi support in the student app. Logged as a requirement.',
  'Trial accounts created for 3 teachers and 120 students.',
];

// ---------- Helpers ----------

const json = (value) => JSON.stringify(value ?? null);

function touch(channel, companyKey, when) {
  const setup = COMPANY_SETUP[companyKey];
  const base = { channel, at: new Date(when).toISOString() };
  switch (channel) {
    case 'website_form':
    case 'website_checkout':
      return {
        ...base,
        landingUrl: `https://${setup.domain}/${channel === 'website_checkout' ? 'checkout' : 'enquire'}`,
        referrer: pick(['https://www.google.com/', 'https://www.bing.com/', 'https://duckduckgo.com/']),
        utm: { source: pick(['google', 'bing', 'newsletter']), medium: pick(['cpc', 'organic', 'email']), campaign: pick(setup.campaigns) },
        formId: channel === 'website_form' ? 'enquiry' : 'checkout',
      };
    case 'lead_ad_instagram':
    case 'lead_ad_facebook': {
      const source = channel === 'lead_ad_instagram' ? 'instagram' : 'facebook';
      return { ...base, campaign: pick(setup.campaigns), adId: `${source}_ad_${between(1000, 9999)}`, utm: { source, medium: 'paid_social', campaign: pick(setup.campaigns) } };
    }
    case 'partner_referral':
      return { ...base, partnerId: pick(['bright-future-consultants', 'campus-connect', 'edupath-advisors']), campaign: 'partner_referrals', referrer: `https://partners.${setup.domain}/r/${between(100, 999)}` };
    case 'whatsapp':
      return { ...base, campaign: chance(0.4) ? pick(setup.campaigns) : undefined };
    default:
      return base;
  }
}

function originalMessage(channel, text, when, from) {
  if (channel === 'csv_import' || channel === 'manual') return null;
  const subject = channel === 'email' || channel === 'website_form' ? 'Enquiry' : undefined;
  return { channel, text, subject, receivedAt: new Date(when).toISOString(), from };
}

const MESSAGE_KIND = { whatsapp: 'message', email: 'email', voice_call: 'call', website_form: 'message', website_checkout: 'message', lead_ad_instagram: 'message', lead_ad_facebook: 'message', partner_referral: 'message' };
const REPLY_KIND = { whatsapp: 'message', email: 'email', voice_call: 'call' };

async function insertChunks(knex, table, rows, size = 400) {
  for (let i = 0; i < rows.length; i += size) await knex(table).insert(rows.slice(i, i + size));
}

// ---------- Seed ----------

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('CRM demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  const units = await knex('org_units').where({ root_id: group.id });
  // Keys used in this file → the companies' codes in the org tree.
  const UNIT_CODES = { satnpaper: 'satnpaper', pivector: 'pi-vector', excel: 'excel' };
  const companyUnit = (key) => units.find((u) => u.type === 'company' && u.code === UNIT_CODES[key]);
  const unitIn = (companyCode, code) => {
    const company = companyUnit(companyCode);
    return code ? units.find((u) => u.code === code && u.path.startsWith(company.path) && u.id !== company.id) : company;
  };

  const excelAdmin = await ensureExcelAdmin(knex, companyUnit('excel'));
  if (await knex('pipelines').where({ group_id: group.id }).first()) {
    console.log('CRM demo data is already there.');
    return;
  }

  const users = new Map((await knex('users').select('id', 'email', 'name')).map((u) => [u.email, u]));
  if (excelAdmin) users.set(excelAdmin.email, excelAdmin);

  // Pi Vector sells software to institutes too.
  const pivector = companyUnit('pivector');
  const lines = pivector.profile?.businessLines ?? [];
  if (!lines.includes('b2b')) {
    await knex('org_units')
      .where({ id: pivector.id })
      .update({ profile: json({ ...pivector.profile, businessLines: [...new Set([...lines, 'b2c', 'b2b'])] }) });
  }

  for (const [code, setup] of Object.entries(COMPANY_SETUP)) {
    await knex('settings')
      .insert({ org_unit_id: companyUnit(code).id, key: 'deals.referencePrefix', value: json(setup.prefix) })
      .onConflict(['org_unit_id', 'key'])
      .ignore();
  }

  // ----- Company configuration -----
  const config = {};
  const productLineRows = [];
  const productRows = [];
  const pipelineRows = [];
  const stageRows = [];
  const lostReasonRows = [];
  const fieldRows = [];

  for (const [code, setup] of Object.entries(COMPANY_SETUP)) {
    const company = companyUnit(code);
    const base = { group_id: group.id, company_id: company.id };
    const companyConfig = { company, setup, productLines: [], stages: {}, pipelines: {}, lostReasons: { b2c: [], b2b: [] } };
    config[code] = companyConfig;

    CATALOG[code].forEach((line, lineIndex) => {
      const lineRow = {
        id: randomUUID(),
        ...base,
        key: line.key,
        name: line.name,
        kind: line.kind,
        audience: productKind(line.kind).audience,
        description: null,
        position: lineIndex,
      };
      productLineRows.push(lineRow);
      const products = line.products.map((product, index) => {
        const row = {
          id: randomUUID(),
          ...base,
          product_line_id: lineRow.id,
          code: product.code,
          name: product.name,
          attributes: json(product.attributes ?? {}),
          position: index,
        };
        productRows.push(row);
        return { ...row, fee: product.fee, billing: product.attributes?.billing ?? null };
      });
      companyConfig.productLines.push({ ...lineRow, grades: line.grades ?? null, products });
    });

    const kinds = setup.b2b ? ['b2c', 'b2b'] : ['b2c'];
    kinds.forEach((kind, position) => {
      const pipeline = {
        id: randomUUID(),
        ...base,
        key: kind === 'b2c' ? 'admissions' : 'software',
        name: kind === 'b2c' ? 'Admissions' : 'Software sales',
        kind,
        is_default: true,
        position,
      };
      pipelineRows.push(pipeline);
      companyConfig.pipelines[kind] = pipeline;
      companyConfig.stages[kind] = (kind === 'b2c' ? B2C_STAGES : B2B_STAGES).map((stage, index) => {
        const row = {
          id: randomUUID(),
          pipeline_id: pipeline.id,
          company_id: company.id,
          key: stage.key,
          name: stage.name,
          category: stage.category,
          position: index,
          probability: stage.probability,
          sla_hours: stage.sla ?? null,
          required_fields: stage.required ?? [],
          entry_rules: json(stage.allowedFrom ? { allowedFrom: stage.allowedFrom } : {}),
          colour: stage.colour,
        };
        stageRows.push(row);
        return row;
      });
      (kind === 'b2c' ? B2C_LOST : B2B_LOST).forEach(([label, requiresNote], index) => {
        const row = { id: randomUUID(), ...base, label, kind, requires_note: requiresNote, position: index };
        lostReasonRows.push(row);
        companyConfig.lostReasons[kind].push(row);
      });
    });

    const dealFields = [
      { key: 'grade', label: 'Grade', type: 'select', appliesTo: 'b2c', options: gradeOptions(setup.grades) },
      { key: 'target_exam', label: 'Target exam', type: 'select', appliesTo: 'b2c', options: setup.exams },
      { key: 'board', label: 'School board', type: 'select', appliesTo: 'b2c', options: BOARD_OPTIONS },
      { key: 'preferred_mode', label: 'Preferred mode', type: 'select', appliesTo: 'b2c', options: MODE_OPTIONS },
      ...setup.extraFields,
      ...(setup.b2b ? B2B_FIELDS : []),
    ];
    const contactFields = [
      {
        key: 'how_heard',
        label: 'How they heard of us',
        type: 'select',
        options: [opt('instagram', 'Instagram'), opt('youtube', 'YouTube'), opt('friend_family', 'Friends or family'), opt('school_seminar', 'School seminar'), opt('google', 'Google search'), opt('other', 'Other')],
      },
      ...(code === 'satnpaper' ? [{ key: 'referred_by', label: 'Referred by', type: 'text' }] : []),
    ];
    const accountFields = setup.b2b ? [{ key: 'software_renewal_on', label: 'Current software renews on', type: 'date' }] : [];
    for (const [entity, list] of [['deal', dealFields], ['contact', contactFields], ['account', accountFields]]) {
      list.forEach((field, index) =>
        fieldRows.push({
          id: randomUUID(),
          ...base,
          entity,
          key: field.key,
          label: field.label,
          type: field.type,
          options: json(field.options ?? []),
          required: false,
          applies_to: field.appliesTo ?? null,
          help: field.help ?? null,
          position: index,
        }),
      );
    }
  }

  await insertChunks(knex, 'product_lines', productLineRows);
  await insertChunks(knex, 'products', productRows);
  await insertChunks(knex, 'pipelines', pipelineRows);
  await insertChunks(knex, 'pipeline_stages', stageRows);
  await insertChunks(knex, 'lost_reasons', lostReasonRows);
  await insertChunks(knex, 'custom_field_definitions', fieldRows);

  // ----- People, institutes and deals -----
  const contacts = [];
  const methods = [];
  const links = new Map(); // `${contactId}:${companyId}` → link row
  const households = [];
  const members = [];
  const accounts = [];
  const accountLinks = [];
  const accountContacts = [];
  const deals = [];
  const dealContacts = [];
  const history = [];
  const timeline = [];
  const tasks = [];
  const consents = [];
  const numbers = {};

  function addContact({ kind, first, last, city, phones = [], emails = [], whatsapp = false, profile = {}, dob = null, createdAt, address = null }) {
    const id = randomUUID();
    const name = displayName(first, last);
    const contactMethods = [];
    phones.forEach((phone, index) => {
      contactMethods.push({ kind: 'phone', value: phone.value, normalized: phone.normalized, is_primary: index === 0, label: index === 0 ? 'Mobile' : null });
      if (whatsapp && index === 0) contactMethods.push({ kind: 'whatsapp', value: phone.value, normalized: phone.normalized, is_primary: true, label: 'WhatsApp' });
    });
    emails.forEach((email, index) => contactMethods.push({ kind: 'email', value: email, normalized: email, is_primary: index === 0, label: null }));
    for (const method of contactMethods) {
      methods.push({ id: randomUUID(), contact_id: id, group_id: group.id, ...method, opted_out_at: null, created_at: createdAt, updated_at: createdAt });
    }
    const row = {
      id,
      group_id: group.id,
      kind,
      first_name: first,
      last_name: last,
      display_name: name,
      name_normalized: normalizeName(name),
      primary_phone: phones[0]?.normalized ?? null,
      primary_email: emails[0] ?? null,
      date_of_birth: dob,
      address: json(address ?? {}),
      city,
      country_code: city === 'Dubai' ? 'AE' : 'IN',
      time_zone: city === 'Dubai' ? 'Asia/Dubai' : 'Asia/Kolkata',
      language: 'en',
      student_profile: json(profile),
      created_at: createdAt,
      updated_at: createdAt,
    };
    contacts.push(row);
    return row;
  }

  function linkContact(contact, companyConfig, unit, { owner, status, firstSeenAt, source, tags = [], custom = {} }) {
    const key = `${contact.id}:${companyConfig.company.id}`;
    const existing = links.get(key);
    if (existing) {
      if (status === 'customer') existing.status = 'customer';
      if (new Date(firstSeenAt) < new Date(existing.first_seen_at)) existing.first_seen_at = firstSeenAt;
      return existing;
    }
    const row = {
      id: randomUUID(),
      contact_id: contact.id,
      group_id: group.id,
      company_id: companyConfig.company.id,
      unit_id: unit.id,
      owner_user_id: owner?.id ?? null,
      status,
      first_seen_at: firstSeenAt,
      source: json(source),
      tags,
      custom: json(custom),
      created_by: owner?.id ?? null,
      created_at: firstSeenAt,
      updated_at: firstSeenAt,
    };
    links.set(key, row);
    return row;
  }

  /** A student who gives their parent's number: the same number on two people. */
  function parentPhone(parent) {
    const method = methods.find((m) => m.contact_id === parent.id && m.kind === 'phone');
    return { value: method.value, normalized: method.normalized };
  }

  function nextNumber(code) {
    numbers[code] = (numbers[code] ?? 1000) + 1;
    return numbers[code];
  }

  /** Stage path for a deal ending at `finalKey`, from its pipeline's stages. */
  function stagePath(stages, finalKey, { lostFrom } = {}) {
    const open = stages.filter((s) => s.category === 'open');
    const final = stages.find((s) => s.key === finalKey);
    if (final.category === 'open') return open.slice(0, open.indexOf(final) + 1);
    if (final.category === 'won') return [...open, final];
    return [...open.slice(0, (lostFrom ?? 0) + 1), final];
  }

  /** Build one deal with its contacts, history, timeline and tasks. */
  function addDeal(spec) {
    const { code, kind, unit, owner, channel, finalKey, createdAt, productLine, primary, participants, household, account, currency, custom, message, from, tags = [] } = spec;
    const companyConfig = config[code];
    const stages = companyConfig.stages[kind];
    const pipeline = companyConfig.pipelines[kind];
    const lostFrom = between(0, kind === 'b2c' ? 3 : 5);
    const path = channel === 'website_checkout' ? [stages.find((s) => s.category === 'won')] : stagePath(stages, finalKey, { lostFrom });
    const final = path[path.length - 1];
    // Every stage the deal went through had its required fields filled.
    const required = new Set(path.flatMap((stage) => stage.required_fields));
    const product = spec.product ?? (required.has('productId') ? productLine.products[0] : null);
    const valueMinor = spec.valueMinor || (required.has('valueMinor') ? (product ?? productLine.products[0]).fee : 0);
    const span = Math.max(NOW - createdAt - HOUR, HOUR);
    // Open deals entered their stage recently enough that most are still inside its SLA; closed
    // deals closed some time ago. Earlier moves are spread evenly before the last one.
    let lastMoveAt = createdAt;
    if (path.length > 1) {
      const earliest = createdAt + (path.length - 1) * 30 * MINUTE;
      const target = final.category === 'open' && final.sla_hours ? NOW - final.sla_hours * HOUR * (0.1 + random() * 1.3) : createdAt + span * (0.6 + random() * 0.4);
      lastMoveAt = Math.min(Math.max(earliest, target), NOW - MINUTE);
    }
    const moves = path.map((stage, index) => ({
      stage,
      at: index === 0 ? new Date(createdAt) : at(createdAt + ((lastMoveAt - createdAt) * index) / (path.length - 1)),
    }));
    const enteredAt = moves[moves.length - 1].at;
    const status = final.category;
    const closedAt = status === 'open' ? null : enteredAt;
    const lostReason = status === 'lost' ? pick(companyConfig.lostReasons[kind]) : null;

    const firstReplySla = !['manual', 'csv_import', 'website_checkout'].includes(channel);
    const firstReplyDue = firstReplySla ? new Date(createdAt + 30 * MINUTE) : null;
    const replied = path.length > 1 || chance(0.5) || !firstReplySla;
    const firstRepliedAt = firstReplySla && replied && owner ? at(createdAt + between(3, 95) * MINUTE) : null;

    const number = nextNumber(code);
    const original = originalMessage(channel, message, createdAt, from);
    const id = randomUUID();
    const contactName = account ? account.name : (participants.find((p) => p.role === 'student')?.contact.display_name ?? primary.display_name);
    const firstTouch = touch(channel, code, createdAt);
    const lastTouch = chance(0.15) && status === 'open' ? touch(pick(['whatsapp', 'website_form']), code, at(createdAt + span / 2)) : firstTouch;
    const deal = {
      id,
      group_id: group.id,
      company_id: companyConfig.company.id,
      unit_id: unit.id,
      number,
      ref: `${companyConfig.setup.prefix}-${number}`,
      title: `${contactName} – ${productLine?.name ?? 'Enquiry'}`,
      kind,
      pipeline_id: pipeline.id,
      stage_id: final.id,
      status,
      product_line_id: productLine?.id ?? null,
      product_id: product?.id ?? null,
      owner_user_id: owner?.id ?? null,
      value_minor: valueMinor,
      currency,
      primary_contact_id: primary?.id ?? null,
      household_id: household?.id ?? null,
      account_id: account?.id ?? null,
      channel,
      first_touch: json(firstTouch),
      last_touch: json(lastTouch),
      original_message: original ? json(original) : null,
      ai_fields: json(spec.aiFields ?? {}),
      custom: json(custom ?? {}),
      tags,
      lost_reason_id: lostReason?.id ?? null,
      lost_note: lostReason?.requires_note ? 'Shared details on the call; they decided against it for now.' : null,
      nurture: status === 'lost' && chance(0.7),
      stage_entered_at: enteredAt,
      sla_due_at: status === 'open' && final.sla_hours ? new Date(enteredAt.getTime() + final.sla_hours * HOUR) : null,
      sla_breached_at:
        status === 'open' && final.sla_hours && enteredAt.getTime() + final.sla_hours * HOUR < NOW ? new Date(enteredAt.getTime() + final.sla_hours * HOUR) : null,
      first_reply_due_at: firstReplyDue,
      first_replied_at: firstRepliedAt,
      // As if the SLA sweep had already run.
      first_reply_breached_at: status === 'open' && firstReplyDue && !firstRepliedAt && firstReplyDue.getTime() < NOW ? firstReplyDue : null,
      expected_close_on:
        status === 'open' && path.length >= 3 ? new Date(NOW + between(5, kind === 'b2b' ? 75 : 30) * DAY).toISOString().slice(0, 10) : closedAt ? closedAt.toISOString().slice(0, 10) : null,
      closed_at: closedAt,
      last_activity_at: enteredAt,
      created_by: channel === 'manual' || channel === 'csv_import' ? (owner?.id ?? null) : null,
      created_at: new Date(createdAt),
      updated_at: enteredAt,
    };
    deals.push(deal);
    for (const participant of participants) dealContacts.push({ deal_id: id, contact_id: participant.contact.id, role: participant.role, created_at: new Date(createdAt) });

    // History and timeline
    const subject = { groupId: group.id, companyId: companyConfig.company.id, unitId: unit.id, dealId: id, contactId: primary?.id ?? null, accountId: account?.id ?? null };
    timeline.push({ ...subject, kind: 'system', title: 'Lead created', meta: { action: 'deal.created', channel, ref: deal.ref }, actorType: owner && deal.created_by ? 'user' : 'system', actorUserId: deal.created_by, occurredAt: new Date(createdAt) });
    if (original) {
      timeline.push({ ...subject, kind: MESSAGE_KIND[channel] ?? 'message', channel, direction: 'inbound', title: channel === 'voice_call' ? 'Incoming call' : null, body: message, meta: { original: true }, actorType: 'contact', occurredAt: new Date(createdAt + 1000) });
    }
    if (firstRepliedAt) {
      const replyKind = REPLY_KIND[channel] ?? 'call';
      timeline.push({ ...subject, kind: replyKind, channel: replyKind === 'call' ? 'voice_call' : channel, direction: 'outbound', title: replyKind === 'call' ? 'Outgoing call' : null, body: replyKind === 'call' ? 'Spoke about goals and timelines. Shared the next steps.' : `Hi! Thanks for reaching out to ${companyConfig.company.name}. When is a good time to talk?`, meta: replyKind === 'call' ? { durationSeconds: between(90, 900), outcome: 'connected' } : {}, actorType: 'user', actorUserId: owner.id, occurredAt: firstRepliedAt });
    }
    moves.forEach((move, index) => {
      const previous = index === 0 ? null : moves[index - 1];
      history.push({
        deal_id: id,
        group_id: group.id,
        company_id: companyConfig.company.id,
        pipeline_id: pipeline.id,
        from_stage_id: previous?.stage.id ?? null,
        to_stage_id: move.stage.id,
        from_status: previous?.stage.category ?? null,
        to_status: move.stage.category,
        lost_reason_id: move.stage.category === 'lost' ? lostReason.id : null,
        moved_by_user_id: index === 0 ? deal.created_by : (owner?.id ?? null),
        seconds_in_from_stage: previous ? Math.round((move.at - previous.at) / 1000) : null,
        moved_at: move.at,
      });
      if (index > 0) {
        timeline.push({ ...subject, kind: 'stage_change', title: `Moved to ${move.stage.name}`, meta: { fromStageId: previous.stage.id, toStageId: move.stage.id, fromStage: previous.stage.name, toStage: move.stage.name, status: move.stage.category, lostReason: move.stage.category === 'lost' ? lostReason.label : undefined }, actorType: owner ? 'user' : 'system', actorUserId: owner?.id ?? null, occurredAt: move.at });
      }
    });
    if (owner && path.length > 2 && chance(0.6)) {
      timeline.push({ ...subject, kind: 'note', body: pick(kind === 'b2b' ? B2B_NOTES : NOTES), actorType: 'user', actorUserId: owner.id, occurredAt: at(moves[1].at.getTime() + between(1, 20) * HOUR) });
    }

    // Tasks: the next step for open deals (some overdue), done tasks on the way.
    if (owner && status === 'open') {
      const overdue = chance(0.3);
      const due = overdue ? NOW - between(2, 72) * HOUR : NOW + between(1, 120) * HOUR;
      const name = primary?.first_name ?? account?.name ?? 'them';
      const titles = {
        new_enquiry: `Call ${name} back`, contacted: `Book a demo for ${contactName}`, demo_booked: `Confirm the demo slot with ${name}`, demo_done: 'Send the fee proposal', fee_proposed: `Follow up with ${name} on the proposal`,
        new: `Qualify ${account?.name ?? 'the lead'}`, qualified: 'Schedule the discovery call', discovery_call: 'Prepare the product demo', product_demo: 'Set up trial accounts', trial: 'Check trial usage with the academic head', quote_sent: 'Follow up on the quote', negotiation: 'Send the revised quote',
      };
      tasks.push({
        id: randomUUID(), group_id: group.id, company_id: companyConfig.company.id, unit_id: unit.id,
        title: titles[final.key] ?? 'Follow up', notes: overdue ? 'Promised to get back by this time.' : null,
        kind: ['new_enquiry', 'contacted', 'new'].includes(final.key) ? 'call' : final.key.includes('demo') ? 'meeting' : 'follow_up',
        priority: overdue ? 'high' : pick(['normal', 'normal', 'low', 'high']), status: 'open', completed_at: null, completed_by: null,
        due_at: new Date(due), reminder_at: chance(0.5) ? new Date(due - 15 * MINUTE) : null,
        assignee_user_id: owner.id, deal_id: id, contact_id: primary?.id ?? null, account_id: account?.id ?? null,
        created_by: owner.id, created_at: enteredAt, updated_at: enteredAt,
      });
    }
    if (owner && path.length > 1) {
      const doneAt = moves[1].at;
      tasks.push({
        id: randomUUID(), group_id: group.id, company_id: companyConfig.company.id, unit_id: unit.id,
        title: kind === 'b2b' ? 'Intro call with the director' : `First call with ${primary?.first_name ?? 'the family'}`, notes: null,
        kind: 'call', priority: 'normal', status: 'done', due_at: new Date(createdAt + 2 * HOUR), reminder_at: null,
        assignee_user_id: owner.id, deal_id: id, contact_id: primary?.id ?? null, account_id: account?.id ?? null,
        created_by: owner.id, completed_at: doneAt, completed_by: owner.id, created_at: new Date(createdAt), updated_at: doneAt,
      });
    }
    return deal;
  }

  // ----- Families (B2C) -----
  const surnames = [...SURNAMES];
  const families = [];
  for (const [code, setup] of Object.entries(COMPANY_SETUP)) {
    for (let i = 0; i < setup.families; i += 1) {
      const surname = surnames[(families.length * 7) % surnames.length];
      const [city, state] = code === 'satnpaper' && i < 2 ? ['Dubai', 'Dubai'] : pick(setup.cities);
      families.push({ code, surname, city, state, index: i });
    }
  }
  // Some families are known to two companies: an elder child did SAT with SatnPaper, a younger one does JEE or boards.
  const crossCompany = new Map([[2, 'pivector'], [5, 'pivector'], [8, 'pivector'], [11, 'pivector'], [14, 'excel'], [17, 'excel'], [20, 'excel'], [44, 'excel'], [47, 'excel'], [50, 'satnpaper']]);

  const channelMix = [['whatsapp', 30], ['website_form', 15], ['voice_call', 10], ['lead_ad_instagram', 10], ['lead_ad_facebook', 7], ['partner_referral', 8], ['email', 5], ['website_checkout', 5], ['csv_import', 5], ['manual', 5]];
  const stageMix = [['new_enquiry', 18], ['contacted', 20], ['demo_booked', 15], ['demo_done', 10], ['fee_proposed', 10], ['enrolled', 14], ['lost', 13]];
  const ageByStage = { new_enquiry: [0, 3], contacted: [2, 20], demo_booked: [3, 30], demo_done: [5, 40], fee_proposed: [7, 50], enrolled: [15, 120], lost: [10, 120] };

  families.forEach((family, familyIndex) => {
    const setup = COMPANY_SETUP[family.code];
    const dubai = family.city === 'Dubai';
    const familyCreated = NOW - between(20, 140) * DAY;
    const household = { id: randomUUID(), group_id: group.id, name: `${family.surname} family`, city: family.city, created_at: new Date(familyCreated), updated_at: new Date(familyCreated) };
    households.push(household);

    const motherFirst = chance(0.6);
    const parents = [];
    const parentCount = chance(0.3) ? 2 : 1;
    for (let p = 0; p < parentCount; p += 1) {
      const isMother = p === 0 ? motherFirst : !motherFirst;
      const first = pick(isMother ? MOTHERS : FATHERS);
      const phone = dubai ? nextDubaiPhone() : nextIndianPhone();
      const parent = addContact({
        kind: 'parent', first, last: family.surname, city: family.city,
        phones: [phone], emails: chance(0.8) ? [emailFor(first, family.surname)] : [], whatsapp: chance(0.7),
        createdAt: new Date(familyCreated),
        address: chance(0.4) ? { line1: `${between(1, 240)}, ${pick(['Shanti Nagar', 'Green Park', 'Lake View Road', 'MG Road', 'Sector 21'])}`, city: family.city, state: family.state, pincode: String(between(110001, 600099)), country: dubai ? 'United Arab Emirates' : 'India' } : null,
      });
      parents.push(parent);
      members.push({ household_id: household.id, contact_id: parent.id, role: 'parent', relation: isMother ? 'Mother' : 'Father', is_primary: p === 0, created_at: new Date(familyCreated) });
    }

    const studentCount = chance(0.25) ? 2 : 1;
    const students = [];
    for (let s = 0; s < studentCount; s += 1) {
      const daughter = chance(0.5);
      const names = (daughter ? DAUGHTERS : SONS).filter((name) => !students.some((other) => other.contact.first_name === name));
      const first = pick(names);
      // Younger siblings are in a grade every company teaches.
      const grade = s === 0 ? pick(setup.studentGrades) : pick(setup.grades.filter((g) => /^\d+$/.test(g) && Number(g) <= 10));
      const numericGrade = Number.parseInt(grade, 10);
      const birthYear = 2026 - (Number.isNaN(numericGrade) ? 18 : numericGrade + 5);
      const ownPhone = OLDER_GRADES.includes(grade) && chance(0.4);
      const sharesParentPhone = !ownPhone && chance(0.2);
      const student = addContact({
        kind: 'student', first, last: family.surname, city: family.city,
        phones: ownPhone ? [dubai ? nextDubaiPhone() : nextIndianPhone()] : sharesParentPhone ? [parentPhone(parents[0])] : [],
        emails: OLDER_GRADES.includes(grade) && chance(0.5) ? [emailFor(first, family.surname)] : [],
        profile: {
          grade: Number.isNaN(numericGrade) ? (grade === 'dropper' ? 'Dropper' : 'Gap year') : grade,
          school: pick(SCHOOLS),
          board: pick(['CBSE', 'CBSE', 'ICSE', 'IB', 'IGCSE', 'State board']),
          targetExam: family.code === 'excel' && chance(0.5) ? 'NEET' : setup.profileExam,
          targetDate: `${2027 + (numericGrade < 11 ? 1 : 0)}-0${between(1, 6)}-${String(between(10, 28))}`,
        },
        dob: `${birthYear}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
        createdAt: new Date(familyCreated),
      });
      students.push({ contact: student, grade });
      members.push({ household_id: household.id, contact_id: student.id, role: 'student', relation: daughter ? 'Daughter' : 'Son', is_primary: false, created_at: new Date(familyCreated) });
    }

    // Deals: one per student at the family's company, sometimes a second (an upsell or a new enquiry
    // after a lost one), and one at a second company for the families known to two.
    const plans = students.map((student) => ({ code: family.code, student }));
    if (chance(0.7)) plans.push({ code: family.code, student: students[0], second: true });
    const other = crossCompany.get(familyIndex);
    if (other) plans.push({ code: other, student: students[students.length - 1] });

    plans.forEach((plan) => {
      const companyConfig = config[plan.code];
      const companySetup = COMPANY_SETUP[plan.code];
      const unit = unitIn(plan.code, companySetup.b2c.unit);
      const finalKey = plan.second ? weighted([['new_enquiry', 3], ['contacted', 3], ['demo_booked', 2], ['enrolled', 2]]) : weighted(stageMix);
      const channel = finalKey === 'enrolled' && chance(0.3) ? 'website_checkout' : weighted(channelMix.filter(([c]) => c !== 'website_checkout'));
      const [minAge, maxAge] = ageByStage[finalKey];
      // New enquiries are mostly from the last few hours; a few arrived minutes ago and still await a first reply.
      const createdAt =
        finalKey === 'new_enquiry'
          ? NOW - (chance(0.25) ? between(5, 25) * MINUTE : chance(0.6) ? between(30, 240) * MINUTE : between(5, 72) * HOUR)
          : NOW - between(minAge, maxAge) * DAY - between(0, 600) * MINUTE;
      const ownerEmail = pick(companySetup.b2c.owners);
      const owner = finalKey === 'new_enquiry' && chance(0.35) ? null : users.get(ownerEmail);
      const b2cLines = companyConfig.productLines.filter((l) => l.audience === 'b2c');
      const forGrade = b2cLines.filter((l) => !l.grades || l.grades.includes(plan.student.grade));
      const productLine = pick(forGrade.length ? forGrade : b2cLines);
      const product = ['fee_proposed', 'enrolled'].includes(finalKey) || chance(0.4) ? pick(productLine.products) : null;
      const usd = dubai && plan.code === 'satnpaper';
      const fee = product?.fee ?? productLine.products[0].fee;
      // USD for families abroad: paise → rupees (÷100) → dollars (÷83), rounded to $50, in cents.
      const valueMinor = finalKey === 'new_enquiry' ? 0 : usd ? Math.round(fee / 8300 / 50) * 50 * 100 : fee - (chance(0.3) ? Math.round(fee * 0.1) : 0);
      const studentLed = Boolean(plan.student.contact.primary_phone) && OLDER_GRADES.includes(plan.student.grade) && chance(0.5);
      const primary = studentLed ? plan.student.contact : parents[0];
      const participants = [
        { contact: primary, role: studentLed ? 'student' : 'parent' },
        ...(studentLed ? [{ contact: parents[0], role: 'parent' }] : [{ contact: plan.student.contact, role: 'student' }]),
      ];
      const examKey = companySetup.examFor();
      const gradeKey = companySetup.grades.includes(plan.student.grade) ? (plan.student.grade === 'dropper' || plan.student.grade === 'gap_year' ? plan.student.grade : `class_${plan.student.grade}`) : undefined;
      const custom = {
        ...(gradeKey ? { grade: gradeKey } : {}),
        target_exam: examKey,
        board: pick(['cbse', 'cbse', 'icse', 'ib', 'igcse', 'state']),
        preferred_mode: pick(['online', 'centre', 'hybrid']),
        ...(companySetup.extraFields.some((f) => f.key === 'batch_timing') ? { batch_timing: pick(['weekday_evening', 'weekend', 'weekend']) } : {}),
        ...(companySetup.extraFields.some((f) => f.key === 'target_score') ? { target_score: pick([1350, 1400, 1450, 1500, 1550]) } : {}),
      };
      const studentName = plan.student.contact.first_name;
      const child = members.find((m) => m.contact_id === plan.student.contact.id)?.relation === 'Daughter' ? 'daughter' : 'son';
      const values = {
        student: studentName,
        grade: plan.student.grade === 'dropper' ? '12 (repeating)' : plan.student.grade === 'gap_year' ? '12 (gap year)' : plan.student.grade,
        child,
        their: child === 'daughter' ? 'her' : 'his',
        city: family.city,
        line: productLine.name.toLowerCase(),
        parent: parents[0].first_name,
        when: pick(['after 6 pm', 'tomorrow morning', 'on Saturday']),
      };
      const template =
        channel === 'voice_call' ? CALL_SUMMARY
        : channel.startsWith('lead_ad') ? LEAD_FORM
        : studentLed ? pick(STUDENT_MESSAGES)
        : pick(B2C_MESSAGES[productLine.key] ?? STUDENT_MESSAGES);
      const message = fill(template, values);
      const from = { name: primary.display_name, phone: primary.primary_phone ?? undefined, email: primary.primary_email ?? undefined };
      const aiFields = ['whatsapp', 'website_form', 'lead_ad_instagram'].includes(channel) && chance(0.5)
        ? { extracted: { parentName: parents[0].display_name, studentName: plan.student.contact.display_name, grade: plan.student.grade, exam: companySetup.exams.find((e) => e.value === examKey)?.label, intent: pick(['demo', 'fees', 'batch_timings']), language: 'en', city: family.city }, confidence: Number((0.72 + random() * 0.25).toFixed(2)), model: 'mock-intake', extractedAt: new Date(createdAt + 2 * MINUTE).toISOString() }
        : undefined;

      addDeal({
        code: plan.code, kind: 'b2c', unit, owner, channel, finalKey, createdAt, productLine, product, primary, participants, household,
        valueMinor, currency: usd ? 'USD' : 'INR', custom, message, from, aiFields,
        tags: [...(familyIndex % 9 === 0 ? ['scholarship'] : []), ...(students.length > 1 ? ['siblings'] : []), ...(channel === 'partner_referral' ? ['partner'] : [])],
      });

      const won = deals[deals.length - 1].status === 'won';
      const firstSeen = new Date(createdAt);
      const source = touch(channel, plan.code, createdAt);
      for (const person of [...parents, ...students.map((s) => s.contact)]) {
        linkContact(person, companyConfig, unit, {
          owner: owner ?? users.get(ownerEmail),
          status: won ? 'customer' : 'lead',
          firstSeenAt: firstSeen,
          source,
          tags: familyIndex % 9 === 0 ? ['scholarship'] : [],
          custom: person.kind === 'parent' ? { how_heard: pick(['instagram', 'youtube', 'friend_family', 'school_seminar', 'google']) } : {},
        });
      }

      // Consent: opted in on WhatsApp or the website form; a few later opted out of marketing.
      if (['whatsapp', 'website_form', 'website_checkout'].includes(channel)) {
        const consentChannel = channel === 'whatsapp' ? 'whatsapp' : 'email';
        consents.push({ id: randomUUID(), group_id: group.id, contact_id: primary.id, company_id: companyConfig.company.id, channel: consentChannel, purpose: 'marketing', status: 'granted', source: channel === 'whatsapp' ? 'whatsapp' : channel === 'website_checkout' ? 'checkout' : 'web_form', evidence: json(channel === 'whatsapp' ? { note: 'Started the conversation on WhatsApp and agreed to updates' } : { formUrl: `https://${companySetup.domain}/enquire`, ip: `203.0.113.${between(1, 254)}`, wording: 'Send me course updates and offers' }), captured_at: firstSeen, created_at: firstSeen });
        if (chance(0.1)) {
          const later = at(createdAt + between(3, 20) * DAY);
          consents.push({ id: randomUUID(), group_id: group.id, contact_id: primary.id, company_id: companyConfig.company.id, channel: consentChannel, purpose: 'marketing', status: 'withdrawn', source: consentChannel === 'whatsapp' ? 'whatsapp' : 'unsubscribe_link', evidence: json(consentChannel === 'whatsapp' ? { message: 'STOP' } : { link: 'unsubscribe' }), captured_at: later, created_at: later });
        }
      }
    });
  });

  // ----- Institutes (B2B) -----
  INSTITUTES.forEach((spec, index) => {
    const createdAt = NOW - between(30, 160) * DAY;
    const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const domain = spec.kind === 'independent_mentor' ? null : `${slug}.example`;
    const account = {
      id: randomUUID(), group_id: group.id, kind: spec.kind, name: spec.name, name_normalized: normalizeName(spec.name),
      legal_name: spec.kind === 'independent_mentor' ? null : `${spec.name} Private Limited`.replace('School Private Limited', 'School Trust'),
      website: domain ? `https://www.${domain}` : null, domain,
      primary_phone: nextIndianPhone().normalized, primary_email: domain ? `office@${domain}` : `mentor${index}@example.com`,
      city: spec.city[0], state: spec.city[1], country_code: 'IN', address: json({ city: spec.city[0], state: spec.city[1], country: 'India' }),
      branch_count: spec.branches, student_count: spec.students, current_software: spec.software,
      profile: json({ boards: [pick(['CBSE', 'ICSE', 'State board'])], exams: spec.kind === 'school' ? ['Boards'] : [pick(['JEE', 'NEET', 'SAT'])] }),
      created_at: new Date(createdAt), updated_at: new Date(createdAt),
    };
    accounts.push(account);

    const staffCount = spec.kind === 'independent_mentor' ? 1 : between(2, 3);
    const staff = [];
    for (let s = 0; s < staffCount; s += 1) {
      const isWoman = chance(0.45);
      const first = pick(isWoman ? MOTHERS : FATHERS);
      const last = spec.kind === 'independent_mentor' ? spec.name.split(' ')[1] : pick(SURNAMES);
      const personFirst = spec.kind === 'independent_mentor' ? spec.name.split(' ')[0] : first;
      const email = domain ? `${personFirst.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@${domain}` : emailFor(personFirst, last);
      const person = addContact({ kind: 'staff', first: personFirst, last, city: spec.city[0], phones: [nextIndianPhone()], emails: [email], whatsapp: chance(0.6), createdAt: new Date(createdAt) });
      const role = spec.kind === 'independent_mentor' ? STAFF_ROLES[0] : STAFF_ROLES[s];
      staff.push({ contact: person, ...role });
      accountContacts.push({ account_id: account.id, contact_id: person.id, title: spec.kind === 'independent_mentor' ? 'Founder and mentor' : role.title, role: role.role, is_primary: role.primary === true, created_at: new Date(createdAt), updated_at: new Date(createdAt) });
    }

    spec.companies.forEach((code) => {
      const companyConfig = config[code];
      const companySetup = COMPANY_SETUP[code];
      const unit = unitIn(code, companySetup.b2b.unit);
      const owner = users.get(pick(companySetup.b2b.owners));
      const dealCount = spec.students > 1500 && code === 'satnpaper' ? 2 : chance(0.5) ? 2 : 1;
      let won = false;
      let firstSeen = null;
      for (let d = 0; d < dealCount; d += 1) {
        const finalKey = weighted([['new', 2], ['qualified', 3], ['discovery_call', 2], ['product_demo', 2], ['trial', 2], ['quote_sent', 2], ['negotiation', 1], ['contract_signed', 2], ['lost', 2]]);
        const channel = weighted([['website_form', 4], ['email', 3], ['voice_call', 2], ['partner_referral', 2], ['manual', 2], ['lead_ad_facebook', 1], ['csv_import', 1]]);
        const createdAt = finalKey === 'new' ? NOW - between(0, 4) * DAY - between(30, 600) * MINUTE : NOW - between(8, 120) * DAY;
        firstSeen = firstSeen && firstSeen < createdAt ? firstSeen : createdAt;
        const productLine = companyConfig.productLines.filter((l) => l.audience === 'b2b')[d % 2];
        const product = ['quote_sent', 'negotiation', 'contract_signed'].includes(finalKey) || chance(0.3) ? productLine.products[0] : null;
        const fee = (product ?? productLine.products[0]).fee;
        const billing = (product ?? productLine.products[0]).billing;
        const perStudent = billing === 'per_student_year';
        const perBranch = billing === 'per_branch_year';
        const valueMinor = finalKey === 'new' ? 0 : perStudent ? fee * spec.students : perBranch ? fee * spec.branches : fee;
        const decisionMaker = staff[0];
        const message = pick(B2B_MESSAGES).replace('{students}', String(spec.students)).replace('{branches}', String(spec.branches)).replace('{software}', spec.software.toLowerCase());
        addDeal({
          code, kind: 'b2b', unit, owner, channel, finalKey, createdAt, productLine, product,
          primary: decisionMaker.contact,
          participants: staff.map((member) => ({ contact: member.contact, role: member.role === 'decision_maker' ? 'decision_maker' : 'influencer' })),
          account, valueMinor, currency: 'INR', message,
          from: { name: decisionMaker.contact.display_name, email: decisionMaker.contact.primary_email },
          custom: { student_count: spec.students, branch_count: spec.branches, current_software: spec.software, decision_timeline: pick(['this_month', 'this_quarter', 'next_quarter', 'later']), budget_band: pick(['under_1l', 'l1_5', 'l5_15', 'over_15l']) },
          tags: spec.students > 2000 ? ['enterprise'] : [],
        });
        if (deals[deals.length - 1].status === 'won') won = true;
      }
      const firstSeenAt = new Date(firstSeen);
      const source = touch('website_form', code, firstSeen);
      accountLinks.push({ id: randomUUID(), account_id: account.id, group_id: group.id, company_id: companyConfig.company.id, unit_id: unit.id, owner_user_id: owner.id, status: won ? 'customer' : 'lead', first_seen_at: firstSeenAt, source: json(source), tags: spec.students > 2000 ? ['enterprise'] : [], custom: json(code === 'satnpaper' && chance(0.5) ? { software_renewal_on: new Date(NOW + between(30, 200) * DAY).toISOString().slice(0, 10) } : {}), created_by: owner.id, created_at: firstSeenAt, updated_at: firstSeenAt });
      for (const member of staff) linkContact(member.contact, companyConfig, unit, { owner, status: won ? 'customer' : 'lead', firstSeenAt, source });
    });
  });

  // People were added when a company first heard of them.
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  for (const link of links.values()) {
    const contact = contactsById.get(link.contact_id);
    if (new Date(link.first_seen_at) < new Date(contact.created_at)) contact.created_at = new Date(link.first_seen_at);
  }
  for (const method of methods) method.created_at = method.updated_at = contactsById.get(method.contact_id).created_at;
  for (const contact of contacts) if (contact.updated_at < contact.created_at) contact.updated_at = contact.created_at;

  // Last activity follows the newest timeline entry of each deal.
  const lastActivity = new Map();
  for (const entry of timeline) {
    if (!entry.dealId) continue;
    const time = new Date(entry.occurredAt).getTime();
    if (time > (lastActivity.get(entry.dealId) ?? 0)) lastActivity.set(entry.dealId, time);
  }
  for (const deal of deals) {
    const latest = lastActivity.get(deal.id);
    if (latest) deal.last_activity_at = new Date(Math.max(latest, deal.last_activity_at.getTime()));
    if (deal.updated_at < deal.last_activity_at) deal.updated_at = deal.last_activity_at;
  }

  // A few people opted out of a number altogether.
  const optedOut = consents.filter((c) => c.status === 'withdrawn' && c.channel === 'whatsapp').map((c) => c.contact_id);
  for (const method of methods) if (method.kind === 'whatsapp' && optedOut.includes(method.contact_id)) method.opted_out_at = new Date(NOW - 2 * DAY);

  // ----- Write everything -----
  await insertChunks(knex, 'contacts', contacts);
  await insertChunks(knex, 'contact_methods', methods);
  await insertChunks(knex, 'contact_companies', [...links.values()]);
  await insertChunks(knex, 'households', households);
  await insertChunks(knex, 'household_members', members);
  await insertChunks(knex, 'accounts', accounts);
  await insertChunks(knex, 'account_companies', accountLinks);
  await insertChunks(knex, 'account_contacts', accountContacts);
  await insertChunks(knex, 'deals', deals);
  await insertChunks(knex, 'deal_contacts', dealContacts);
  await insertChunks(knex, 'deal_stage_history', history);
  await insertTimelineEvents(knex, timeline);
  await insertChunks(knex, 'tasks', tasks);
  await insertChunks(knex, 'consents', consents);
  for (const [code, value] of Object.entries(numbers)) {
    await knex('crm_sequences')
      .insert({ company_id: config[code].company.id, name: 'deal', value })
      .onConflict(['company_id', 'name'])
      .merge();
  }
  // Saved views on the Leads list (filters use the GET /deals query keys, contract §9.7).
  const satnpaper = config.satnpaper.company;
  const views = [
    { unit: satnpaper, owner: 'admin.satnpaper@phoenix.test', visibility: 'shared', name: 'New WhatsApp enquiries', filters: { status: ['open'], channel: ['whatsapp'], stageId: [config.satnpaper.stages.b2c[0].id] }, sort: '-createdAt' },
    { unit: satnpaper, owner: 'admin.satnpaper@phoenix.test', visibility: 'shared', name: 'Past the stage SLA', filters: { status: ['open'], slaBreached: true }, sort: 'slaDueAt' },
    { unit: satnpaper, owner: 'admin.satnpaper@phoenix.test', visibility: 'shared', name: 'Waiting for a first reply', filters: { status: ['open'], firstReplyOverdue: true }, sort: 'createdAt' },
    { unit: unitIn('satnpaper', COMPANY_SETUP.satnpaper.b2c.unit), owner: 'ritika@phoenix.test', visibility: 'personal', name: 'My booked demos', filters: { owner: ['me'], status: ['open'], stageId: [config.satnpaper.stages.b2c[2].id] }, sort: 'stageEnteredAt' },
  ];
  await insertChunks(
    knex,
    'saved_views',
    views
      .filter((view) => view.unit && users.get(view.owner))
      .map((view, position) => ({
        id: randomUUID(),
        group_id: group.id,
        company_id: satnpaper.id,
        unit_id: view.unit.id,
        owner_user_id: users.get(view.owner).id,
        entity: 'deals',
        name: view.name,
        visibility: view.visibility,
        filters: json(view.filters),
        sort: view.sort,
        columns: ['ref', 'title', 'stage', 'owner', 'channel', 'value', 'updatedAt'],
        position,
      })),
  );

  const indexed = await reindexSearch(knex, { groupId: group.id });

  const won = deals.filter((d) => d.status === 'won').length;
  console.log(
    `Seeded the CRM: ${productLineRows.length} product lines, ${productRows.length} products, ${pipelineRows.length} pipelines, ` +
      `${households.length} families, ${accounts.length} institutes, ${contacts.length} contacts, ${deals.length} deals (${won} won), ` +
      `${timeline.length} timeline entries, ${tasks.length} tasks, ${consents.length} consent records; search: ${Object.values(indexed).reduce((a, b) => a + b, 0)} documents.`,
  );
}

/** Excel had no company admin in the foundation seed; its leads need an owner who works there. */
async function ensureExcelAdmin(knex, excel) {
  const email = 'admin.excel@phoenix.test';
  const existing = await knex('users').where({ email }).first();
  if (existing) return existing;
  const role = await knex('roles').whereNull('group_id').where({ key: 'company_admin' }).first();
  if (!excel || !role) return null;
  const [user] = await knex('users')
    .insert({ email, name: 'Sameer Kulkarni', status: 'active', password_hash: await hashPassword(env.SEED_PASSWORD) })
    .returning(['id', 'email', 'name']);
  await knex('role_assignments').insert({ user_id: user.id, role_id: role.id, org_unit_id: excel.id });
  console.log(`Added ${email} (company admin, Excel).`);
  return user;
}
