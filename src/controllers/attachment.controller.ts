import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import { AppError } from '../middleware/errorHandler.js';
import * as attachmentService from '../services/attachment.service.js';
import { assertAttachmentEntityAccess } from '../services/access.service.js';
import fs from 'node:fs/promises';

const entitySchema = z.object({
  entityType: z.enum(attachmentService.ENTITY_TYPES),
  entityId: z.uuid('Invalid record ID'),
});

export const upload = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded.', 400);
  const { entityType, entityId } = entitySchema.parse(req.body);
  try {
    await assertAttachmentEntityAccess(req.user!, entityType, entityId, 'upload');
  } catch (err) {
    await fs.rm(req.file.path, { force: true }); // multer already wrote it — don't keep it
    throw err;
  }
  const attachment = await attachmentService.saveAttachment(
    req.file,
    entityType,
    entityId,
    req.user!.id
  );
  sendCreated(res, attachment, 'File uploaded');
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { entityType, entityId } = entitySchema.parse(req.query);
  await assertAttachmentEntityAccess(req.user!, entityType, entityId, 'view');
  const files = await attachmentService.listAttachments(entityType, entityId);
  sendSuccess(res, files, 'Files retrieved');
});

export const download = asyncHandler(async (req: Request, res: Response) => {
  const { attachment, filePath } = await attachmentService.getAttachmentFile(String(req.params.id));
  await assertAttachmentEntityAccess(
    req.user!,
    attachment.entityType as 'QUOTE_ACCEPTANCE' | 'PURCHASE_ORDER' | 'PURCHASE_INVOICE',
    attachment.entityId,
    'view'
  );
  res.setHeader('Content-Type', attachment.mimeType);
  // `download` sets Content-Disposition with a safely encoded original filename
  res.download(filePath, attachment.originalName);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { attachment } = await attachmentService.getAttachmentFile(String(req.params.id));
  await assertAttachmentEntityAccess(
    req.user!,
    attachment.entityType as 'QUOTE_ACCEPTANCE' | 'PURCHASE_ORDER' | 'PURCHASE_INVOICE',
    attachment.entityId,
    'view'
  );
  const result = await attachmentService.deleteAttachment(
    String(req.params.id),
    req.user!.id,
    req.user!.role
  );
  sendSuccess(res, result, 'File deleted');
});
