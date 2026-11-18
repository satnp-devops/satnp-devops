import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeSchema, emailSchema, webUrlSchema } from '../src/lib/schemas.js';

test('web links must be http or https', () => {
  assert.ok(webUrlSchema.safeParse('https://satnpaper.example/logo.png').success);
  assert.ok(webUrlSchema.safeParse('http://localhost:3000').success);
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://files.example', 'not a url']) {
    assert.equal(webUrlSchema.safeParse(unsafe).success, false, unsafe);
  }
});

test('emails are trimmed and lowercased; codes are slugs', () => {
  assert.equal(emailSchema.parse('  Owner@Phoenix.TEST '), 'owner@phoenix.test');
  assert.equal(codeSchema.parse(' Pune-Centre '), 'pune-centre');
  assert.equal(codeSchema.safeParse('two--hyphens').success, false);
});
