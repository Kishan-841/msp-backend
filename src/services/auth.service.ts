import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { createSession, rotateSession } from './session.service.js';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../utils/loginThrottle.js';

// Compared against when the email doesn't exist, so a wrong email takes as long as a wrong
// password (response time can't reveal which emails have accounts).
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export async function loginUser(email: string, password: string, ip: string, userAgent?: string) {
  assertLoginAllowed(email, ip);

  const user = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
  const isPasswordValid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !isPasswordValid) {
    recordLoginFailure(email, ip);
    throw new AppError('Invalid email or password.', 401);
  }
  // only someone who knows the password learns the account is deactivated
  if (!user.isActive) {
    throw new AppError('Account is deactivated. Contact an administrator.', 403);
  }
  recordLoginSuccess(email, ip);
  // Older hashes (e.g. seeded with 10 rounds) are upgraded so every account costs the same to
  // check as the dummy — otherwise timing would still hint which emails exist.
  if (bcrypt.getRounds(user.password) !== BCRYPT_ROUNDS) {
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(password, BCRYPT_ROUNDS) } });
  }

  const { accessToken, refreshToken } = await createSession(user.id, userAgent);
  const { password: _, ...userWithoutPassword } = user;
  return { user: userWithoutPassword, accessToken, refreshToken };
}

/** New access token + rotated refresh token (see session.service) */
export async function refreshAccessToken(refreshToken: string) {
  return rotateSession(refreshToken);
}
