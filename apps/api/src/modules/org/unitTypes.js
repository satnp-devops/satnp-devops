import { z } from 'zod';
import { webUrlSchema } from '../../lib/schemas.js';

// Levels of the organisation. Add a level (zone, department, ...) by adding an entry here
// or from another module's `unitTypes`. No database change is needed: units store their
// type as text and type-specific details in a validated JSON profile.
//
// `fields` tells the web app how to render the profile form, so new levels and new
// fields appear in the UI without frontend changes.

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE = /^[1-9][0-9]{5}$/;

const text = (max = 200) => z.string().max(max);
const email = z.email('Enter a valid email address');
const url = webUrlSchema;
const phone = z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2840D8');

const address = z
  .strictObject({
    line1: text(),
    line2: text(),
    city: text(80),
    state: text(80),
    pincode: z.string().regex(PINCODE, 'Enter a 6-digit PIN code'),
    country: text(80),
  })
  .partial();

const addressFields = [
  { key: 'address.line1', label: 'Address line 1', input: 'text' },
  { key: 'address.line2', label: 'Address line 2', input: 'text' },
  { key: 'address.city', label: 'City', input: 'text' },
  { key: 'address.state', label: 'State', input: 'text' },
  { key: 'address.pincode', label: 'PIN code', input: 'text', placeholder: '411001' },
  { key: 'address.country', label: 'Country', input: 'text', placeholder: 'India' },
];

const TEAM_FUNCTIONS = [
  { value: 'admissions', label: 'Admissions (families)' },
  { value: 'b2b_sales', label: 'Software sales (institutes)' },
  { value: 'customer_success', label: 'Customer success' },
  { value: 'finance', label: 'Finance' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'operations', label: 'Operations' },
  { value: 'support', label: 'Support' },
];

export const unitTypes = [
  {
    key: 'group',
    label: 'Group',
    pluralLabel: 'Groups',
    parents: [],
    profile: z.strictObject({ legalName: text(), website: url, description: text(500) }).partial(),
    fields: [
      { key: 'legalName', label: 'Legal name', input: 'text' },
      { key: 'website', label: 'Website', input: 'url', placeholder: 'https://' },
      { key: 'description', label: 'Description', input: 'textarea' },
    ],
  },
  {
    key: 'company',
    label: 'Company',
    pluralLabel: 'Companies',
    parents: ['group'],
    profile: z
      .strictObject({
        legalName: text(),
        brandName: text(120),
        businessLines: z.array(z.enum(['b2c', 'b2b'])).max(2),
        gstin: z.string().regex(GSTIN, 'Enter a valid 15-character GSTIN'),
        pan: z.string().regex(PAN, 'Enter a valid PAN'),
        email,
        phone,
        website: url,
        brandColor: hexColour,
        logoUrl: url,
        address,
      })
      .partial(),
    fields: [
      { key: 'brandName', label: 'Brand name', input: 'text' },
      { key: 'legalName', label: 'Legal name', input: 'text', help: 'As registered, used on invoices' },
      {
        key: 'businessLines',
        label: 'Sells to',
        input: 'multiselect',
        options: [
          { value: 'b2c', label: 'Families and students' },
          { value: 'b2b', label: 'Institutes and mentors' },
        ],
      },
      { key: 'gstin', label: 'GSTIN', input: 'text', placeholder: '27ABCDE1234F1Z5' },
      { key: 'pan', label: 'PAN', input: 'text', placeholder: 'ABCDE1234F' },
      { key: 'email', label: 'Email', input: 'email' },
      { key: 'phone', label: 'Phone', input: 'tel' },
      { key: 'website', label: 'Website', input: 'url', placeholder: 'https://' },
      { key: 'brandColor', label: 'Brand colour', input: 'color', help: 'Used on booking pages, forms and portals' },
      { key: 'logoUrl', label: 'Logo URL', input: 'url' },
      ...addressFields,
    ],
  },
  {
    key: 'region',
    label: 'Region',
    pluralLabel: 'Regions',
    parents: ['company', 'region'],
    profile: z.strictObject({ description: text(500) }).partial(),
    fields: [{ key: 'description', label: 'Description', input: 'textarea' }],
  },
  {
    key: 'branch',
    label: 'Branch or centre',
    pluralLabel: 'Branches and centres',
    parents: ['company', 'region'],
    profile: z
      .strictObject({ mode: z.enum(['in_person', 'online', 'hybrid']), email, phone, address })
      .partial(),
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        input: 'select',
        options: [
          { value: 'in_person', label: 'In person' },
          { value: 'online', label: 'Online' },
          { value: 'hybrid', label: 'Hybrid' },
        ],
      },
      { key: 'email', label: 'Email', input: 'email' },
      { key: 'phone', label: 'Phone', input: 'tel' },
      ...addressFields,
    ],
  },
  {
    key: 'team',
    label: 'Team',
    pluralLabel: 'Teams',
    parents: ['company', 'region', 'branch', 'team'],
    profile: z
      .strictObject({
        function: z.enum(TEAM_FUNCTIONS.map((f) => f.value)),
        description: text(500),
      })
      .partial(),
    fields: [
      { key: 'function', label: 'Function', input: 'select', options: TEAM_FUNCTIONS },
      { key: 'description', label: 'Description', input: 'textarea' },
    ],
  },
];
