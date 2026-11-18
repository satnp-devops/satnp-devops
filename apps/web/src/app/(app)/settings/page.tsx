'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageLoading } from '@/components/ui';
import { useSession } from '@/lib/session';
import { visibleSettingsTabs } from '@/lib/settingsTabs';

/** /settings opens the first section the user may see. */
export default function SettingsIndexPage() {
  const session = useSession();
  const router = useRouter();
  const first = visibleSettingsTabs(session)[0]?.href ?? '/settings/security';

  useEffect(() => {
    router.replace(first);
  }, [first, router]);

  return <PageLoading />;
}
