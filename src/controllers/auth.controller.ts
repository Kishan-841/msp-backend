import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../middleware/errorHandler.js';
import * as authService from '../services/auth.service.js';
import { revokeSession, sessionIdOf } from '../services/session.service.js';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { recordAuthEvent } from '../services/audit.service.js';

const loginSchema = z.object({
  email: z.email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// SameSite=None (frontend on another site) only works with Secure
const COOKIE_BASE = {
  httpOnly: true,
  secure: config.nodeEnv === 'production' || config.cookieSameSite === 'none',
  sameSite: config.cookieSameSite,
  path: '/api/v1/auth',
};
const REFRESH_COOKIE_OPTIONS = { ...COOKIE_BASE, maxAge: 7 * 24 * 60 * 60 * 1000 }; // 7 days

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);

  const result = await authService.loginUser(email, password, req.ip ?? 'unknown', req.get('user-agent'));

  res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTIONS);

  sendSuccess(res, { user: result.user, accessToken: result.accessToken }, 'Login successful');
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken;

  if (!token) {
    throw new AppError('No refresh token provided.', 401);
  }

  const result = await authService.refreshAccessToken(token);

  // rotated: the old refresh token is now spent
  res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTIONS);
  sendSuccess(res, { accessToken: result.accessToken }, 'Token refreshed');
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  // end the session on the server too — the old tokens stop working right away
  const sid =
    sessionIdOf(req.cookies?.refreshToken, config.jwtRefreshSecret) ??
    sessionIdOf(req.headers.authorization?.split(' ')[1], config.jwtSecret);
  if (sid) {
    const session = await prisma.session.findUnique({
      where: { id: sid },
      select: { revokedAt: true, user: { select: { id: true, name: true, email: true, role: true } } },
    });
    await revokeSession(sid);
    if (session && !session.revokedAt) await recordAuthEvent('LOGOUT', session.user);
  }

  res.clearCookie('refreshToken', COOKIE_BASE);

  sendSuccess(res, null, 'Logged out successfully');
});

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, req.user, 'Current user retrieved');
});
