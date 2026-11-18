import assert from 'node:assert/strict';

/** Deterministic pseudo-random numbers (mulberry32) so property tests are reproducible. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Integer in [min, max]. */
  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  /** One item of a list. */
  next.pick = (list) => list[Math.floor(next() * list.length)];
  return next;
}

/** Assert a call throws the API's 422 validation error, optionally on a given field path. */
export function assertValidation(fn, path) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 422, `expected a 422, got ${error.status}: ${error.message}`);
    if (path) {
      const paths = (error.details ?? []).map((d) => d.path);
      assert.ok(
        paths.some((p) => p === path || p.startsWith(`${path}.`)),
        `expected an error on ${path}, got ${JSON.stringify(paths)}`,
      );
    }
    return true;
  });
}
