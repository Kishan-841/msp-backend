import { Router } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import * as attachmentController from '../controllers/attachment.controller.js';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { UPLOAD_DIR } from '../services/attachment.service.js';

// Documents people actually send: PDFs, images, office files, saved emails
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.eml', '.msg', '.txt',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Random name on disk — never trust the client's filename for paths
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new AppError('File type not allowed. Use PDF, image, Word, Excel or email files.', 400));
  },
});

const router = Router();

router.use(authenticate);

router.post('/', upload.single('file'), attachmentController.upload);
router.get('/', attachmentController.list);
router.get('/:id/download', attachmentController.download);
router.delete('/:id', attachmentController.remove);

export default router;
