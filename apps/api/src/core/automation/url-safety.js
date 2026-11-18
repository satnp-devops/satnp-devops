/**
 * Target checks for the call-webhook action (server-side request forgery defence).
 *
 * checkWebhookUrl() is the static check, run when a flow is saved and again on the
 * resolved URL before an effect is handed to the executor. It is necessary but not
 * sufficient: a public-looking name can resolve to a private address. The executor
 * (wave 2) MUST also:
 *   1. resolve the host itself and run checkResolvedAddresses() on every answer;
 *   2. connect to the address it checked (pin it, e.g. a custom `lookup`), so a second
 *      DNS answer can't swap in a private address (DNS rebinding);
 *   3. not follow redirects (treat 3xx as the result), or re-run both checks per hop;
 *   4. ignore HTTP(S)_PROXY settings, cap the time (10 s) and response size (1 MB),
 *      and never forward cookies or internal headers.
 *
 * Address ranges follow the IANA special-purpose registries (RFC 6890 and updates):
 * IPv4 https://www.iana.org/assignments/iana-ipv4-special-registry/
 * IPv6 https://www.iana.org/assignments/iana-ipv6-special-registry/
 * plus cloud metadata endpoints (169.254.169.254, fd00:ec2::254, 100.100.100.200),
 * which all fall inside blocked ranges.
 */

/** [network, prefix length, reason] — IPv4 networks as dotted text. */
const IPV4_BLOCKED = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'shared address space (carrier NAT)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (includes cloud metadata 169.254.169.254)'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'AS112 service'],
  ['192.52.193.0', 24, 'AMT'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private network'],
  ['192.175.48.0', 24, 'AS112 service'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved (includes broadcast)'],
];

/** IPv6 networks. Embedded-IPv4 forms are handled separately below. */
const IPV6_BLOCKED = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'local-use IPv4/IPv6 translation'],
  ['100::', 64, 'discard-only'],
  ['100:0:0:1::', 64, 'dummy prefix'],
  ['2001::', 23, 'IETF protocol assignments (includes Teredo)'],
  ['2001:db8::', 32, 'documentation'],
  ['2001:20::', 28, 'ORCHIDv2'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'segment routing (SRv6) SIDs'],
  ['fc00::', 7, 'unique local (includes AWS metadata fd00:ec2::254)'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local (deprecated)'],
  ['ff00::', 8, 'multicast'],
];

const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'broadcasthost']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.arpa'];

/**
 * Strict dotted-decimal IPv4 (what resolvers return). Returns the 32-bit value or null.
 * @param {string} text
 */
export function parseIPv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    if (part.length > 1 && part[0] === '0') return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * IPv6 text (with optional brackets and an embedded dotted IPv4 tail) to a 128-bit BigInt.
 * Zone ids (fe80::1%eth0) are rejected. Returns null when the text isn't IPv6.
 * @param {string} input
 */
