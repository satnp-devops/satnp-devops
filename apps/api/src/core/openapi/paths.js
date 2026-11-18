/**
 * Express 5 route paths (path-to-regexp v8 syntax) to OpenAPI path templates.
 *
 *   /users/:id                    -> /users/{id}
 *   /files/*rest                  -> /files/{rest}          (a splat: one or more segments)
 *   /reports{/:year}              -> /reports and /reports/{year}   (optional groups expand)
 *   /:"quoted name"               -> /{quoted name}
 *   /price\:usd                   -> /price:usd             (escaped characters are literal)
 *
 * Source: https://github.com/pillarjs/path-to-regexp (v8 README, "Parameters", "Wildcard", "Optional").
 */

/**
 * @typedef {{ type: 'text', value: string }
 *   | { type: 'param', name: string }
 *   | { type: 'splat', name: string }
 *   | { type: 'group', tokens: Token[] }} Token
 * @typedef {{ name: string, splat: boolean }} PathParam
 * @typedef {{ path: string, params: PathParam[] }} OpenApiPath
 */

const ID_START = /[$_\p{ID_Start}]/u;
const ID_CONTINUE = /[$‌‍\p{ID_Continue}]/u;

/** At most this many variants from optional groups (2^n grows fast). */
const MAX_VARIANTS = 64;

/**
 * Tokenise an Express path.
 * @param {string} path
 * @returns {Token[]}
 */
export function tokenize(path) {
  let i = 0;

  /** @returns {Token[]} */
  function parse(closing) {
    /** @type {Token[]} */
    const tokens = [];
    let text = '';
    const flush = () => {
      if (text) tokens.push({ type: 'text', value: text });
      text = '';
    };

    while (i < path.length) {
      const ch = path[i];
      if (ch === '\\') {
        text += path[i + 1] ?? '';
        i += 2;
      } else if (ch === ':' || ch === '*') {
        flush();
        i += 1;
        const name = readName();
        if (!name) throw new Error(`Missing parameter name after "${ch}" in path "${path}"`);
        tokens.push({ type: ch === ':' ? 'param' : 'splat', name });
      } else if (ch === '{') {
        flush();
        i += 1;
        tokens.push({ type: 'group', tokens: parse('}') });
      } else if (ch === '}') {
        if (!closing) throw new Error(`Unexpected "}" in path "${path}"`);
        flush();
        i += 1;
        return tokens;
      } else {
        text += ch;
        i += 1;
      }
    }
    if (closing) throw new Error(`Unclosed "{" in path "${path}"`);
    flush();
    return tokens;
  }

  function readName() {
    if (path[i] === '"') {
      let name = '';
      i += 1;
      while (i < path.length && path[i] !== '"') {
        if (path[i] === '\\') i += 1;
        name += path[i] ?? '';
        i += 1;
      }
      if (path[i] !== '"') throw new Error(`Unterminated quoted parameter name in path "${path}"`);
      i += 1;
      return name;
    }
    let name = '';
    if (i < path.length && ID_START.test(path[i])) {
      name += path[i];
      i += 1;
      while (i < path.length && ID_CONTINUE.test(path[i])) {
        name += path[i];
        i += 1;
      }
    }
    return name;
  }

  return parse(null);
}

/**
 * Every flat token list an Express path can match, with optional groups taken or left out.
 * @param {Token[]} tokens
 * @returns {Array<Array<Exclude<Token, { type: 'group' }>>>}
 */
function expand(tokens) {
  /** @type {Array<Array<Exclude<Token, { type: 'group' }>>>} */
  let variants = [[]];
  for (const token of tokens) {
    if (token.type === 'group') {
      const inner = expand(token.tokens);
      const next = [];
      for (const head of variants) {
        next.push(head);
        for (const tail of inner) next.push([...head, ...tail]);
      }
      variants = next;
    } else {
      variants = variants.map((head) => [...head, token]);
    }
    if (variants.length > MAX_VARIANTS) throw new Error(`Too many optional groups to document (over ${MAX_VARIANTS} variants)`);
  }
  return variants;
}

/**
 * Join a router prefix and a route path without doubling or losing slashes.
 * @param {string} prefix
 * @param {string} path
 */
export function joinPaths(prefix, path) {
  if (!prefix) return path || '/';
  const left = prefix.replace(/\/+$/, '');
  const right = path.startsWith('/') || path.startsWith('{/') ? path : `/${path}`;
  return `${left}${right}` || '/';
}

/**
 * Express path -> OpenAPI path templates (several when it has optional groups).
 * A parameter repeated in one path keeps one entry.
 * @param {string} expressPath
 * @returns {OpenApiPath[]}
 */
export function toOpenApiPaths(expressPath) {
  if (typeof expressPath !== 'string') throw new TypeError('Only string paths can be documented');
  const seen = new Set();
  /** @type {OpenApiPath[]} */
  const out = [];
  for (const variant of expand(tokenize(expressPath))) {
    let path = '';
    /** @type {PathParam[]} */
    const params = [];
    for (const token of variant) {
      if (token.type === 'text') {
        path += token.value;
      } else {
        path += `{${token.name}}`;
        if (!params.some((p) => p.name === token.name)) params.push({ name: token.name, splat: token.type === 'splat' });
      }
    }
    path = normalise(path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, params });
  }
  return out;
}

/** Leading slash, no doubled slashes, no trailing slash except for the root. */
function normalise(path) {
  let out = path.replace(/\/{2,}/g, '/');
  if (!out.startsWith('/')) out = `/${out}`;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Names of the {params} in an OpenAPI path template.
 * @param {string} template
 */
export function templateParams(template) {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
