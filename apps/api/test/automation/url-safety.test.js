import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIp,
  checkResolvedAddresses,
  checkWebhookUrl,
  checkWebhookUrlTemplate,
  isBlockedIp,
  parseIPv4,
  parseIPv6,
} from '../../src/core/automation/url-safety.js';

const refused = (url, code, options) => {
  const result = checkWebhookUrl(url, options);
  assert.equal(result.ok, false, `${url} should be refused`);
  if (code) assert.equal(result.code, code, `${url}: ${result.message}`);
  return result;
};

test('public https links pass and come back normalised', () => {
  assert.deepEqual(checkWebhookUrl('https://hooks.example.com/phoenix?x=1'), {
    ok: true,
    url: 'https://hooks.example.com/phoenix?x=1',
    host: 'hooks.example.com',
    port: 443,
  });
  assert.equal(checkWebhookUrl('https://HOOKS.Example.com:8443/a').host, 'hooks.example.com');
  assert.equal(checkWebhookUrl('https://hooks.example.com:8443/a').port, 8443);
  assert.ok(checkWebhookUrl('https://8.8.8.8/hook').ok, 'public IPv4 literal');
  assert.ok(checkWebhookUrl('https://[2606:4700:4700::1111]/hook').ok, 'public IPv6 literal');
  assert.ok(checkWebhookUrl('https://example.com./').ok, 'trailing dot');
});

test('only https by default; no other schemes, credentials or junk', () => {
  refused('http://hooks.example.com/', 'URL_SCHEME');
  assert.ok(checkWebhookUrl('http://hooks.example.com/', { allowHttp: true }).ok);
  for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/plain,hi', 'ws://example.com/']) {
    refused(url, 'URL_SCHEME');
  }
  refused('https://user:pass@example.com/', 'URL_CREDENTIALS');
  refused('https://user@example.com/', 'URL_CREDENTIALS');
  refused('example.com/hook', 'URL_INVALID');
  refused('', 'URL_INVALID');
  refused('https://exa mple.com/', 'URL_INVALID');
  refused('https://example.com/\n', 'URL_INVALID');
  refused('https:\\\\127.0.0.1\\', 'URL_INVALID');
  refused(`https://example.com/${'a'.repeat(2100)}`, 'URL_INVALID');
  refused(42, 'URL_INVALID');
});

test('loopback, private, link-local, metadata and reserved IPv4 literals are refused', () => {
  for (const host of [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.100.100.200', '192.0.0.192', '192.0.2.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ]) {
    refused(`https://${host}/`, 'URL_PRIVATE_ADDRESS');
  }
  assert.ok(checkWebhookUrl('https://172.32.0.1/').ok, 'just outside 172.16/12');
  assert.ok(checkWebhookUrl('https://100.128.0.1/').ok, 'just outside 100.64/10');
});

test('IPv4 written in hex, octal, decimal or short form is normalised and still refused', () => {
  for (const host of ['0x7f.1', '0x7f000001', '2130706433', '017700000001', '0177.0.0.1', '127.1', '127.0.1', '0', '0x0', '0xA9FEA9FE', '2852039166']) {
    const result = refused(`https://${host}/`, 'URL_PRIVATE_ADDRESS');
    assert.match(result.message, /loopback|this network|link-local/);
  }
});

test('IPv6 loopback, unique-local, link-local, multicast and embedded IPv4 forms are refused', () => {
  for (const host of [
    '[::1]', '[::]', '[0:0:0:0:0:0:0:1]', '[fc00::1]', '[fd12:3456::1]', '[fd00:ec2::254]', '[fe80::1]', '[febf::1]',
    '[fec0::1]', '[ff02::1]', '[2001:db8::1]', '[2001::1]', '[100::1]', '[64:ff9b:1::1]', '[3fff::1]',
    // IPv4-mapped and translated forms of private addresses
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::ffff:169.254.169.254]',
    '[::ffff:a9fe:a9fe]', '[::ffff:0:127.0.0.1]', '[::ffff:192.168.0.1]',
    // NAT64 and 6to4 wrapping private IPv4
    '[64:ff9b::127.0.0.1]', '[64:ff9b::a9fe:a9fe]', '[2002:7f00:1::]', '[2002:c0a8:101::1]',
    // IPv4-compatible (deprecated)
    '[::127.0.0.1]', '[::8.8.8.8]',
  ]) {
    refused(`https://${host}/`, 'URL_PRIVATE_ADDRESS');
  }
  refused('https://[fe80::1%25eth0]/', 'URL_INVALID');
  assert.ok(checkWebhookUrl('https://[::ffff:8.8.8.8]/').ok, 'IPv4-mapped public address');
  assert.ok(checkWebhookUrl('https://[64:ff9b::808:808]/').ok, 'NAT64 of a public address');
  assert.ok(checkWebhookUrl('https://[2002:808:808::1]/').ok, '6to4 of a public address');
});

