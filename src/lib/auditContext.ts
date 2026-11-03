import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

// Who is doing the current request — read by the audit log (lib/prisma.ts) without passing the
// user through every service. Set per request; `authenticate` / the integration key fill in actor.

export interface AuditActor {
  id: string | null;
  name: string;
  email?: string | null;
  role: string; // UserRole, or SYSTEM / API
}

export interface AuditContext {
  actor?: AuditActor;
  ip?: string;
  userAgent?: string;
  skip?: boolean; // internal housekeeping that shouldn't appear in the log
}

const storage = new AsyncLocalStorage<AuditContext>();
const byRequest = new WeakMap<Request, AuditContext>();

export const auditContext = () => storage.getStore();

/** Every request gets its own context. Stream-based middleware (body parsers, multer) runs
 *  `next` from a stream callback, which drops it — use this again after them; it re-enters the
 *  request's existing context (actor included). */
export function auditContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  let ctx = byRequest.get(req);
  if (!ctx) {
    ctx = { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) };
    byRequest.set(req, ctx);
  }
  storage.run(ctx, next);
}

export function setAuditActor(actor: AuditActor) {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

/** Runs `fn` without recording its writes (e.g. upgrading a password hash on login) */
export function withoutAudit<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...(storage.getStore() ?? {}), skip: true }, fn);
}
