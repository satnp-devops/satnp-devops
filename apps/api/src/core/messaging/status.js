// Delivery status of an outbound message: queued > sent > delivered > read, or failed.
// Providers report statuses out of order and more than once, so applying one is monotonic and
// idempotent: a status never moves a message backwards, every timestamp is set once, "read"
// implies "delivered" and "sent", and "failed" is final (it is ignored once a message was delivered).

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

const STAMP = { sent: 'sent_at', delivered: 'delivered_at', read: 'read_at' };

/**
 * The change a reported status makes to a message row. Pure.
 * @param {{ direction: string, status: string, sent_at?: Date | string | null, delivered_at?: Date | string | null, read_at?: Date | string | null }} message
 * @param {{ status: 'sent' | 'delivered' | 'read' | 'failed', at: Date, errorCode?: string | null, errorMessage?: string | null }} report
 * @returns {{ changed: boolean, patch: Record<string, unknown> }} patch holds only the columns to update
 */
export function applyStatus(message, { status, at, errorCode = null, errorMessage = null }) {
  const none = { changed: false, patch: {} };
  if (message.direction !== 'outbound' || message.status === 'failed') return none;
  const current = RANK[message.status] ?? 0;

  if (status === 'failed') {
    if (current >= RANK.delivered) return none;
    return {
      changed: true,
      patch: { status: 'failed', failed_at: at, error_code: errorCode ?? 'provider_failed', error_message: errorMessage ?? 'The provider could not deliver this message' },
    };
  }

  const target = RANK[status];
  if (target === undefined) throw new TypeError(`Unknown delivery status "${status}"`);
  if (target <= current) {
    // Fill a timestamp an earlier report skipped (read arrived before delivered), without changing the status.
    const column = STAMP[status];
    return message[column] ? none : { changed: false, patch: { [column]: at } };
  }
  const patch = { status };
  for (const [name, rank] of Object.entries(RANK)) {
    const column = STAMP[name];
    if (column && rank <= target && !message[column]) patch[column] = at;
  }
  return { changed: true, patch };
}
