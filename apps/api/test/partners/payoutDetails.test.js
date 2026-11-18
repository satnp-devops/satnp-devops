import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  describeHint,
  openPayoutDetails,
  payoutDetailsSchema,
  payoutHint,
  presentPayoutHint,
  sealPayoutDetails,
} from '../../src/modules/partners/payoutDetails.js';

const key = randomBytes(32);

test('bank details: validated, normalised, sealed and opened again', () => {
  const parsed = payoutDetailsSchema.parse({
    method: 'bank_transfer',
    accountName: ' EduPath Advisors LLP ',
    accountNumber: '5020 0012 3443 21',
    ifsc: 'hdfc0001234',
    bankName: 'HDFC Bank',
    pan: 'aakfe1234c',
  });
  assert.equal(parsed.accountNumber, '50200012344321');
  assert.equal(parsed.ifsc, 'HDFC0001234');
  assert.equal(parsed.pan, 'AAKFE1234C');
  const sealed = sealPayoutDetails(parsed, key);
  assert.ok(!sealed.includes('50200012344321'), 'the ciphertext doesn’t contain the number');
  assert.deepEqual(openPayoutDetails(sealed, key), parsed);
  assert.throws(() => openPayoutDetails(sealed, randomBytes(32)), 'another key can’t open it');
  assert.equal(openPayoutDetails(null, key), null);
});

test('the hint shows enough to recognise the account, never the number', () => {
  const hint = payoutHint({ method: 'bank_transfer', accountName: 'EduPath', accountNumber: '50200012344321', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' });
  assert.equal(hint.accountLast4, '4321');
  assert.ok(!JSON.stringify(hint).includes('5020001234'));
  assert.equal(describeHint(hint), 'HDFC Bank ••••4321 (HDFC0001234)');
  const upi = payoutHint({ method: 'upi', upiId: 'campusconnect@okicici' });
  assert.equal(upi.upi, 'ca•••@okicici');
  assert.equal(presentPayoutHint(upi).summary, 'UPI ca•••@okicici');
  assert.equal(presentPayoutHint({}), null);
  assert.deepEqual(payoutHint(null), {});
});

test('bad payout details are rejected with field paths', () => {
  const bad = payoutDetailsSchema.safeParse({ method: 'bank_transfer', accountName: 'X', accountNumber: '12', ifsc: 'HDFC1234' });
  assert.equal(bad.success, false);
  const paths = bad.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.includes('accountNumber') && paths.includes('ifsc') && paths.includes('accountName'));
  assert.equal(payoutDetailsSchema.safeParse({ method: 'upi', upiId: 'not-a-upi' }).success, false);
  assert.equal(payoutDetailsSchema.safeParse({ method: 'upi', upiId: 'name@okhdfcbank', extra: 1 }).success, false, 'strict');
  assert.equal(payoutDetailsSchema.safeParse({ method: 'cheque' }).success, false);
});
