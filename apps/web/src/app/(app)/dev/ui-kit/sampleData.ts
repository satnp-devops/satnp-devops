// Sample records for the UI kit gallery. Nothing here talks to the API: `fetchLeadPage` fakes a
// server that filters, sorts and pages, so the table runs through a real useInfiniteQuery.

import type { SavedView, SortState, StageBubble } from '@/components/crm';
import type { ChannelKey } from '@/lib/crm/format';
import type { Page } from '@/lib/types';

export const STAGES: StageBubble[] = [
  { id: 'new', name: 'New enquiry' },
  { id: 'contacted', name: 'Contacted' },
  { id: 'demo_booked', name: 'Demo booked' },
  { id: 'demo_done', name: 'Demo done' },
  { id: 'proposal', name: 'Fee proposal' },
  { id: 'enrolled', name: 'Enrolled', outcome: 'won' },
  { id: 'lost', name: 'Lost', outcome: 'lost' },
];

export const OWNERS = [
  { id: 'u-ritika', name: 'Ritika Sharma' },
  { id: 'u-kabir', name: 'Kabir Anand' },
  { id: 'u-dev', name: 'Dev Khanna' },
  { id: 'u-farah', name: 'Farah Siddiqui' },
  { id: 'u-meenal', name: 'Meenal Joshi' },
];

export interface SampleLead {
  id: string;
  ref: string;
  name: string;
  student: string;
  program: string;
  channel: ChannelKey;
  stageId: string;
  /** For lost leads: the furthest open stage they reached. */
  reachedId: string | null;
  ownerId: string | null;
  valueMinor: number;
  currency: string;
  createdAt: string;
  lastActivityAt: string;
  replyDueAt: string;
  repliedAt: string | null;
  isNew: boolean;
  phone: string;
  email: string;
  city: string;
  timeZone: string;
  message: string;
  captured: { grade: string; exam: string; targetDate: string; intent: string; language: string };
}

const PARENTS = [
  'Aarav Mehta', 'Priya Nair', 'Rohan Gupta', 'Ananya Iyer', 'Vikram Singh', 'Sneha Kulkarni', 'Arjun Reddy',
  'Kavya Menon', 'Ishaan Chopra', 'Meera Pillai', 'Aditya Rao', 'Diya Banerjee', 'Kabir Malhotra', 'Sara Thomas',
  'Nikhil Joshi', 'Pooja Desai', 'Rahul Verma', 'Tara Krishnan', 'Yash Agarwal', 'Zoya Khan', 'Manish Patel',
  'Leela Fernandes', 'Siddharth Bose', 'Nandini Shah', 'Varun Saxena', 'Riya Kapoor', 'Harsh Vardhan', 'Aisha Qureshi',
  'Dhruv Bhatt', 'Neha Sinha', 'Omkar Pawar', 'Shreya Ghosh', 'Kunal Mishra', 'Isha Arora', 'Pranav Hegde',
  'Tanvi Jain', 'Gaurav Sethi', 'Mira Dutta', 'Aniket Shinde', 'Ritu Bajaj', 'Samir Kohli', 'Anjali Murthy',
];
const STUDENTS = ['Riya', 'Aditi', 'Vihaan', 'Anika', 'Reyansh', 'Myra', 'Advik', 'Kiara', 'Ayaan', 'Saanvi', 'Arnav', 'Navya'];
const PROGRAMS = ['SAT 1:1 mentorship', 'SAT group batch', 'SAT crash course', 'Digital SAT test series', 'AP Calculus prep', 'Counselling plan'];
const CHANNELS: ChannelKey[] = [
  'whatsapp', 'website_form', 'lead_ad_instagram', 'whatsapp', 'voice_call', 'email', 'website_checkout',
  'lead_ad_facebook', 'partner_referral', 'whatsapp', 'csv_import', 'manual',
];
const CITIES: Array<[string, string]> = [
  ['Pune', 'Asia/Kolkata'], ['Mumbai', 'Asia/Kolkata'], ['Bengaluru', 'Asia/Kolkata'], ['Dubai', 'Asia/Dubai'],
  ['Delhi', 'Asia/Kolkata'], ['New Jersey', 'America/New_York'], ['Hyderabad', 'Asia/Kolkata'], ['Singapore', 'Asia/Singapore'],
];
const FEES = [4500000, 12500000, 8500000, 2500000, 6500000, 18000000, 9900000, 3200000];
const MESSAGES = [
  'Hi, my daughter is in grade 11 and wants to take the SAT in March. Do you have weekend batches? Please share the fees.',
  'Looking for 1:1 SAT coaching for my son. He scored 1310 in the practice test and is aiming for 1500+.',
  'Saw your Instagram ad. Can we book a free demo class this Saturday?',
  'Interested in the Digital SAT test series. Is there a discount for siblings?',
  'Please call me after 6 pm. We are in New Jersey and need classes in our evening time.',
];
const OPEN_STAGES = ['new', 'new', 'contacted', 'demo_booked', 'demo_done', 'proposal', 'contacted', 'new'];

const MINUTE = 60_000;
const BASE = Date.now();

