'use client';

import { useState } from 'react';
import { ArticleDialog } from '@/components/ai/ArticleDialog';
import { CompanySelect } from '@/components/ai/CompanySelect';
import { RelativeTime, SearchInput, StatusPill } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, Card, EmptyState, ErrorAlert, PageLoading, Spinner } from '@/components/ui';
import { ARTICLE_STATUS_LABEL, ARTICLE_STATUS_TONE, aiCompanies, companyOfScope, percent } from '@/lib/ai/display';
import { useKnowledge, useRetrieval } from '@/lib/ai/queries';
import type { ArticleStatus, KnowledgeArticle } from '@/lib/ai/types';
import { useSession } from '@/lib/session';

// The knowledge base per company: the approved articles the reply assistant answers from, and a
// way to see which articles it would pick for a question.

type StatusFilter = ArticleStatus | 'all' | '';

export function KnowledgeView() {
  return (
    <Guard anyOf={['ai.view']} anywhere>
      <Knowledge />
    </Guard>
  );
}

function Knowledge() {
  const session = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [editing, setEditing] = useState<KnowledgeArticle | 'new' | null>(null);
  const articles = useKnowledge(session.scope.id, q, status);
  const writable = aiCompanies(session, 'ai.knowledge');
  const atGroup = !companyOfScope(session);

  if (articles.isPending) return <PageLoading />;
  if (articles.isError) return <ErrorAlert error={articles.error} />;
  const items = articles.data.pages.flatMap((page) => page.data);
  const filtered = Boolean(q || status);

  return (
    <div className="stack gap-16">
      <Card
        flush
        title="Knowledge base"
        description="Answers the reply assistant may use. Only approved articles count; anything else it hands over to a person."
        actions={
          writable.length > 0 ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              New article
            </Button>
          ) : null
        }
      >
        <div className="toolbar ai-toolbar">
          <div className="ai-toolbar__filters">
            <SearchInput value={q} onChange={setQ} label="Search articles" placeholder="Search articles" />
            <label className="visually-hidden" htmlFor="ai-kb-status">
              Status
            </label>
            <select id="ai-kb-status" className="select toolbar__select" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="">Drafts and approved</option>
              <option value="approved">Approved</option>
              <option value="draft">Drafts</option>
              <option value="archived">Archived</option>
              <option value="all">Everything</option>
            </select>
          </div>
          {articles.isFetching && !articles.isFetchingNextPage ? <span className="small muted">Refreshing…</span> : null}
        </div>
        {items.length === 0 ? (
          <EmptyState
            icon="note"
            title={filtered ? 'No articles match' : 'No articles yet'}
            action={
              !filtered && writable.length > 0 ? (
                <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                  Write the first article
                </Button>
              ) : undefined
            }
          >
            {filtered ? 'Try other words or another status.' : 'Add the questions families ask most: timings, formats, eligibility, how to book a demo.'}
          </EmptyState>
        ) : (
          <ul className="ai-list">
            {items.map((article) => (
              <ArticleItem key={article.id} article={article} showCompany={atGroup} onOpen={() => setEditing(article)} />
            ))}
          </ul>
        )}
        {articles.hasNextPage ? (
          <div className="load-more">
            <Button onClick={() => articles.fetchNextPage()} loading={articles.isFetchingNextPage}>
              Show more
            </Button>
          </div>
        ) : null}
      </Card>

      <RetrievalCard />

      <ArticleDialog
        open={editing !== null}
        article={editing === 'new' ? null : editing}
        companies={writable}
        defaultCompanyId={companyOfScope(session)?.id ?? null}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function ArticleItem({ article, showCompany, onOpen }: { article: KnowledgeArticle; showCompany: boolean; onOpen: () => void }) {
  return (
    <li className="ai-item">
      <div className="ai-item__main">
        <div className="ai-item__title">
          <span>{article.title}</span>
          <StatusPill tone={ARTICLE_STATUS_TONE[article.status]}>{ARTICLE_STATUS_LABEL[article.status]}</StatusPill>
        </div>
        <div className="ai-item__meta">
          {showCompany ? <span>{article.company.name}</span> : null}
          {article.owner ? <span>{article.owner.name}</span> : null}
          <span>
            Updated <RelativeTime value={article.updatedAt} sans />
          </span>
        </div>
        <p className="ai-article__body">{article.body}</p>
        {article.tags.length > 0 ? (
          <div className="ai-chips ai-article__tags" aria-label="Tags">
            {article.tags.map((tag) => (
              <span key={tag} className="ai-chip">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="ai-item__actions">
        <Button size="sm" onClick={onOpen} aria-label={`${article.canEdit ? 'Edit' : 'View'} ${article.title}`}>
          {article.canEdit ? 'Edit' : 'View'}
        </Button>
      </div>
    </li>
  );
}

/** Ask a question and see which approved articles the reply assistant would answer from. */
function RetrievalCard() {
  const session = useSession();
  const companies = aiCompanies(session, 'ai.view');
  const [picked, setPicked] = useState<string | null>(null);
  const companyId = picked && companies.some((c) => c.id === picked) ? picked : (companies[0]?.id ?? null);
  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState('');
  const retrieval = useRetrieval(companyId, asked);
  if (!companyId) return null;

  return (
    <Card flush title="What would the reply assistant use?" description="Type a question the way a family would. These approved articles go into its prompt, best match first.">
      <form
        className="ai-try"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(draft.trim());
        }}
      >
        <CompanySelect companies={companies} value={companyId} onChange={setPicked} id="ai-kb-try-company" />
        <label htmlFor="ai-kb-try" className="visually-hidden">
          Question
        </label>
        <div className="row gap-8 ai-try__ask">
          <input
            id="ai-kb-try"
            className="input"
            value={draft}
            maxLength={1000}
            placeholder="Is the SAT weekend batch online?"
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={!draft.trim()}>
            Find articles
          </Button>
        </div>
        {asked ? (
          retrieval.isPending ? (
            <Spinner label="Finding articles" />
          ) : retrieval.isError ? (
            <ErrorAlert error={retrieval.error} />
          ) : retrieval.data.length === 0 ? (
            <p className="small muted" role="status">
              No approved article matches. The reply assistant would hand this question to a person.
            </p>
          ) : (
            <ol className="stack gap-8 ai-try__results" aria-label="Matching articles">
              {retrieval.data.map((hit) => (
                <li key={hit.id} className="ai-try__result">
                  <span className="row gap-8 ai-spread">
                    <span className="strong">{hit.title}</span>
                    <span className="small muted">Match {percent(hit.relevance)}</span>
                  </span>
                  <span className="small">{hit.excerpt}</span>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </form>
    </Card>
  );
}
