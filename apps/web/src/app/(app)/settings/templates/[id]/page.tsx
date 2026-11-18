import type { Metadata } from 'next';
import { TemplateEditor } from '../TemplateEditor';

export const metadata: Metadata = { title: 'Message template' };

const CHANNELS = ['whatsapp', 'email', 'sms'] as const;
type Channel = (typeof CHANNELS)[number];
const isChannel = (value: unknown): value is Channel => typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /settings/templates/new (optionally ?companyId=&channel=) creates; /settings/templates/<id> edits. */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (id === 'new') {
    const companyId = typeof query.companyId === 'string' && UUID.test(query.companyId) ? query.companyId : undefined;
    return <TemplateEditor id={null} initialCompanyId={companyId} initialChannel={isChannel(query.channel) ? query.channel : undefined} />;
  }
  return <TemplateEditor id={UUID.test(id) ? id : '00000000-0000-0000-0000-000000000000'} />;
}
