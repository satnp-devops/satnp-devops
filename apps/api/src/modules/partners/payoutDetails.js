import { z } from 'zod';
import { env } from '../../config/env.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { isValidGstin, isValidPan, normaliseGstin } from '../../core/billing/gstin.js';

// Where a partner's money goes. The full details are stored encrypted (AES-256-GCM with the app
// key, like two-step secrets); a masked summary (`payout_hint`) sits beside them so lists and the
// portal never need to decrypt. Only people with partners.payout_details read the full details,
// and every read is audited.

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);
const upper = (value) => (typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value);
const DOT = '•';

const accountName = z.preprocess(trimmed, z.string().min(2, 'Enter the name on the account').max(120));
const pan = z.preprocess(upper, z.string().refine(isValidPan, 'Enter a PAN like ABCDE1234F'));
const gstin = z.preprocess((v) => (typeof v === 'string' ? normaliseGstin(v) : v), z.string().refine((v) => isValidGstin(v), 'Enter a valid GSTIN'));

const common = {
  pan: pan.optional(),
  gstin: gstin.optional(),
};

export const payoutDetailsSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('bank_transfer'),
    accountName,
    accountNumber: z.preprocess(
      (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '') : v),
      z.string().regex(/^\d{6,18}$/, 'Enter the account number (6 to 18 digits)'),
    ),
    ifsc: z.preprocess(upper, z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter an IFSC like HDFC0001234')),
    bankName: z.preprocess(trimmed, z.string().max(120)).optional(),
    ...common,
  }),
  z.strictObject({
    method: z.literal('upi'),
    accountName: accountName.optional(),
    upiId: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.string().regex(/^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/, 'Enter a UPI id like name@okhdfcbank'),
    ),
    ...common,
  }),
]);

function maskUpi(upiId) {
  const at = upiId.lastIndexOf('@');
  return `${upiId.slice(0, 2)}${DOT.repeat(3)}${upiId.slice(at)}`;
}

/** The summary that is safe to show anyone who sees the partner. Pure. */
export function payoutHint(details) {
  if (!details) return {};
  const base = { method: details.method, panOnFile: Boolean(details.pan), gstin: details.gstin ?? null };
  if (details.method === 'bank_transfer') {
    return {
      ...base,
      accountName: details.accountName,
      accountLast4: details.accountNumber.slice(-4),
      ifsc: details.ifsc,
      bankName: details.bankName ?? null,
    };
  }
  return { ...base, accountName: details.accountName ?? null, upi: maskUpi(details.upiId) };
}

/** "HDFC0001234 ••••4321" / "ra•••@okhdfcbank", for one-line displays. Pure. */
export function describeHint(hint) {
  if (!hint?.method) return null;
  if (hint.method === 'bank_transfer') return `${hint.bankName ? `${hint.bankName} ` : ''}${DOT.repeat(4)}${hint.accountLast4} (${hint.ifsc})`;
  return `UPI ${hint.upi}`;
}

export const sealPayoutDetails = (details, key = env.encryptionKey) => encrypt(JSON.stringify(details), key);

export function openPayoutDetails(ciphertext, key = env.encryptionKey) {
  if (!ciphertext) return null;
  return JSON.parse(decrypt(ciphertext, key));
}

/** What the API sends for a hint (camelCase, never the full numbers). */
export function presentPayoutHint(hint) {
  if (!hint || !hint.method) return null;
  return {
    method: hint.method,
    accountName: hint.accountName ?? null,
    accountLast4: hint.accountLast4 ?? null,
    ifsc: hint.ifsc ?? null,
    bankName: hint.bankName ?? null,
    upi: hint.upi ?? null,
    panOnFile: hint.panOnFile === true,
    gstin: hint.gstin ?? null,
    summary: describeHint(hint),
  };
}
