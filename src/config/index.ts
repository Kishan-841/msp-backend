import dotenv from 'dotenv';

dotenv.config();

// Refuse to start without the secrets — an empty secret would make every token invalid
// (or, with another library, forgeable). NODE_ENV defaults to production so a deploy that
// forgets it doesn't run in development mode (stack traces, non-secure cookie).
for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`Missing required environment variable ${key}`);
}

const sameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict or none');

export const config = {
  port: parseInt(process.env.PORT || '5001', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || '',
  // the frontend URL(s) allowed to call the API — comma-separated (e.g. production + a preview)
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
  nodeEnv: process.env.NODE_ENV || 'production',
  // Frontend and API on different sites (e.g. Vercel + our VM) → the refresh cookie must be
  // SameSite=None (which browsers only accept with Secure, i.e. over HTTPS)
  cookieSameSite: sameSite as 'lax' | 'strict' | 'none',
  // Behind a reverse proxy (Caddy / nginx): trust its X-Forwarded-For so rate limits see the
  // real client IP instead of the proxy's. Number of proxy hops; 0 = no proxy.
  trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
} as const;
