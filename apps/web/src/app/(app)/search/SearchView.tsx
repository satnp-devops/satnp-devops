'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { SearchInput, Section, Tabs, type TabItem } from '@/components/crm';
import { SearchHitContent } from '@/components/search/SearchHitContent';
import { Button, EmptyState, ErrorAlert, PageHeader, Spinner } from '@/components/ui';
import { withQuery } from '@/lib/api';
import type { SearchEntityType } from '@/lib/crm/types';
import { SEARCH_GROUPS, hitHref, searchableQuery, useSearch } from '@/lib/search/api';
import { rememberSearch } from '@/lib/search/recent';
import { useSession } from '@/lib/session';
import './search-page.css';

// All results for a query (the palette's "See all results"): up to 20 per type, in the current
// scope, with tabs to narrow to one type. The URL holds the query (?q=…&type=deal).

const LIMIT = 20;
const VIEW_PERMISSIONS: Record<SearchEntityType, string> = { deal: 'deals.view', contact: 'contacts.view', account: 'accounts.view' };

function isSearchType(value: string | null): value is SearchEntityType {
  return value === 'deal' || value === 'contact' || value === 'account';
}

export function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const session = useSession();
  const text = params.get('q') ?? '';
  const typeParam = params.get('type');
  const type = isSearchType(typeParam) ? typeParam : null;
  const q = searchableQuery(text);
  const search = useSearch(session.scope.id, q, { limit: LIMIT });

  const viewable = SEARCH_GROUPS.filter((group) => session.canAnywhere(VIEW_PERMISSIONS[group.type]));
  const hitsOf = (groupType: SearchEntityType) => search.data?.groups.find((group) => group.type === groupType)?.hits ?? [];
  const hrefFor = (next: { q?: string; type?: SearchEntityType | null }) =>
    withQuery('/search', { q: next.q ?? text, type: next.type === undefined ? type : next.type });
  const counted = q !== null && search.isSuccess && !search.isPlaceholderData;
  const tabs: TabItem[] = [
    { href: hrefFor({ type: null }), label: 'All', active: type === null },
    ...viewable.map((group) => ({
      href: hrefFor({ type: group.type }),
      label: group.label,
      active: type === group.type,
      count: counted ? hitsOf(group.type).length : undefined,
    })),
  ];
  const shown = viewable.filter((group) => type === null || group.type === type);
  const total = shown.reduce((sum, group) => sum + hitsOf(group.type).length, 0);
  const showCompany = session.scope.type === 'group';

  let body;
  if (q === null) {
    body = (
      <EmptyState icon="search" title="Search leads, contacts and accounts">
        Type at least 2 characters. Exact phone numbers, email addresses and references come first, then names.
      </EmptyState>
    );
  } else if (search.isError) {
    body = (
      <div className="stack gap-12">
        <ErrorAlert error={search.error} title="Search failed" />
        <div>
          <Button icon="refresh" onClick={() => void search.refetch()} loading={search.isFetching}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (!search.data) {
    body = (
      <p className="search-page__loading">
        <Spinner label="Searching" /> Searching…
      </p>
    );
  } else if (total === 0 && !search.isPlaceholderData) {
    body = (
      <EmptyState icon="search" title={`No matches for “${q}”`}>
        Nothing in {session.scope.name} matches. Try a full phone number, an email address, a lead reference or fewer words.
      </EmptyState>
    );
  } else {
    body = (
      <div className={search.isPlaceholderData ? 'stack gap-16 search-page__stale' : 'stack gap-16'} aria-busy={search.isFetching}>
        {shown.map((group) => {
          const hits = hitsOf(group.type);
          if (hits.length === 0) return null;
          return (
            <Section
              key={group.type}
              title={group.label}
              count={hits.length}
              flush
              footer={
                hits.length === LIMIT ? (
                  <span className="muted">Showing the best {LIMIT} matches. Add more words to narrow the search.</span>
                ) : undefined
              }
            >
              <ul className="search-page__list">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <Link href={hitHref(hit)} className="search-page__hit" onClick={() => rememberSearch(session.user.id, q)}>
                      <SearchHitContent hit={hit} query={q} showCompany={showCompany} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Search" description={`Leads, deals, contacts and accounts in ${session.scope.name}.`} />
      <div className="content stack gap-16">
        <div className="search-page__bar">
          <SearchInput
            value={text}
            onChange={(next) => router.replace(hrefFor({ q: next }), { scroll: false })}
            label="Search"
            placeholder="Name, phone, email or reference"
            className="search-page__input"
          />
          {q !== null && search.isFetching ? <Spinner label="Searching" /> : null}
        </div>
        {q !== null && viewable.length > 0 ? <Tabs items={tabs} label="Result types" /> : null}
        {body}
      </div>
    </>
  );
}
