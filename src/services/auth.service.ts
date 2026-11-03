import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { createSession, rotateSession } from './session.service.js';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../utils/loginThrottle.js';
import { recordAuthEvent } from './audit.service.js';
import { setAuditActor, withoutAudit } from '../lib/auditContext.js';

// Compared against when the email doesn't exist, so a wrong email takes as long as a wrong
// password (response time can't reveal which emails have accounts).
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export async function loginUser(email: string, password: string, ip: string, userAgent?: string) {
  try {
    assertLoginAllowed(email, ip);
  } catch (err) {
    await recordAuthEvent('LOGIN_BLOCKED', { email }, { reason: 'Too many failed attempts' });
    throw err;
  }

  const user = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
  const isPasswordValid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  const who = user ? { id: user.id, name: user.name, email: user.email, role: user.role } : { email: email.trim() };
  if (!user || !isPasswordValid) {
    recordLoginFailure(email, ip);
    await recordAuthEvent('LOGIN_FAILED', who, { reason: user ? 'Wrong password' : 'No account with this email' });
    throw new AppError('Invalid email or password.', 401);
  }
  // only someone who knows the password learns the account is deactivated
  if (!user.isActive) {
    await recordAuthEvent('LOGIN_FAILED', who, { reason: 'Account deactivated' });
    throw new AppError('Account is deactivated. Contact an administrator.', 403);
  }
  setAuditActor({ id: user.id, name: user.name, email: user.email, role: user.role });
  recordLoginSuccess(email, ip);
  // Older hashes (e.g. seeded with 10 rounds) are upgraded so every account costs the same to
  // check as the dummy — otherwise timing would still hint which emails exist.
  if (bcrypt.getRounds(user.password) !== BCRYPT_ROUNDS) {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await withoutAudit(() => prisma.user.update({ where: { id: user.id }, data: { password: hash } })); // housekeeping
  }

  const { accessToken, refreshToken } = await createSession(user.id, userAgent);
  await recordAuthEvent('LOGIN', who);
  const { password: _, ...userWithoutPassword } = user;
  return { user: userWithoutPassword, accessToken, refreshToken };
}

/** New access token + rotated refresh token (see session.service) */
export async function refreshAccessToken(refreshToken: string) {
  return rotateSession(refreshToken);
}