export function parseIPv6(input) {
  let text = input;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.length < 2 || text.length > 45 || text.includes('%') || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => {
    if (part === '') return [];
    const groups = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4(piece);
        if (v4 === null) return null;
        groups.push(Math.floor(v4 / 65536), v4 % 65536);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function inV4(value, [network, bits]) {
  const net = parseIPv4(network);
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(net / size);
}

const V6_NETS = IPV6_BLOCKED.map(([network, bits, reason]) => ({ net: parseIPv6(network), bits: BigInt(bits), reason }));

function inV6(value, net, bits) {
  const shift = 128n - bits;
  return value >> shift === net >> shift;
}

const v4Text = (value) => [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join('.');

function checkV4(value) {
  for (const range of IPV4_BLOCKED) {
    if (inV4(value, range)) return { blocked: true, version: 4, reason: range[2] };
  }
  return { blocked: false, version: 4 };
}

function checkV6(value) {
  const low32 = Number(value & 0xffffffffn);
  const embedded = (label) => {
    const inner = checkV4(low32);
    return inner.blocked ? { blocked: true, version: 6, reason: `${label} ${v4Text(low32)}: ${inner.reason}` } : null;
  };
  // ::ffff:a.b.c.d IPv4-mapped, and ::ffff:0:a.b.c.d IPv4-translated: judge the IPv4 address.
  if (value >> 32n === 0xffffn || value >> 32n === 0xffff0000n) {
    return embedded('IPv4-mapped') ?? { blocked: false, version: 6, mappedIPv4: v4Text(low32) };
  }
  // 64:ff9b::a.b.c.d NAT64 well-known prefix: judge the IPv4 address.
  if (value >> 32n === 0x64ff9b0000000000000000n) {
    return embedded('NAT64') ?? { blocked: false, version: 6, mappedIPv4: v4Text(low32) };
  }
  for (const { net, bits, reason } of V6_NETS) {
    if (inV6(value, net, bits)) return { blocked: true, version: 6, reason };
  }
  // ::a.b.c.d IPv4-compatible (deprecated) — never legitimate on the internet.
  if (value >> 32n === 0n) return { blocked: true, version: 6, reason: 'IPv4-compatible (deprecated)' };
  // 2002::/16 6to4 carries an IPv4 address in bits 16-47.
  if (value >> 112n === 0x2002n) {
    const v4 = Number((value >> 80n) & 0xffffffffn);
    const inner = checkV4(v4);
    if (inner.blocked) return { blocked: true, version: 6, reason: `6to4 ${v4Text(v4)}: ${inner.reason}` };
  }
  // Only global unicast (2000::/3) is routable on the public internet.
  if (value >> 125n !== 1n) return { blocked: true, version: 6, reason: 'not global unicast' };
  return { blocked: false, version: 6 };
}

/**
 * Whether an IP address must not be contacted. Anything that isn't a strictly
 * formatted IPv4 or IPv6 address is blocked (fail closed).
 * @param {string} address
 * @returns {{ blocked: boolean, version: 4 | 6 | null, reason?: string, mappedIPv4?: string }}
 */
export function checkIp(address) {
  if (typeof address !== 'string') return { blocked: true, version: null, reason: 'not an IP address' };
  const v4 = parseIPv4(address);
  if (v4 !== null) return checkV4(v4);
  const v6 = parseIPv6(address);
  if (v6 !== null) return checkV6(v6);
  return { blocked: true, version: null, reason: 'not an IP address' };
}

/** @param {string} address */
export const isBlockedIp = (address) => checkIp(address).blocked;

/**
 * For the executor, after DNS: every answer must be public, or the call is refused.
 * @param {(string | { address: string })[]} addresses as returned by dns.lookup(host, { all: true })
 */
export function checkResolvedAddresses(addresses) {
  const list = (addresses ?? []).map((a) => (typeof a === 'string' ? a : a?.address));
  if (list.length === 0) return { ok: false, code: 'URL_NO_ADDRESS', message: 'The host has no addresses', blocked: [] };
  const blocked = list.map((address) => ({ address, ...checkIp(address) })).filter((r) => r.blocked);
  if (blocked.length > 0) {
    return {
      ok: false,
      code: 'URL_PRIVATE_ADDRESS',
      message: `The host resolves to a blocked address (${blocked[0].address}: ${blocked[0].reason})`,
      blocked,
    };
  }
  return { ok: true, addresses: list };
}

function hostMatches(host, pattern) {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

const fail = (code, message) => ({ ok: false, code, message });

/**
 * Static checks for a webhook target.
 * @param {string} input
 * @param {{ allowHttp?: boolean, allowedHosts?: string[], allowedPorts?: number[] }} [options]
 *   allowHttp: permit http: (off by default; development only)
 *   allowedHosts: if given, the host must match one (exact, or *.example.com)
 *   allowedPorts: if given, the port must be one of these
 * @returns {{ ok: true, url: string, host: string, port: number } | { ok: false, code: string, message: string }}
 */
export function checkWebhookUrl(input, options = {}) {
  if (typeof input !== 'string' || input.trim() === '') return fail('URL_INVALID', 'Enter a link');
  if (input.length > 2048) return fail('URL_INVALID', 'The link is longer than 2048 characters');
  // eslint-disable-next-line no-control-regex
  const trimmed = input.replace(/^ +| +$/g, '');
  if (/[\u0000- \u007f\\]/.test(trimmed)) return fail('URL_INVALID', 'The link contains spaces, control characters or backslashes');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return fail('URL_INVALID', 'Enter a full link starting with https://');
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return fail('URL_SCHEME', options.allowHttp ? 'Use an http:// or https:// link' : 'Use an https:// link');
  }
  if (url.username || url.password) return fail('URL_CREDENTIALS', 'Links must not contain a user name or password; use a connection instead');
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return fail('URL_INVALID', 'The link has no host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (options.allowedPorts && !options.allowedPorts.includes(port)) return fail('URL_PORT', `Port ${port} is not allowed`);

  if (host.startsWith('[')) {
    const result = checkIp(host.slice(1, -1));
    if (result.blocked) return fail('URL_PRIVATE_ADDRESS', `The address ${host} is not allowed (${result.reason})`);
  } else if (/^[0-9.]+$/.test(host)) {
    // The URL parser has already turned 0x7f.1, 2130706433, 0177.0.0.1 and friends into dotted form.
    const result = checkIp(host);
    if (result.blocked) return fail('URL_PRIVATE_ADDRESS', `The address ${host} is not allowed (${result.reason})`);
  } else {
    if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return fail('URL_PRIVATE_HOST', `The host ${host} is internal`);
    }
    if (!host.includes('.')) return fail('URL_PRIVATE_HOST', `Use a full domain name, not "${host}"`);
  }
  if (options.allowedHosts && !options.allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    return fail('URL_HOST_NOT_ALLOWED', `The host ${host} is not on the allowed list`);
  }
  return { ok: true, url: url.href, host, port };
}

/**
 * For saved flows whose link contains {{ }}: everything before the first {{ must be a
 * fixed origin and path start (https://host/...), and that part must pass the checks.
 * @param {string} template
 * @param {Parameters<typeof checkWebhookUrl>[1]} [options]
 */
export function checkWebhookUrlTemplate(template, options = {}) {
  const cut = template.indexOf('{{');
  if (cut === -1) return checkWebhookUrl(template, options);
  const fixed = template.slice(0, cut);
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\//i.exec(fixed);
  if (!match) return fail('URL_DYNAMIC_HOST', 'The scheme and host of a link must be fixed; put {{ }} only after the first /');
  const result = checkWebhookUrl(match[0], options);
  return result.ok ? { ...result, url: template } : result;
}