test('internal host names are refused', () => {
  for (const host of [
    'localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'metadata.google.internal', 'api.internal',
    'db.corp', 'router.lan', 'nas.home.arpa', 'localhost.localdomain', 'intranet', 'metadata', 'ip6-localhost',
    '1.0.0.127.in-addr.arpa',
  ]) {
    refused(`https://${host}/hook`, 'URL_PRIVATE_HOST');
  }
});

test('host and port allow-lists', () => {
  const options = { allowedHosts: ['hooks.zapier.com', '*.example.com'] };
  assert.ok(checkWebhookUrl('https://hooks.zapier.com/x', options).ok);
  assert.ok(checkWebhookUrl('https://a.b.example.com/x', options).ok);
  refused('https://example.com/x', 'URL_HOST_NOT_ALLOWED', options);
  refused('https://evilexample.com/x', 'URL_HOST_NOT_ALLOWED', options);
  refused('https://hooks.zapier.com.evil.io/x', 'URL_HOST_NOT_ALLOWED', options);
  refused('https://hooks.example.com:22/', 'URL_PORT', { allowedPorts: [443] });
  assert.ok(checkWebhookUrl('https://hooks.example.com/', { allowedPorts: [443] }).ok);
});

test('links with {{ }} must keep a fixed, safe origin', () => {
  assert.ok(checkWebhookUrlTemplate('https://api.example.com/deals/{{ record.id }}').ok);
  assert.equal(checkWebhookUrlTemplate('https://api.example.com/deals/{{ record.id }}').url, 'https://api.example.com/deals/{{ record.id }}');
  assert.equal(checkWebhookUrlTemplate('https://{{ record.host }}/x').code, 'URL_DYNAMIC_HOST');
  assert.equal(checkWebhookUrlTemplate('https://api.{{ record.host }}.com/x').code, 'URL_DYNAMIC_HOST');
  assert.equal(checkWebhookUrlTemplate('{{ record.url }}').code, 'URL_DYNAMIC_HOST');
  assert.equal(checkWebhookUrlTemplate('https://example.com{{ record.path }}').code, 'URL_DYNAMIC_HOST', 'port or host could still change');
  assert.equal(checkWebhookUrlTemplate('https://127.0.0.1/{{ x }}').code, 'URL_PRIVATE_ADDRESS');
  assert.equal(checkWebhookUrlTemplate('http://example.com/{{ x }}').code, 'URL_SCHEME');
  assert.ok(checkWebhookUrlTemplate('https://hooks.example.com/plain').ok, 'no template: plain check');
});

test('resolved addresses (for the executor): every answer must be public', () => {
  assert.deepEqual(checkResolvedAddresses(['93.184.216.34', '2606:2800:220:1::1']), { ok: true, addresses: ['93.184.216.34', '2606:2800:220:1::1'] });
  assert.ok(checkResolvedAddresses([{ address: '8.8.8.8', family: 4 }]).ok, 'dns.lookup({ all: true }) shape');
  const rebinding = checkResolvedAddresses(['93.184.216.34', '127.0.0.1']);
  assert.equal(rebinding.ok, false);
  assert.equal(rebinding.code, 'URL_PRIVATE_ADDRESS');
  assert.equal(rebinding.blocked[0].address, '127.0.0.1');
  assert.equal(checkResolvedAddresses([]).code, 'URL_NO_ADDRESS');
  assert.equal(checkResolvedAddresses(['::ffff:169.254.169.254']).ok, false);
});

test('checkIp fails closed on anything that is not a canonical address', () => {
  for (const bad of ['0177.0.0.1', '127.1', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', ' 8.8.8.8', 'example.com', '', null, '1::2::3', '12345::1', 'fe80::1%eth0', ':::1']) {
    assert.equal(isBlockedIp(bad), true, String(bad));
  }
  assert.equal(checkIp('8.8.8.8').blocked, false);
  assert.equal(checkIp('8.8.8.8').version, 4);
  assert.equal(checkIp('2606:4700:4700::1111').version, 6);
  assert.equal(checkIp('4000::1').blocked, true, 'outside global unicast');
  assert.equal(checkIp('::ffff:8.8.8.8').mappedIPv4, '8.8.8.8');
  assert.match(checkIp('::ffff:127.0.0.1').reason, /IPv4-mapped 127\.0\.0\.1: loopback/);
});

test('address parsers', () => {
  assert.equal(parseIPv4('192.168.1.1'), 0xc0a80101);
  assert.equal(parseIPv4('255.255.255.255'), 0xffffffff);
  assert.equal(parseIPv4('1.2.3.04'), null);
  assert.equal(parseIPv6('::1'), 1n);
  assert.equal(parseIPv6('[::1]'), 1n);
  assert.equal(parseIPv6('::'), 0n);
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8'), 0x00010002000300040005000600070008n);
  assert.equal(parseIPv6('1:2:3:4:5:6:7::'), 0x00010002000300040005000600070000n);
  assert.equal(parseIPv6('::ffff:1.2.3.4'), 0xffff01020304n);
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8::'), null);
  assert.equal(parseIPv6('g::1'), null);
  assert.equal(parseIPv6('1.2.3.4'), null);
});
