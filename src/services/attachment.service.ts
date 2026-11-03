import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

export const ENTITY_TYPES = ['QUOTE_ACCEPTANCE', 'PURCHASE_ORDER', 'PURCHASE_INVOICE'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const uploaderSelect = { id: true, name: true } as const;

// The record a file is attached to must exist
async function assertEntityExists(entityType: EntityType, entityId: string) {
  const found =
    entityType === 'QUOTE_ACCEPTANCE'
      ? await prisma.quote.findUnique({ where: { id: entityId }, select: { id: true } })
      : entityType === 'PURCHASE_ORDER'
        ? await prisma.purchaseOrder.findUnique({ where: { id: entityId }, select: { id: true } })
        : await prisma.purchaseInvoice.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!found) throw new AppError('The record to attach to was not found.', 404);
}

export async function saveAttachment(
  file: Express.Multer.File,
  entityType: EntityType,
  entityId: string,
  userId: string
) {
  try {
    await assertEntityExists(entityType, entityId);
  } catch (err) {
    await fs.rm(file.path, { force: true }); // don't keep orphaned files
    throw err;
  }

  return prisma.attachment.create({
    data: {
      entityType,
      entityId,
      storedName: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      uploadedById: userId,
    },
    include: { uploadedBy: { select: uploaderSelect } },
  });
}

export async function listAttachments(entityType: EntityType, entityId: string) {
  return prisma.attachment.findMany({
    where: { entityType, entityId },
    include: { uploadedBy: { select: uploaderSelect } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAttachmentFile(id: string) {
  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) throw new AppError('File not found.', 404);
  return { attachment, filePath: path.join(UPLOAD_DIR, attachment.storedName) };
}

export async function deleteAttachment(id: string, userId: string, userRole: string) {
  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) throw new AppError('File not found.', 404);
  if (attachment.uploadedById !== userId && userRole !== 'ADMIN') {
    throw new AppError('Only the uploader or an Admin can delete this file.', 403);
  }
  await prisma.attachment.delete({ where: { id } });
  await fs.rm(path.join(UPLOAD_DIR, attachment.storedName), { force: true });
  return { id };
}
