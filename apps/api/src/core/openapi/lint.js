import { templateParams } from './paths.js';

/**
 * A small structural check of an OpenAPI 3.1 document: the rules that matter for the documents
 * buildSpec makes, without a validator dependency. Returns a list of problems (empty = fine).
 * Rules follow https://spec.openapis.org/oas/v3.1.1.html (sections noted inline).
 *
 * @param {any} doc
 * @returns {string[]}
 */
export function lintSpec(doc) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!doc || typeof doc !== 'object') return ['The document is not an object'];
  try {
    JSON.parse(JSON.stringify(doc));
  } catch (err) {
    fail(`The document is not serialisable as JSON: ${err.message}`);
  }

  // 4.8.1 OpenAPI Object: openapi, info are required; paths, components or webhooks must exist.
  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) fail('openapi must be "3.1.x"');
  if (!doc.info || typeof doc.info.title !== 'string' || !doc.info.title) fail('info.title is required');
  if (!doc.info || typeof doc.info.version !== 'string' || !doc.info.version) fail('info.version is required');
  if (!doc.paths && !doc.components && !doc.webhooks) fail('One of paths, components or webhooks is required');

  const operationIds = new Map();
  const tagNames = new Set((doc.tags ?? []).map((t) => t.name));
  const schemes = new Set(Object.keys(doc.components?.securitySchemes ?? {}));

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    // 4.8.8 Paths Object: keys start with "/".
    if (!path.startsWith('/')) fail(`Path "${path}" must start with "/"`);
    const names = templateParams(path);
    if (new Set(names).size !== names.length) fail(`Path "${path}" repeats a parameter`);

    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) continue;
      const where = `${method.toUpperCase()} ${path}`;

      // 4.8.10 Operation Object: operationId unique across the document.
      if (op.operationId) {
        if (operationIds.has(op.operationId)) fail(`${where}: operationId "${op.operationId}" is also used by ${operationIds.get(op.operationId)}`);
        operationIds.set(op.operationId, where);
      }

      // 4.8.12.1 Parameter Object: path params are required and must match the template.
      const params = op.parameters ?? [];
      const seen = new Set();
      for (const p of params) {
        if (!p.name || !p.in) fail(`${where}: a parameter needs name and in`);
        const key = `${p.in}:${p.name}`;
        if (seen.has(key)) fail(`${where}: parameter ${key} is listed twice`);
        seen.add(key);
        if (p.in === 'path' && p.required !== true) fail(`${where}: path parameter "${p.name}" must be required`);
        if (p.in === 'path' && !names.includes(p.name)) fail(`${where}: path parameter "${p.name}" is not in the path`);
        if (!p.schema && !p.content) fail(`${where}: parameter "${p.name}" needs a schema`);
      }
      for (const name of names) {
        if (!params.some((p) => p.in === 'path' && p.name === name)) fail(`${where}: {${name}} has no parameter`);
      }

      // 4.8.16 Responses Object: at least one response.
      if (!op.responses || Object.keys(op.responses).length === 0) fail(`${where}: no responses`);
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        if (status !== 'default' && !/^[1-5](\d\d|XX)$/.test(status)) fail(`${where}: response key "${status}" is not a status`);
        if (!response.$ref && typeof response.description !== 'string') fail(`${where}: response ${status} needs a description`);
      }

      for (const tag of op.tags ?? []) if (!tagNames.has(tag)) fail(`${where}: tag "${tag}" is not declared in tags`);
      for (const requirement of op.security ?? []) {
        for (const scheme of Object.keys(requirement)) {
          if (!schemes.has(scheme)) fail(`${where}: security scheme "${scheme}" is not declared`);
        }
      }
    }
  }

  // Every local $ref points at something.
  for (const ref of collectRefs(doc)) {
    if (!ref.startsWith('#/')) continue;
    if (resolvePointer(doc, ref) === undefined) fail(`$ref "${ref}" points at nothing`);
  }

  return problems;
}

/** Every $ref string in the tree. */
export function collectRefs(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.add(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

/**
 * Resolve a JSON pointer like #/components/schemas/Unit (RFC 6901).
 * @param {any} doc
 * @param {string} ref
 */
export function resolvePointer(doc, ref) {
  let node = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}
