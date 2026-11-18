import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companiesInScope, requireCompany, unitsIndex, usersWithPermissionAt } from '../../core/crm/scope.js';
import { retrieveArticles } from '../../core/ai/index.js';
import { searchVector } from '../../core/ai/knowledge.js';
import { clip } from '../../core/ai/text.js';
import { presentArticle } from './present.js';

// The knowledge base per company: approved articles the reply assistant answers from.
// Reading needs ai.view in or above the company; writing needs ai.knowledge at the company.

const VIEW = 'ai.view';
const WRITE = 'ai.knowledge';

const articleQuery = (trx = db) =>
  trx('ai_knowledge_articles as k')
    .join('org_units as cu', 'cu.id', 'k.company_id')
    .leftJoin('users as o', 'o.id', 'k.owner_user_id')
    .leftJoin('users as ab', 'ab.id', 'k.approved_by')
    .select('k.*', 'cu.name as company_name', 'o.name as owner_name', 'ab.name as approved_by_name');

const canEditIn = (req, index) => (row) => {
  const company = index.get(row.company_id);
  return Boolean(company && req.access.can(WRITE, company.path));
};

/** Articles of the companies in the working scope, recently changed first. */
export async function listArticles(req, { unitId, q, status, tag, cursor, limit }) {
  const companies = await companiesInScope(req, unitId, VIEW); // 404 when the unit isn't visible
  if (companies.length === 0) throw errors.forbidden();
  const after = decodeCursor(cursor);
  const query = articleQuery().whereIn('k.company_id', companies.map((c) => c.id));
  if (status === 'all') {
    // every status
  } else if (status) query.where('k.status', status);
  else query.whereNot('k.status', 'archived');
  if (tag) query.whereRaw('k.tags @> array[?]::text[]', [tag]);
  if (q) {
    query.where((w) => {
      w.whereRaw("k.search_tsv @@ websearch_to_tsquery('english', ?)", [q]).orWhereRaw('lower(k.title) like ?', [`%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`]);
    });
  }
  if (after) query.whereRaw('(k.updated_at, k.id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
  const rows = await query.orderBy([{ column: 'k.updated_at', order: 'desc' }, { column: 'k.id', order: 'desc' }]).limit(limit + 1);
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ t: new Date(row.updated_at).toISOString(), id: row.id }));
  const canEdit = canEditIn(req, await unitsIndex(req));
  return { data: page.map((row) => presentArticle(row, { canEdit: canEdit(row) })), nextCursor };
}

async function loadArticle(req, id, trx = db, { forUpdate = false } = {}) {
  const query = trx('ai_knowledge_articles').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  if (!row) throw errors.notFound('Article');
  const index = await unitsIndex(req, trx);
  const company = index.get(row.company_id);
  if (!company || !req.access.canSee(company.path) || !req.access.canAnywhereWithin(VIEW, company.path)) throw errors.notFound('Article');
  return { row, company, index };
}

async function presentById(req, id, trx = db) {
  const row = await articleQuery(trx).where('k.id', id).first();
  const index = await unitsIndex(req, trx);
  return presentArticle(row, { canEdit: canEditIn(req, index)(row) });
}

export async function getArticle(req, id) {
  await loadArticle(req, id);
  return presentById(req, id);
}

/** The owner must be able to see the knowledge base of the company. */
async function checkOwner(company, ownerUserId, trx, path) {
  if (!ownerUserId) return null;
  const [owner] = await usersWithPermissionAt(company, VIEW, { trx, userIds: [ownerUserId] });
  if (!owner) throw errors.validation([{ path, message: 'Pick someone who works with AI in this company' }]);
  return owner.id;
}

const auditAfter = (row) => ({ title: row.title, status: row.status, tags: row.tags, ownerUserId: row.owner_user_id, body: clip(row.body, 200) });

export async function createArticle(req, input) {
  const company = await requireCompany(req, input.companyId, WRITE, { write: true, path: 'body.companyId' });
  return db.transaction(async (trx) => {
    const ownerUserId = input.ownerUserId === undefined ? req.auth.user.id : await checkOwner(company, input.ownerUserId, trx, 'body.ownerUserId');
    const approved = input.status === 'approved';
    const [row] = await trx('ai_knowledge_articles')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        title: input.title,
        body: input.body,
        tags: input.tags,
        status: input.status,
        owner_user_id: ownerUserId,
        search_tsv: searchVector(trx, input),
        approved_by: approved ? req.auth.user.id : null,
        approved_at: approved ? trx.fn.now() : null,
        created_by: req.auth.user.id,
        updated_by: req.auth.user.id,
      })
      .returning('*');
    await writeAudit(trx, req, { unit: company, action: 'ai.knowledge_created', entityType: 'ai_knowledge_article', entityId: row.id, after: auditAfter(row) });
    await emitEvent(trx, {
      type: 'ai_knowledge.created',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'ai_knowledge_article',
      aggregateId: row.id,
      actorUserId: req.auth.user.id,
      payload: { articleId: row.id, companyId: company.id, status: row.status },
    });
    return presentById(req, row.id, trx);
  });
}

export async function updateArticle(req, id, patch) {
  return db.transaction(async (trx) => {
    const { row, company } = await loadArticle(req, id, trx, { forUpdate: true });
    if (!req.access.can(WRITE, company.path)) throw errors.forbidden();
    const next = {
      title: patch.title ?? row.title,
      body: patch.body ?? row.body,
      tags: patch.tags ?? row.tags,
      status: patch.status ?? row.status,
      owner_user_id: patch.ownerUserId === undefined ? row.owner_user_id : await checkOwner(company, patch.ownerUserId, trx, 'body.ownerUserId'),
    };
    const changes = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(row[key]));
    if (changes.length === 0) return presentById(req, id, trx);
    const becameApproved = next.status === 'approved' && row.status !== 'approved';
    const update = {
      ...next,
      search_tsv: searchVector(trx, { title: next.title, body: next.body, tags: next.tags }),
      updated_by: req.auth.user.id,
      updated_at: trx.fn.now(),
      ...(becameApproved ? { approved_by: req.auth.user.id, approved_at: trx.fn.now() } : {}),
      ...(next.status !== 'approved' ? { approved_by: null, approved_at: null } : {}),
    };
    const [updated] = await trx('ai_knowledge_articles').where({ id }).update(update).returning('*');
    const archived = next.status === 'archived' && row.status !== 'archived';
    await writeAudit(trx, req, {
      unit: company,
      action: archived ? 'ai.knowledge_archived' : 'ai.knowledge_updated',
      entityType: 'ai_knowledge_article',
      entityId: id,
      before: auditAfter(row),
      after: auditAfter(updated),
    });
    await emitEvent(trx, {
      type: archived ? 'ai_knowledge.archived' : 'ai_knowledge.updated',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'ai_knowledge_article',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { articleId: id, companyId: company.id, status: updated.status, changes },
    });
    return presentById(req, id, trx);
  });
}

export async function archiveArticle(req, id) {
  await updateArticle(req, id, { status: 'archived' });
}

/** What the reply assistant would retrieve for a question (the knowledge base editor's "try it"). */
export async function searchKnowledge(req, { companyId, q }) {
  const company = await requireCompany(req, companyId, VIEW, { path: 'query.companyId' });
  const articles = await retrieveArticles({ companyId: company.id, query: q });
  return articles.map((a) => ({ id: a.id, title: a.title, tags: a.tags, relevance: a.relevance, excerpt: clip(a.body, 240) }));
}
