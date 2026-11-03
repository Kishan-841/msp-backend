import type { Request } from 'express';

// Server-side paging for list endpoints.
//  ?page=1&limit=20  →  { items, total, page, limit, totalPages, ...extra }
// No ?page  →  the endpoint keeps its old shape (plain array) for small per-record lookups
// (e.g. one party's invoices in a dialog). `limit` is capped so no request can pull a whole table.

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/** Parsed ?page / ?limit, or null when the caller didn't ask for a page */
export function pageParams(req: Request, defaultLimit = DEFAULT_LIMIT): PageParams | null {
  if (req.query.page === undefined) return null;
  const page = Math.max(1, int(req.query.page) ?? 1);
  const limit = clampLimit(req.query.limit, defaultLimit);
  return { page, limit, skip: (page - 1) * limit };
}

/** A limit from the query, defaulted and capped (also for endpoints that always page) */
export function clampLimit(raw: unknown, fallback = DEFAULT_LIMIT) {
  return Math.min(MAX_LIMIT, Math.max(1, int(raw) ?? fallback));
}

export function envelope<T, E extends object = object>(items: T[], total: number, p: PageParams, extra?: E) {
  return { items, total, page: p.page, limit: p.limit, totalPages: Math.max(1, Math.ceil(total / p.limit)), ...(extra ?? ({} as E)) };
}

/** Paging for lists that can only be computed in memory (e.g. "what's left to bill") */
export function pageArray<T, E extends object = object>(all: T[], p: PageParams, extra?: E) {
  return envelope(all.slice(p.skip, p.skip + p.limit), all.length, p, extra);
}

/** Free-text search param, trimmed and bounded */
export function searchParam(req: Request): string | undefined {
  const s = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  return s || undefined;
}

/** Start of today in IST, as a UTC instant — for "overdue" (due date before today) */
export function startOfTodayIST(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60_000);
}
