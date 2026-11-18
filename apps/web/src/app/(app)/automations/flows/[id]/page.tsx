import type { Metadata } from 'next';
import { FlowEditor } from './FlowEditor';

export const metadata: Metadata = { title: 'Flow editor' };

/** ?step=<id> opens a step in the inspector; ?test=1 opens the test panel (?test=run also runs it). */
export default async function FlowEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return <FlowEditor id={id} initialStep={one(query.step) ?? null} initialTest={(one(query.test) as 'run' | '1' | undefined) ?? null} />;
}
