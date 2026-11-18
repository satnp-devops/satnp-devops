import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { NextConfig } from 'next';

// Next.js only reads env files from apps/web, so load the shared one at the repo root too.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  const values = parseEnv(readFileSync(rootEnv, 'utf8')) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// The browser talks to /api/v1 on the same origin; Next forwards it to the API server.
// Same-origin requests keep the session cookie simple (HttpOnly, SameSite=Lax, no CORS).
const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        // Everything except the hosted intake forms (/f/<key>), which websites embed in an iframe.
        source: '/((?!f/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        source: '/f/:key*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
