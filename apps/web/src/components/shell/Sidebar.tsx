'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV, type NavItem } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { useSignOut } from '@/lib/useSignOut';
import { Icon } from '../icons';
import { SearchButton } from '../search/SearchButton';
import { Avatar, Button } from '../ui';
import { ScopeSwitcher } from './ScopeSwitcher';

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function NavEntry({ item, pathname, locked }: { item: NavItem; pathname: string; locked: boolean }) {
  const { canAnywhere } = useSession();
  if (item.anyOf && !item.anyOf.some((permission) => canAnywhere(permission))) return null;

  if (!item.href) {
    return (
      <span className="nav__item nav__item--soon" title={item.phase ? `Arrives in phase ${item.phase}` : 'Coming soon'}>
        <Icon name={item.icon} />
        <span className="nav__label">{item.label}</span>
        <span className="nav__soon">Soon</span>
      </span>
    );
  }

  // While two-step setup is required, only the account page is reachable.
  if (locked && item.href !== '/settings') {
    return (
      <span className="nav__item nav__item--soon" aria-disabled="true">
        <Icon name={item.icon} />
        <span className="nav__label">{item.label}</span>
        <Icon name="lock" size={14} />
      </span>
    );
  }

  return (
    <Link href={item.href} className="nav__item" aria-current={isActive(pathname, item.href) ? 'page' : undefined}>
      <Icon name={item.icon} />
      <span className="nav__label">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ locked = false }: { locked?: boolean }) {
  const { user, scope, unitsById } = useSession();
  const pathname = usePathname();
  const signOut = useSignOut();
  const group = unitsById.get(scope.groupId);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__mark" style={{ background: 'var(--accent)' }}>
          P
        </span>
        <div className="brand__text">
          <div className="brand__name">Phoenix</div>
          <div className="brand__sub">{group?.name ?? 'Platform'}</div>
        </div>
      </div>

      <ScopeSwitcher disabled={locked} />
      <SearchButton disabled={locked} />

      <nav className="stack gap-12" aria-label="Main">
        {NAV.map((section) => (
          // A section with only upcoming entries is hidden on phones, like the entries themselves.
          <div
            key={section.title ?? 'main'}
            className={section.items.some((item) => item.href) ? 'stack gap-4' : 'stack gap-4 nav-group--soon'}
          >
            {section.title ? <p className="nav-section">{section.title}</p> : null}
            <div className="nav">
              {section.items.map((item) => (
                <NavEntry key={item.label} item={item} pathname={pathname} locked={locked} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="me">
          <Avatar name={user.name} size={32} />
          <div className="me__text">
            <div className="me__name">{user.name}</div>
            <div className="me__email">{user.email}</div>
          </div>
        </div>
        <Button variant="ghost" icon="logout" block loading={signOut.isPending} onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </div>
    </aside>
  );
}
