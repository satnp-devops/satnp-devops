// Keeping the AI log in step with the contacts module's merge and erase (docs/crm/PHASE2_CONTRACT.md
// §9.1, India's DPDP Act s. 12). The ai module runs these from its contact.merged and contact.erased
// event handlers, like messaging does for messages. Both are idempotent (events can be delivered twice).

export const ERASED_REVIEW_NOTE = 'Closed: the personal data was erased on request';

/** Move a merged person's AI actions to the person they were merged into. */
export async function moveContactAiActions(trx, { sourceId, targetId }) {
  return trx('ai_actions').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: trx.fn.now() });
}

/**
 * The right to erasure: what the AI read and wrote about a person goes (the message it was given,
 * its summary, drafts and extracted fields, the guardrails' quotes of the text, reviewers' notes).
 * The rows stay, with agent, status, model, tokens and times, as the record that the AI ran and what
 * it cost. Covers actions about the person and actions on deals they are the main contact of.
 * A review still waiting is closed as rejected: there is nothing left to approve.
 * @returns {Promise<{ scrubbed: number, closedReviews: number }>}
 */
export async function eraseContactAiActions(trx, contactId) {
  const about = (query) =>
    query.where((where) =>
      where.where('contact_id', contactId).orWhereIn('deal_id', trx('deals').where({ primary_contact_id: contactId }).select('id')),
    );
  const scrubbed = await about(trx('ai_actions')).update({
    input: '{}',
    input_summary: null,
    output: null,
    final_output: null,
    // Keep which checks ran and their outcome; their messages quote the person's text.
    guardrails: trx.raw(
      `coalesce((select jsonb_agg(jsonb_build_object('check', g->'check', 'outcome', g->'outcome'))
                   from jsonb_array_elements(case when jsonb_typeof(guardrails) = 'array' then guardrails else '[]'::jsonb end) as g), '[]'::jsonb)`,
    ),
    review_note: null,
    error_message: null,
    updated_at: trx.fn.now(),
  });
  const closedReviews = await about(trx('ai_actions'))
    .where('status', 'pending_review')
    .update({ status: 'rejected', reviewed_at: trx.fn.now(), review_note: ERASED_REVIEW_NOTE, updated_at: trx.fn.now() });
  return { scrubbed, closedReviews };
}
