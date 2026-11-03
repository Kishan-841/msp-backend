import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as materialService from '../services/material.service.js';

const CategoryEnum = z.enum(['HARDWARE', 'SOFTWARE']);

const createSchema = z.object({
  category: CategoryEnum,
  product: z.string().trim().min(1, 'Product is required'),
  name: z.string().trim().min(2, 'Item name must be at least 2 characters').max(120),
  brand: z.string().trim().max(60).optional(),
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const materials = await materialService.listMaterials({
    product: (req.query.product as string) || undefined,
    category: CategoryEnum.optional().parse(req.query.category || undefined),
  });
  sendSuccess(res, materials, 'Materials retrieved');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const material = await materialService.createMaterial(createSchema.parse(req.body), req.user!.id);
  sendCreated(res, material, 'Item saved');
});
