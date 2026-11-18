'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DateTime } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { ARTICLE_STATUS_LABEL } from '@/lib/ai/display';
import { aiKeys } from '@/lib/ai/queries';
import type { ArticleStatus, KnowledgeArticle } from '@/lib/ai/types';
import type { OrgUnit } from '@/lib/types';
import './ai.css';

// Write or change a knowledge base article. Only approved articles are used by the reply
// assistant, so a new article starts as a draft unless the writer approves it straight away.

/** "fees, sat, weekend batch" → ['fees', 'sat', 'weekend batch'] (lower case, no repeats). */
export function parseTags(text: string): string[] {
  const tags = text
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)];
}

export function ArticleDialog({
  open,
  article,
  companies,
  defaultCompanyId,
  onClose,
}: {
  open: boolean;
  /** Missing for a new article. */
  article: KnowledgeArticle | null;
  /** Companies the writer may add articles to (new articles only). */
  companies: readonly OrgUnit[];
  defaultCompanyId: string | null;
  onClose: () => void;
}) {
  const title = article ? (article.canEdit ? 'Edit article' : 'Article') : 'New article';
  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      {open ? <ArticleForm key={article?.id ?? 'new'} article={article} companies={companies} defaultCompanyId={defaultCompanyId} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ArticleForm({
  article,
  companies,
  defaultCompanyId,
  onClose,
}: {
  article: KnowledgeArticle | null;
  companies: readonly OrgUnit[];
  defaultCompanyId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState(article?.company.id ?? defaultCompanyId ?? companies[0]?.id ?? '');
  const [title, setTitle] = useState(article?.title ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [tags, setTags] = useState(article?.tags.join(', ') ?? '');
  const [status, setStatus] = useState<ArticleStatus>(article?.status ?? 'draft');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const readOnly = article !== null && !article.canEdit;

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: aiKeys.knowledgeAll });
    await queryClient.invalidateQueries({ queryKey: ['ai', 'retrieval'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const fields = { title: title.trim(), body: body.trim(), tags: parseTags(tags), status };
      return article ? api.patch<KnowledgeArticle>(`/ai/knowledge/${article.id}`, fields) : api.post<KnowledgeArticle>('/ai/knowledge', { companyId, ...fields });
    },
    onSuccess: done,
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/ai/knowledge/${article?.id ?? ''}`),
    onSuccess: async () => {
      setConfirmArchive(false);
      await done();
    },
  });

  const errors = fieldErrorsOf(save.error);
  const tagError = errors['body.tags'] ?? Object.entries(errors).find(([path]) => path.startsWith('body.tags.'))?.[1];
  const shown = ['body.companyId', 'body.title', 'body.body', 'body.tags', 'body.status'];
  const statuses: ArticleStatus[] = article ? ['draft', 'approved', 'archived'] : ['draft', 'approved'];

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) save.mutate();
        }}
      >
        <DialogBody>
          <div className="stack gap-16">
            {article ? (
              <p className="small muted">
                {article.company.name}
                {article.owner ? ` · Kept up to date by ${article.owner.name}` : ''}
                {article.approvedBy && article.approvedAt ? (
                  <>
                    {' '}
                    · Approved by {article.approvedBy.name} <DateTime value={article.approvedAt} format="date" />
                  </>
                ) : null}
              </p>
            ) : companies.length > 1 ? (
              <Field label="Company" error={errors['body.companyId']}>
                {(control) => (
                  <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            <Field label="Title" error={errors['body.title']} hint="The question families ask, in their words, works best.">
              {(control) => <input {...control} className="input" value={title} maxLength={200} readOnly={readOnly} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Field label="Answer" error={errors['body.body']} hint="The reply assistant answers only from approved articles. Write what a counsellor would say; include fees only if the company allows the AI to quote them.">
              {(control) => (
                <textarea {...control} className="textarea ai-article__textarea" value={body} maxLength={20000} readOnly={readOnly} onChange={(e) => setBody(e.target.value)} />
              )}
            </Field>
            <div className="ai-columns">
              <Field label="Tags" optional error={tagError} hint="Separate with commas, for example: sat, timings, weekend batch">
                {(control) => <input {...control} className="input" value={tags} readOnly={readOnly} onChange={(e) => setTags(e.target.value)} />}
              </Field>
              <Field label="Status" error={errors['body.status']} hint="Only approved articles are used by the AI.">
                {(control) => (
                  <select {...control} className="select" value={status} disabled={readOnly} onChange={(e) => setStatus(e.target.value as ArticleStatus)}>
                    {statuses.map((value) => (
                      <option key={value} value={value}>
                        {ARTICLE_STATUS_LABEL[value]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <ErrorAlert error={formErrorOf(save.error, shown)} />
          </div>
        </DialogBody>
        <DialogFooter>
          {article && article.canEdit && article.status !== 'archived' ? (
            <Button type="button" variant="danger" onClick={() => setConfirmArchive(true)} disabled={save.isPending}>
              Archive
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {readOnly ? null : (
            <Button type="submit" variant="primary" loading={save.isPending}>
              {article ? 'Save article' : 'Add article'}
            </Button>
          )}
        </DialogFooter>
      </form>
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Archive this article?"
        confirmLabel="Archive"
        danger
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate()}
      >
        The reply assistant stops using it. It stays in the list under Archived and can be restored by changing its status.
      </ConfirmDialog>
    </>
  );
}
