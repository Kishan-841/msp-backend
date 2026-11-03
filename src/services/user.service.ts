import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { revokeAllSessions } from './session.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type { UserRole } from '../generated/prisma/client.js';

const userWithoutPassword = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getAllUsers(search?: string, page?: PageParams) {
  // system users (owners of API leads) can't log in and aren't managed here
  const where = {
    isSystem: false,
    ...(search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] }
      : {}),
  };
  const args = { where, select: userWithoutPassword, orderBy: { createdAt: 'desc' as const } };
  if (!page) return prisma.user.findMany(args);
  const [items, total] = await Promise.all([
    prisma.user.findMany({ ...args, skip: page.skip, take: page.limit }),
    prisma.user.count({ where }),
  ]);
  return envelope(items, total, page);
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: userWithoutPassword,
  });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  return user;
}

export async function createUser(data: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}) {
  const existing = await prisma.user.findUnique({
    where: { email: data.email },
  });

  if (existing) {
    throw new AppError('A user with this email already exists.', 409);
  }

  const hashedPassword = await bcrypt.hash(data.password, 12);

  return prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      password: hashedPassword,
      role: data.role,
    },
    select: userWithoutPassword,
  });
}

export async function updateUser(
  id: string,
  data: {
    name?: string;
    email?: string;
    password?: string;
    role?: UserRole;
    isActive?: boolean;
  }
) {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  if (data.email && data.email !== user.email) {
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existing) {
      throw new AppError('A user with this email already exists.', 409);
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.password) {
    updateData.password = await bcrypt.hash(data.password, 12);
  }

  const updated = await prisma.user.update({
    where: { id },
    data: updateData,
    select: userWithoutPassword,
  });
  // New password, deactivation or a role change: sign them out everywhere
  if (data.password || data.isActive === false || (data.role && data.role !== user.role)) {
    await revokeAllSessions(id);
  }
  return updated;
}

export async function deleteUser(id: string, currentUserId: string) {
  if (id === currentUserId) {
    throw new AppError('You cannot deactivate your own account.', 400);
  }

  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: false },
    select: userWithoutPassword,
  });
  await revokeAllSessions(id);
  return updated;
}
