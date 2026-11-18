import { fileURLToPath } from 'node:url';
import knex from 'knex';
import pg from 'pg';
import { env } from '../config/env.js';

// Postgres `date` columns (expected close dates, dates of birth) are calendar dates, not instants.
// Keep them as "YYYY-MM-DD" strings; pg would otherwise build a Date at local midnight, which shifts
// the day when serialised to UTC. (OID 1082 = date.)
pg.types.setTypeParser(1082, (value) => value);

export const db = knex({
  client: 'pg',
  connection: env.DATABASE_URL,
  pool: { min: 0, max: env.DB_POOL_MAX },
  migrations: {
    directory: fileURLToPath(new URL('../db/migrations', import.meta.url)),
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
  seeds: {
    directory: fileURLToPath(new URL('../db/seeds', import.meta.url)),
    loadExtensions: ['.js'],
  },
});

/** Postgres error codes we translate into friendly API errors. */
export const PG = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
});

/** JSON for jsonb columns. pg would turn JS arrays into Postgres arrays, so always stringify. */
export const json = (value) => JSON.stringify(value ?? null);