export const LEADS: SampleLead[] = PARENTS.map((name, index) => {
  const created = BASE - (index * 53 + 7) * MINUTE;
  const [city, timeZone] = CITIES[index % CITIES.length] ?? ['Pune', 'Asia/Kolkata'];
  const outcome = index % 11 === 5 ? 'enrolled' : index % 13 === 7 ? 'lost' : null;
  const stageId = outcome ?? OPEN_STAGES[index % OPEN_STAGES.length] ?? 'new';
  const first = name.split(' ')[0]?.toLowerCase() ?? 'parent';
  const last = name.split(' ')[1]?.toLowerCase() ?? 'family';
  const replied = stageId !== 'new' || index % 4 === 3;
  return {
    id: `0b6c${String(1000 + index)}-5d1e-4c3a-9f2b-${String(100000000000 + index * 7919).slice(0, 12)}`,
    ref: `LD-${24800 + index * 7}`,
    name,
    student: `${STUDENTS[index % STUDENTS.length] ?? 'Riya'} ${name.split(' ')[1] ?? ''}`.trim(),
    program: PROGRAMS[index % PROGRAMS.length] ?? 'SAT group batch',
    channel: CHANNELS[index % CHANNELS.length] ?? 'whatsapp',
    stageId,
    reachedId: stageId === 'lost' ? 'demo_done' : null,
    ownerId: index % 6 === 4 ? null : (OWNERS[index % 3]?.id ?? null),
    valueMinor: FEES[index % FEES.length] ?? 4500000,
    currency: index % 9 === 4 ? 'USD' : 'INR',
    createdAt: new Date(created).toISOString(),
    lastActivityAt: new Date(created + ((index * 37) % 50) * MINUTE).toISOString(),
    replyDueAt: new Date(created + 120 * MINUTE).toISOString(),
    repliedAt: replied ? new Date(created + (index % 5 === 0 ? 150 : 35) * MINUTE).toISOString() : null,
    isNew: index < 4 || index % 10 === 6,
    phone: `+91 9${String(8765 + index).padStart(4, '0')} ${String(43210 + index * 11).slice(0, 5)}`,
    email: `${first}.${last}@gmail.com`,
    city,
    timeZone,
    message: MESSAGES[index % MESSAGES.length] ?? '',
    captured: {
      grade: index % 3 === 0 ? 'Grade 11' : index % 3 === 1 ? 'Grade 12' : 'Grade 10',
      exam: index % 4 === 3 ? 'AP Calculus' : 'Digital SAT',
      targetDate: index % 2 === 0 ? 'March 2027' : 'May 2027',
      intent: index % 5 === 2 ? 'Book a demo' : 'Fees and batches',
      language: index % 6 === 1 ? 'Hindi' : 'English',
    },
  };
});

export const ownerOf = (id: string | null) => OWNERS.find((owner) => owner.id === id) ?? null;

export const CHANNEL_COUNTS = LEADS.reduce<Record<string, number>>((counts, lead) => {
  counts[lead.channel] = (counts[lead.channel] ?? 0) + 1;
  return counts;
}, {});

export interface LeadQuery {
  q: string;
  channels: readonly string[];
  overdueOnly: boolean;
  ownerId: string | null;
  sort: SortState;
}

const SORTERS: Record<string, (lead: SampleLead) => string | number> = {
  name: (lead) => lead.name.toLowerCase(),
  value: (lead) => lead.valueMinor,
  created_at: (lead) => lead.createdAt,
  last_activity_at: (lead) => lead.lastActivityAt,
  reply_due_at: (lead) => lead.replyDueAt,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pretend GET /leads: filters, sorts, then returns the page after `cursor` (opaque to callers). */
export async function fetchLeadPage(query: LeadQuery, cursor: string | undefined, limit = 12): Promise<Page<SampleLead>> {
  await wait(cursor ? 600 : 450);
  const needle = query.q.toLowerCase();
  const now = Date.now();
  const sorter = SORTERS[query.sort.key] ?? SORTERS.created_at;
  const matching = LEADS.filter(
    (lead) =>
      (!needle || `${lead.name} ${lead.student} ${lead.ref} ${lead.email}`.toLowerCase().includes(needle)) &&
      (query.channels.length === 0 || query.channels.includes(lead.channel)) &&
      (!query.ownerId || lead.ownerId === query.ownerId) &&
      (!query.overdueOnly || (lead.repliedAt === null && Date.parse(lead.replyDueAt) < now)),
  ).sort((a, b) => {
    const left = sorter ? sorter(a) : 0;
    const right = sorter ? sorter(b) : 0;
    const order = left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
    return query.sort.direction === 'asc' ? order : -order;
  });
  const start = cursor ? Number(atob(cursor)) : 0;
  const data = matching.slice(start, start + limit);
  const next = start + limit;
  return { data, nextCursor: next < matching.length ? btoa(String(next)) : null };
}

export const INITIAL_VIEWS: SavedView[] = [
  { id: 'all', name: 'All leads', shared: true, builtIn: true },
  { id: 'mine', name: 'My leads', shared: false, builtIn: true },
  { id: 'v-hot', name: 'Hot SAT leads', shared: false, canEdit: true },
  { id: 'v-nj', name: 'US time zone callbacks', shared: false, canEdit: true },
  { id: 'v-web', name: 'Website enquiries this week', shared: true, canEdit: true },
  { id: 'v-partner', name: 'Partner referrals', shared: true, canEdit: false },
];

export interface SampleDeal {
  id: string;
  title: string;
  program: string;
  stageId: string;
  valueMinor: number;
  ownerId: string;
  channel: ChannelKey;
  dueAt: string;
  isNew: boolean;
}

export const DEALS: SampleDeal[] = LEADS.slice(0, 18).map((lead, index) => ({
  id: `deal-${index}`,
  title: lead.name,
  program: lead.program,
  stageId: ['new', 'contacted', 'demo_booked', 'demo_done', 'proposal', 'enrolled'][index % 6] ?? 'new',
  valueMinor: lead.valueMinor,
  ownerId: OWNERS[index % OWNERS.length]?.id ?? 'u-ritika',
  channel: lead.channel,
  dueAt: new Date(BASE + ((index % 5) - 2) * 75 * MINUTE).toISOString(),
  isNew: index % 7 === 0,
}));
