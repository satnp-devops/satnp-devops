import { VALIDATE_SCHEMAS } from '../../lib/validate.js';
import { describeOf, mergeDescriptions } from './describe.js';

/**
 * Records every route a module registers, so the OpenAPI document is generated from the code
 * that actually runs. Modules keep defining routes exactly as before: app.js hands each module
 * a wrapped router instead of the real one, and the wrapper forwards every call unchanged.
 *
 *   const collector = createRouteCollector();
 *   for (const mod of modules) mod.routes?.(collector.wrap(api, mod.name), { registry });
 *   collector.routes  // [{ method, path, module, schemas, description }]
 */

/** Router methods that register a route. `all` is recorded but left out of the spec. */
export const ROUTE_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/**
 * @typedef {import('./describe.js').RouteDescription} RouteDescription
 * @typedef {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} RouteSchemas
 * @typedef {{
 *   method: string,
 *   path: string,
 *   module: string,
 *   schemas: RouteSchemas,
 *   description: RouteDescription,
 *   order: number,
 * }} CollectedRoute
 */

/**
 * Flatten Express handler arguments (handlers may be nested arrays).
 * @param {unknown[]} handlers
 * @returns {Function[]}
 */
export function flattenHandlers(handlers) {
  return handlers.flat(Infinity).filter((h) => typeof h === 'function');
}

/**
 * What a route's middleware say about it: the validate() schemas and describe() metadata.
 * When validate() appears twice, the later call's parts win, as they do on req.valid.
 * @param {unknown[]} handlers
 * @returns {{ schemas: RouteSchemas, description: RouteDescription }}
 */
export function inspectHandlers(handlers) {
  /** @type {RouteSchemas} */
  let schemas = {};
  const descriptions = [];
  for (const fn of flattenHandlers(handlers)) {
    const validated = fn[VALIDATE_SCHEMAS];
    if (validated) schemas = { ...pick(validated) };
    const described = describeOf(fn);
    if (described) descriptions.push(described);
  }
  return { schemas, description: mergeDescriptions(...descriptions) };
}

function pick(schemas) {
  /** @type {RouteSchemas} */
  const out = {};
  for (const part of ['params', 'query', 'body']) if (schemas[part]) out[part] = schemas[part];
  return out;
}

/**
 * @param {{ onWarning?: (message: string) => void }} [options]
 */
export function createRouteCollector({ onWarning } = {}) {
  /** @type {CollectedRoute[]} */
  const routes = [];
  /** @type {string[]} */
  const warnings = [];
  let order = 0;

  const warn = (message) => {
    warnings.push(message);
    onWarning?.(message);
  };

  /**
   * Record one route registration.
   * @param {string} method
   * @param {unknown} path a string, or an array of strings (Express allows both)
   * @param {unknown[]} handlers
   * @param {string} module
   */
  function record(method, path, handlers, module) {
    const paths = Array.isArray(path) ? path : [path];
    const { schemas, description } = inspectHandlers(handlers);
    for (const p of paths) {
      if (typeof p !== 'string') {
        warn(`${module}: ${method.toUpperCase()} ${String(p)} uses a non-string path and is not documented`);
        continue;
      }
      if (method === 'all') warn(`${module}: ALL ${p} matches every method and is not documented`);
      routes.push({ method, path: p, module, schemas, description, order: order++ });
    }
  }

  /**
   * Wrap a Route returned by router.route(path) so its .get()/.post() calls are recorded.
   */
  function wrapRoute(route, path, module) {
    const proxy = new Proxy(route, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, target);
        if (typeof prop !== 'string' || !ROUTE_METHODS.includes(prop) || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...handlers) => {
          const result = Reflect.apply(value, target, handlers);
          record(prop, path, handlers, module);
          return result === target ? receiver : result;
        };
      },
    });
    return proxy;
  }

  /**
   * A stand-in for `router` that records registrations and forwards every call unchanged.
   * Calls are applied to the real router (not the proxy), so Express's own internal
   * this.route() calls aren't recorded twice.
   * @template {object} R
   * @param {R} router
   * @param {string} module the registering module's name
   * @returns {R}
   */
  function wrap(router, module) {
    if (!module) throw new Error('wrap(router, module) needs the module name');
    const proxy = new Proxy(router, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        if (ROUTE_METHODS.includes(prop)) {
          return (path, ...handlers) => {
            // router.get('x') with no handlers is a settings lookup on apps; nothing to record.
            // Forward first: if Express refuses the path, nothing is recorded.
            const result = Reflect.apply(value, target, [path, ...handlers]);
            if (handlers.length > 0) record(prop, path, handlers, module);
            return result === target ? proxy : result;
          };
        }
        if (prop === 'route') {
          return (path) => {
            const route = Reflect.apply(value, target, [path]);
            if (typeof path !== 'string') {
              warn(`${module}: router.route(${String(path)}) uses a non-string path and is not documented`);
              return route;
            }
            return wrapRoute(route, path, module);
          };
        }
        if (prop === 'use') {
          return (...args) => {
            if (args.some((arg) => typeof arg === 'function' && Array.isArray(arg.stack))) {
              warn(`${module}: routes on a mounted sub-router are not documented; register them on the router you are given`);
            }
            const result = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          };
        }
        return (...args) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  }

  return { routes, warnings, wrap, record };
}
