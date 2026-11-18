// Keeping messages in step with the contacts module's merge and erase (docs/crm/PHASE2_CONTRACT.md
// §9.1). The messaging module runs these from its contact.merged and contact.erased event handlers,
// so the contacts service needs no messaging code. Both are idempotent (events can be delivered twice).

/** Move a merged person's conversations and messages to the person they were merged into. */
export async function moveContactMessages(trx, { sourceId, targetId }) {
  const conversations = await trx('conversations').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: trx.fn.now() });
  const messages = await trx('messages').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: trx.fn.now() });
  return { conversations, messages };
}

/**
 * The right to erasure (DPDP Act, s. 12): clear what messages say and where they went, keeping
 * the rows (channel, direction, status, times) as the record that messages were exchanged.
 */
export async function eraseContactMessages(trx, contactId) {
  const messages = await trx('messages').where({ contact_id: contactId }).update({
    body: null,
    subject: null,
    variables: '{}',
    media: '[]',
    to_address: null,
    from_address: null,
    agent: null,
    error_message: null,
    meta: '{}',
    updated_at: trx.fn.now(),
  });
  const conversations = await trx('conversations')
    .where({ contact_id: contactId })
    .whereNot('contact_address', 'like', 'erased:%')
    .update({ contact_address: trx.raw("'erased:' || id::text"), business_address: null, updated_at: trx.fn.now() });
  return { messages, conversations };
}
