import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../services/session.service.js';
import { AppError } from './errorHandler.js';
import type { UserRole } from '../generated/prisma/client.js';
import { setAuditActor } from '../lib/auditContext.js';

export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Not authenticated. No token provided.', 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    // signature + expiry + the login session still being live (logout / password change revoke it)
    const decoded = await verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user) {
      throw new AppError('User not found.', 401);
    }

    if (!user.isActive) {
      throw new AppError('User account is deactivated.', 401);
    }

    const { password: _, ...userWithoutPassword } = user;
    req.user = userWithoutPassword;
    setAuditActor({ id: user.id, name: user.name, email: user.email, role: user.role });

    next();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Not authenticated. Invalid token.', 401);
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError('Not authenticated.', 401);
    }

    // Admin is the super-user: allowed on every route, including ones added later
    if (req.user.role !== 'ADMIN' && !roles.includes(req.user.role)) {
      throw new AppError('Forbidden. Insufficient permissions.', 403);
    }

    next();
  };
};
