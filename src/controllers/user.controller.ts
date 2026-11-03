import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pageParams, searchParam } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as userService from '../services/user.service.js';

const UserRoleEnum = z.enum(['ADMIN', 'MSP_TL', 'SALES', 'ACCOUNTS']);

const createUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: UserRoleEnum,
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.email().optional(),
  password: z.string().min(6).optional(),
  role: UserRoleEnum.optional(),
  isActive: z.boolean().optional(),
});

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const users = await userService.getAllUsers(searchParam(req), pageParams(req) ?? undefined);
  sendSuccess(res, users, 'Users retrieved');
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = await userService.getUserById(id);
  sendSuccess(res, user, 'User retrieved');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = createUserSchema.parse(req.body);
  const user = await userService.createUser(data);
  sendCreated(res, user, 'User created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = updateUserSchema.parse(req.body);
  const user = await userService.updateUser(id, data);
  sendSuccess(res, user, 'User updated');
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const currentUserId = req.user!.id;
  const user = await userService.deleteUser(id, currentUserId);
  sendSuccess(res, user, 'User deactivated');
});
