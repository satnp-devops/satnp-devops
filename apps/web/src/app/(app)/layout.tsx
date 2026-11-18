'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { CommandPalette } from '@/components/search/CommandPalette';
import { Sidebar } from '@/components/shell/Sidebar';
import { Button, ErrorAlert, PageLoading } from '@/components/ui';
import { isApiError } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { SessionProvider } from '@/lib/session';
import { useSignOut } from '@/lib/useSignOut';

const ACCOUNT_PAGE = '/settings/security';

/**
 * Everything behind sign-in goes through here:
 *   no session              → sign-in page (and back here afterwards)
 *   second step pending     → sign-in page, which asks for the code
 *   2FA required, not set   → only the account page, to set it up
 *   no roles anywhere       → a short explanation
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();

  const signedOut = me.isError && isApiError(me.error) && me.error.status === 401;
  const codePending = me.data?.session.mfaPending === true;
  const mustSetUp2fa = me.data?.session.mfaSetupRequired === true;
  const redirectTo =
    signedOut || codePending
      ? `/login?next=${encodeURIComponent(pathname)}`
      : mustSetUp2fa && pathname !== ACCOUNT_PAGE
        ? ACCOUNT_PAGE
        : null;

  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  if (redirectTo || me.isPending) return <PageLoading />;
  if (me.isError) {
    return (
      <main className="auth">
        <AuthCard title="We couldn't load your workspace">
          <ErrorAlert error={me.error} />
          <Button variant="primary" icon="refresh" onClick={() => void me.refetch()} loading={me.isFetching}>
            Try again
          </Button>
        </AuthCard>
      </main>
    );
  }
  if (me.data.units.length === 0) return <NoAccess name={me.data.user.name} />;

  return (
    <SessionProvider me={me.data}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app">
        <Sidebar locked={mustSetUp2fa} />
        <main className="main" id="main">
          {children}
        </main>
      </div>
      {mustSetUp2fa ? null : <CommandPalette />}
    </SessionProvider>
  );
}

function NoAccess({ name }: { name: string }) {
  const signOut = useSignOut();
  return (
    <main className="auth">
      <AuthCard
        title={`Welcome, ${name}`}
        subtitle="Your account works, but you haven't been given a role anywhere yet. Ask your admin to add you to a company, branch or team."
      >
        <Button icon="logout" loading={signOut.isPending} onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </AuthCard>
    </main>
  );
}
