import type { Metadata } from 'next';
import { AccountProfile } from '@/components/accounts/AccountProfile';

export const metadata: Metadata = { title: 'Institute' };

export default async function AccountProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const matched = typeof query.matched === 'string' ? query.matched : undefined;
  return <AccountProfile key={id} id={id} matched={matched} linked={query.linked === '1'} />;
}
