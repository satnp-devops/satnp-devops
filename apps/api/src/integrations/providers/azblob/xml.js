/**
 * Just enough XML for the Blob REST API: read a few flat elements from small, trusted-shape
 * responses (error bodies, the user delegation key) and escape values we put into request bodies.
 * Not a general XML parser; it ignores attributes, namespaces and nesting depth on purpose.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** @param {string} text */
export function decodeXmlText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** @param {string} text */
export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&${Object.keys(ENTITIES).find((k) => ENTITIES[k] === ch)};`);
}

/**
 * Text content of the first <tag>...</tag>, decoded; undefined when absent.
 * @param {string} xml
 * @param {string} tag element name without namespace prefix
 */
export function xmlElement(xml, tag) {
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}>`).exec(
    String(xml ?? ''),
  );
  return match ? decodeXmlText(match[1].trim()) : undefined;
}

/**
 * Azure Storage error body: <Error><Code>BlobNotFound</Code><Message>...</Message></Error>
 * @param {string} xml
 */
export function parseErrorXml(xml) {
  return { code: xmlElement(xml, 'Code'), message: xmlElement(xml, 'Message') };
}

/**
 * Get User Delegation Key response body.
 * @param {string} xml
 * @returns {import('./sas.js').UserDelegationKey}
 */
export function parseUserDelegationKeyXml(xml) {
  return {
    signedObjectId: xmlElement(xml, 'SignedOid'),
    signedTenantId: xmlElement(xml, 'SignedTid'),
    signedStart: xmlElement(xml, 'SignedStart'),
    signedExpiry: xmlElement(xml, 'SignedExpiry'),
    signedService: xmlElement(xml, 'SignedService'),
    signedVersion: xmlElement(xml, 'SignedVersion'),
    signedDelegatedUserTenantId: xmlElement(xml, 'SignedDelegatedUserTid'),
    value: xmlElement(xml, 'Value'),
  };
}

/**
 * Get User Delegation Key request body.
 * @param {{ start: string, expiry: string, delegatedUserTenantId?: string }} keyInfo
 */
export function buildKeyInfoXml({ start, expiry, delegatedUserTenantId }) {
  const tid = delegatedUserTenantId ? `<DelegatedUserTid>${escapeXml(delegatedUserTenantId)}</DelegatedUserTid>` : '';
  return `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${escapeXml(start)}</Start><Expiry>${escapeXml(expiry)}</Expiry>${tid}</KeyInfo>`;
}
