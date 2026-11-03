import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { AppError } from './errorHandler.js';
import { hashKey, type Client } from '../services/integration.service.js';

// Machine-to-machine auth for /api/v1/integrations: `X-API-Key` header only (never a query
// param — URLs end up in logs). Rate limits are in-memory, like the login throttle.

const WINDOW_MS = 60_000;
const MAX_PER_CLIENT = 120; // per minute
const MAX_BAD_KEYS_PER_IP = 20; // per minute

type Bucket = { count: number; resetAt: number };
const perClient = new Map<string, Bucket>();
const badKeys = new Map<string, Bucket>();

function hit(map: Map<string, Bucket>, key: string) {
  const now = Date.now();
  const b = map.get(key);
  if (!b || b.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS };
    map.set(key, fresh);
    return fresh.count;
  }
  return ++b.count;
}

setInterval(() => {
  const now = Date.now();
  for (const m of [perClient, badKeys]) for (const [k, b] of m) if (b.resetAt <= now) m.delete(k);
}, WINDOW_MS).unref();

declare module 'express-serve-static-core' {
  interface Request {
    integrationClient?: Client;
  }
}

export const authenticateIntegration = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const ip = req.ip ?? 'unknown';
  const key = req.get('x-api-key');
  if ((badKeys.get(ip)?.count ?? 0) >= MAX_BAD_KEYS_PER_IP && (badKeys.get(ip)?.resetAt ?? 0) > Date.now()) {
    throw new AppError('Too many invalid API keys. Try again in a minute.', 429);
  }
  const client = key
    ? await prisma.integrationClient.findUnique({
        where: { keyHash: hashKey(key) },
        select: { id: true, name: true, systemUserId: true, isActive: true, lastUsedAt: true },
      })
    : null;
  if (!client) {
    hit(badKeys, ip);
    throw new AppError('Missing or invalid API key.', 401);
  }
  if (!client.isActive) throw new AppError('This API key has been disabled.', 403);
  if (hit(perClient, client.id) > MAX_PER_CLIENT) throw new AppError('Too many requests. Slow down and retry shortly.', 429);

  // at most once a minute — no write on every request
  if (!client.lastUsedAt || Date.now() - client.lastUsedAt.getTime() > WINDOW_MS) {
    await prisma.integrationClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } });
  }
  req.integrationClient = { id: client.id, name: client.name, systemUserId: client.systemUserId };
  next();
};
