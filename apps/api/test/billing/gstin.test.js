import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTSIDE_INDIA_CODE,
  STATE_CODES,
  gstinCheckCharacter,
  isValidGstin,
  isValidPan,
  isValidStateCode,
  normaliseGstin,
  normaliseStateCode,
  panFromGstin,
  stateByCode,
  stateCodeFromGstin,
  validateGstin,
} from '../../src/core/billing/gstin.js';

// Test GSTINs published on the NIC e-invoice sandbox (einv-apisandbox.nic.in) plus the GSTN API
// documentation's sample; all carry valid check characters.
const KNOWN_VALID = [
  ['33GSPTN3382G1Z4', '33', 'Tamil Nadu'],
  ['33GSPTN3381G1Z5', '33', 'Tamil Nadu'],
  ['33GSPTN1882G1Z3', '33', 'Tamil Nadu'],
  ['27GSPMH3381G1ZI', '27', 'Maharashtra'],
  ['27GSPMH1882G1ZG', '27', 'Maharashtra'],
  ['27GSPMH1881G1ZH', '27', 'Maharashtra'],
  ['27AAPFU0939F1ZV', '27', 'Maharashtra'],
];

/** Build a GSTIN with a correct check character from its first 14 characters. */
const withCheck = (first14) => first14 + gstinCheckCharacter(first14);

test('known GSTINs pass the checksum and are taken apart', () => {
  for (const [gstin, stateCode, stateName] of KNOWN_VALID) {
    const result = validateGstin(gstin);
    assert.equal(result.valid, true, gstin);
    assert.equal(result.stateCode, stateCode);
    assert.equal(result.stateName, stateName);
    assert.equal(result.pan, gstin.slice(2, 12));
    assert.equal(result.kind, 'regular');
    assert.equal(result.entityNumber, '1');
    assert.equal(result.checkCharacter, gstin[14]);
  }
  assert.equal(gstinCheckCharacter('27AAPFU0939F1Z'), 'V');
  assert.equal(validateGstin('27AAPFU0939F1ZV').panHolderType, 'firm');
});

test('input is trimmed and upper-cased before checking', () => {
  assert.equal(normaliseGstin(' 27aapfu0939f1zv '), '27AAPFU0939F1ZV');
  assert.equal(isValidGstin(' 27aapfu 0939f1zv'), true);
});

test('a wrong check character is reported as a checksum error', () => {
  const result = validateGstin('27AAPFU0939F1ZA');
  assert.equal(result.valid, false);
  assert.equal(result.error, 'checksum');
  // The org profile placeholder in phase 1 looks right but fails the checksum.
  assert.equal(validateGstin('27ABCDE1234F1Z5').error, 'checksum');
});

test('every single-character typo is caught', () => {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const [gstin] of KNOWN_VALID) {
    for (let i = 0; i < 15; i += 1) {
      for (const char of alphabet) {
        if (char === gstin[i]) continue;
        const typo = gstin.slice(0, i) + char + gstin.slice(i + 1);
        assert.equal(isValidGstin(typo, { allowSpecial: true }), false, `${typo} should fail`);
      }
    }
  }
});

test('structural errors are named', () => {
  assert.equal(validateGstin('27AAPFU0939F1Z').error, 'length');
  assert.equal(validateGstin('').error, 'length');
  assert.equal(validateGstin(null).error, 'length');
  assert.equal(validateGstin('27AAPFU0939F1Z@').error, 'characters');
  assert.equal(validateGstin(withCheck('00AAPFU0939F1Z')).error, 'state_code');
  assert.equal(validateGstin(withCheck('40AAPFU0939F1Z')).error, 'state_code');
  assert.equal(validateGstin(withCheck('27AAPFU0939F1A')).error, 'format', '14th character must be Z');
  assert.equal(validateGstin(withCheck('27AAPFU0939F0Z')).error, 'format', 'entity number cannot be 0');
  assert.equal(validateGstin(withCheck('271APFU0939F1Z')).error, 'format', 'PAN must start with five letters');
});

test('entity numbers run 1-9 then A-Z', () => {
  assert.equal(isValidGstin(withCheck('27AAPFU0939F9Z')), true);
  assert.equal(isValidGstin(withCheck('27AAPFU0939FAZ')), true);
  assert.equal(validateGstin(withCheck('27AAPFU0939FKZ')).entityNumber, 'K');
});

test('special registrations need allowSpecial', () => {
  const uin = withCheck('0717UNO00157UN');
  assert.equal(validateGstin(uin).error, 'format');
  const special = validateGstin(uin, { allowSpecial: true });
  assert.equal(special.valid, true);
  assert.equal(special.kind, 'special');
  assert.equal(special.pan, null);
  assert.equal(special.stateCode, '07');
  const centre = withCheck('9917USA00001OS');
  assert.equal(validateGstin(centre).error, 'state_code');
  assert.equal(validateGstin(centre, { allowSpecial: true }).valid, true);
  assert.equal(validateGstin(uin.slice(0, 14) + (uin[14] === 'A' ? 'B' : 'A'), { allowSpecial: true }).error, 'checksum');
});

test('PAN and state code helpers', () => {
  assert.equal(panFromGstin('27AAPFU0939F1ZV'), 'AAPFU0939F');
  assert.equal(panFromGstin('27AAPFU0939F1ZA'), null);
  assert.equal(stateCodeFromGstin('33GSPTN3382G1Z4'), '33');
  assert.equal(stateCodeFromGstin('nonsense'), null);
  assert.equal(isValidPan('aapfu0939f'), true);
  assert.equal(isValidPan('AAPFU0939'), false);
  assert.equal(validateGstin(withCheck('29AABCT1332L1Z')).panHolderType, 'company');
  assert.equal(validateGstin(withCheck('29ABCPK1234L1Z')).panHolderType, 'individual');
});

test('the state code table', () => {
  const codes = STATE_CODES.map((s) => s.code);
  assert.equal(new Set(codes).size, codes.length, 'codes are unique');
  assert.ok(codes.every((c) => /^\d{2}$/.test(c)));
  assert.equal(stateByCode('7')?.name, 'Delhi');
  assert.equal(stateByCode(27)?.name, 'Maharashtra');
  assert.equal(stateByCode('36')?.name, 'Telangana');
  assert.equal(stateByCode('37')?.name, 'Andhra Pradesh');
  assert.equal(stateByCode('38')?.name, 'Ladakh');
  assert.equal(stateByCode('96'), null, '96 is the place-of-supply code for outside India, not a state');
  assert.equal(OUTSIDE_INDIA_CODE, '96');
  assert.equal(stateByCode('xx'), null);
  assert.equal(normaliseStateCode(' 9 '), '09');
  assert.equal(normaliseStateCode('123'), null);
});

test('UTs without a legislature charge UTGST; Delhi, Puducherry and J&K charge SGST', () => {
  for (const code of ['04', '26', '31', '35', '38', '97']) assert.equal(stateByCode(code)?.localTax, 'UTGST', code);
  for (const code of ['01', '07', '34', '27', '29']) assert.equal(stateByCode(code)?.localTax, 'SGST', code);
});

test('retired and centre codes are not valid places of supply by default', () => {
  assert.equal(isValidStateCode('27'), true);
  assert.equal(isValidStateCode('28'), false);
  assert.equal(isValidStateCode('25'), false);
  assert.equal(isValidStateCode('28', { allowRetired: true }), true);
  assert.equal(isValidStateCode('99'), false);
  assert.equal(isValidStateCode('99', { allowCentre: true }), true);
  assert.equal(isValidStateCode('96'), false);
  assert.equal(isValidStateCode('00'), false);
});
