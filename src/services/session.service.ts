import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { disconnectSessions } from '../lib/socket.js';

// Server-side sessions: one row per login. Tokens are only valid while their session is.
//  access token  { userId, sid }        15 min
//  refresh token { userId, sid, jti }   7 days, rotated on every refresh

const ACCESS_TTL = '15m';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 30_000; // two tabs refreshing at once both present the same cookie

export interface AccessPayload {
  userId: string;
  sid: string;
}

const signAccess = (userId: string, sid: string) => jwt.sign({ userId, sid }, config.jwtSecret, { expiresIn: ACCESS_TTL });
const signRefresh = (userId: string, sid: string, jti: string) =>
  jwt.sign({ userId, sid, jti }, config.jwtRefreshSecret, { expiresIn: REFRESH_TTL_MS / 1000 });

export async function createSession(userId: string, userAgent?: string) {
  const jti = randomUUID();
  const session = await prisma.session.create({
    data: { userId, refreshJti: jti, expiresAt: new Date(Date.now() + REFRESH_TTL_MS), userAgent: userAgent?.slice(0, 300) },
  });
  return { accessToken: signAccess(userId, session.id), refreshToken: signRefresh(userId, session.id, jti) };
}

/** Throws 401 unless the access token's session is live and belongs to the token's user */
export async function verifyAccessToken(token: string): Promise<AccessPayload> {
  let decoded: AccessPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret) as AccessPayload;
  } catch {
    throw new AppError('Not authenticated. Invalid token.', 401);
  }
  if (!decoded.sid) throw new AppError('Session expired. Please sign in again.', 401); // pre-session tokens
  const session = await prisma.session.findUnique({ where: { id: decoded.sid }, select: { userId: true, revokedAt: true, expiresAt: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== decoded.userId) {
    throw new AppError('Session expired. Please sign in again.', 401);
  }
  return decoded;
}

/** New access token + rotated refresh token; replaying an old refresh token revokes the session */
export async function rotateSession(refreshToken: string) {
  let decoded: { userId: string; sid?: string; jti?: string };
  try {
    decoded = jwt.verify(refreshToken, config.jwtRefreshSecret) as typeof decoded;
  } catch {
    throw new AppError('Invalid or expired refresh token.', 401);
  }
  if (!decoded.sid || !decoded.jti) throw new AppError('Session expired. Please sign in again.', 401);

  const session = await prisma.session.findUnique({ where: { id: decoded.sid }, include: { user: { select: { isActive: true } } } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== decoded.userId) {
    throw new AppError('Session expired. Please sign in again.', 401);
  }
  if (!session.user.isActive) {
    await revokeSession(session.id);
    throw new AppError('Account is deactivated.', 403);
  }

  if (decoded.jti === session.refreshJti) {
    const jti = randomUUID();
    // conditional update: if another request rotated it a moment ago, fall through to the grace check
    const { count } = await prisma.session.updateMany({
      where: { id: session.id, refreshJti: decoded.jti },
      data: { prevJti: decoded.jti, refreshJti: jti, rotatedAt: new Date() },
    });
    if (count === 1) {
      return { accessToken: signAccess(session.userId, session.id), refreshToken: signRefresh(session.userId, session.id, jti) };
    }
    const fresh = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    return { accessToken: signAccess(session.userId, session.id), refreshToken: signRefresh(session.userId, session.id, fresh.refreshJti) };
  }

  const inGrace =
    decoded.jti === session.prevJti && session.rotatedAt && Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;
  if (inGrace) {
    return {
      accessToken: signAccess(session.userId, session.id),
      refreshToken: signRefresh(session.userId, session.id, session.refreshJti),
    };
  }

  // An old refresh token came back after it was rotated out — someone else has a copy
  await revokeSession(session.id);
  throw new AppError('Session expired. Please sign in again.', 401);
}

export async function revokeSession(sid: string) {
  await prisma.session.updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: new Date() } });
  disconnectSessions([sid]);
}

/** Password change / deactivation / delete: sign the user out everywhere */
export async function revokeAllSessions(userId: string) {
  const live = await prisma.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  disconnectSessions(live.map((s) => s.id));
}

/** Best-effort: which session a (possibly expired) token belongs to — for logout */
export function sessionIdOf(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  try {
    const d = jwt.verify(token, secret, { ignoreExpiration: true }) as { sid?: string };
    return d.sid ?? null;
  } catch {
    return null;
  }
}
