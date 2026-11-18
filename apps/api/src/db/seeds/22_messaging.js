import { templateVariables, validateTemplate } from '../../core/messaging/templates.js';

// Messaging demo data (docs/platform/MESSAGING.md): message templates for every company, in the
// states the Settings › Templates screen shows. The WhatsApp names match the mock number's
// approved templates (integrations/framework/mocks/messaging.js), so the sandbox outbox reads
// "Template booking_link (en)". Skipped when the group already has templates.

const GROUP_CODE = 'phoenix';
const COMPANY_CODES = ['satnpaper', 'pi-vector', 'excel'];

const SAMPLES = {
  first_name: 'Priya',
  contact_name: 'Priya Sharma',
  owner_name: 'Ritika Rao',
  booking_link: 'https://book.example.com/demo/7KQ2',
  demo_time: 'Sat 14 Nov, 5:00 pm IST',
  amount: '₹12,500',
  program: 'SAT Group Batch',
  due_date: '20 Nov',
  payment_link: 'https://pay.example.com/i/AX93',
  code: '482913',
  booking_code: '7KQ2',
};

/** Template content per company (company_name is filled at send time). */
const TEMPLATES = (company) => [
  {
    channel: 'whatsapp',
    name: 'booking_link',
    language: 'en',
    category: 'utility',
    description: 'One-click booking link after an enquiry',
    header: { type: 'text', text: 'Book your free demo' },
    body: 'Hi {{first_name}}, thank you for your interest in {{company_name}}. Pick a time for your free demo here: {{booking_link}} and we will see you there.',
    footer: `${company.name} admissions`,
    buttons: [
      { type: 'url', text: 'Choose a slot', url: 'https://book.example.com/demo/{{booking_code}}' },
      { type: 'quick_reply', text: 'Call me instead' },
    ],
    status: 'approved',
  },
  {
    channel: 'whatsapp',
    name: 'demo_reminder',
    language: 'en',
    category: 'utility',
    description: 'Sent 24 hours and 1 hour before a demo',
    body: 'Hi {{first_name}}, a reminder that your demo with {{owner_name}} is on {{demo_time}}. Reply here if you need to reschedule.',
    buttons: [{ type: 'quick_reply', text: 'I will be there' }, { type: 'quick_reply', text: 'Reschedule' }],
    status: 'approved',
  },
  {
    channel: 'whatsapp',
    name: 'payment_reminder',
    language: 'en',
    category: 'utility',
    description: 'Instalment due reminder',
    body: 'Hi {{first_name}}, your instalment of {{amount}} for {{program}} is due on {{due_date}}. You can pay securely here: {{payment_link}} Thank you!',
    status: 'approved',
  },
  {
    channel: 'whatsapp',
    name: 'welcome_family',
    language: 'en',
    category: 'marketing',
    description: 'Welcome series, first message (needs marketing consent)',
    body: 'Welcome to the {{company_name}} family, {{first_name}}! We will share study tips, scholarship news and new batches here. Reply STOP to opt out.',
    status: 'approved',
  },
  {
    channel: 'whatsapp',
    name: 'welcome_family',
    language: 'hi',
    category: 'marketing',
    description: 'Welcome series in Hindi',
    body: 'नमस्ते {{first_name}}, {{company_name}} परिवार में आपका स्वागत है! हम यहाँ पढ़ाई के टिप्स और नए बैच की जानकारी भेजेंगे। रोकने के लिए STOP लिखें।',
    status: 'draft',
  },
  {
    channel: 'whatsapp',
    name: 'fee_offer',
    language: 'en',
    category: 'marketing',
    description: 'Early-bird fee offer',
    body: 'Hi {{first_name}}, early-bird fees for the next {{program}} batch close on {{due_date}}. Reply YES and we will call you with the details.',
    status: 'rejected',
    rejectionReason: 'The provider rejected it: the sample values did not match the message',
  },
  {
    channel: 'email',
    name: 'booking_link_email',
    language: 'en',
    category: 'utility',
    description: 'Booking link by email',
    subject: 'Book your free {{company_name}} demo, {{first_name}}',
    body: 'Hi {{first_name}},\n\nThank you for your enquiry. You can pick a time for your free demo here:\n{{booking_link}}\n\nIf none of the times suit you, just reply to this email.\n\nWarm regards,\n{{owner_name}}\n{{company_name}}',
    status: 'approved',
  },
  {
    channel: 'email',
    name: 'demo_followup',
    language: 'en',
    category: 'utility',
    description: 'After the demo',
    subject: 'Thank you for attending, {{first_name}}',
    body: 'Hi {{first_name}},\n\nIt was lovely to meet you at the demo. As promised, here is the programme we discussed: {{program}}.\n\nReply with any questions and I will get back to you the same day.\n\n{{owner_name}}\n{{company_name}}',
    status: 'approved',
  },
  {
    channel: 'sms',
    name: 'demo_reminder_sms',
    language: 'en',
    category: 'utility',
    description: 'DLT-registered demo reminder',
    body: 'Reminder: your {{company_name}} demo is on {{demo_time}}. Reply to reschedule.',
    providerTemplateId: `1107${company.code.length}00000000${company.code.length + 1}`,
    status: 'approved',
  },
  {
    channel: 'sms',
    name: 'login_code',
    language: 'en',
    category: 'authentication',
    description: 'Parent portal sign-in code',
    body: '{{code}} is your {{company_name}} verification code. It expires in 10 minutes. Do not share it.',
    status: 'approved',
  },
];

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Messaging demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  if (await knex('message_templates').where({ group_id: group.id }).first('id')) {
    console.log('Messaging demo data is already there.');
    return;
  }
  const companies = await knex('org_units').where({ root_id: group.id, type: 'company' }).whereIn('code', COMPANY_CODES);
  const admin = await knex('users').where({ email: 'admin@phoenix.test' }).first('id');
  const now = new Date();
  let count = 0;

  await knex.transaction(async (trx) => {
    for (const company of companies) {
      for (const template of TEMPLATES(company)) {
        const content = {
          channel: template.channel,
          header: template.header ?? null,
          subject: template.subject ?? null,
          body: template.body,
          footer: template.footer ?? null,
          buttons: template.buttons ?? [],
        };
        const issues = validateTemplate({ ...content, name: template.name, language: template.language }, { path: template.name });
        if (issues.length) throw new Error(`Seed template ${template.name} is invalid: ${JSON.stringify(issues)}`);
        const samples = Object.fromEntries(templateVariables(content).map((name) => [name, name === 'company_name' ? company.name : SAMPLES[name]]));
        const decided = template.status === 'approved' || template.status === 'rejected';
        const [row] = await trx('message_templates')
          .insert({
            group_id: group.id,
            company_id: company.id,
            channel: template.channel,
            name: template.name,
            language: template.language,
            category: template.category,
            description: template.description,
            latest_version: 1,
            status: template.status,
            approved_version: template.status === 'approved' ? 1 : null,
            created_by: admin?.id ?? null,
            updated_by: admin?.id ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning('id');
        await trx('message_template_versions').insert({
          template_id: row.id,
          version: 1,
          status: template.status,
          header: template.header ? JSON.stringify(template.header) : null,
          subject: template.subject ?? null,
          body: template.body,
          footer: template.footer ?? null,
          buttons: JSON.stringify(template.buttons ?? []),
          samples: JSON.stringify(samples),
          provider_template_id: template.providerTemplateId ?? null,
          rejection_reason: template.rejectionReason ?? null,
          created_by: admin?.id ?? null,
          created_at: now,
          updated_at: now,
          submitted_at: template.status === 'draft' ? null : now,
          submitted_by: template.status === 'draft' ? null : (admin?.id ?? null),
          decided_at: decided ? now : null,
        });
        count += 1;
      }
    }
  });
  console.log(`Messaging: ${count} message templates for ${companies.length} companies.`);
}
