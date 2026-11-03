import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { config } from '../config/index.js';
import { Prisma } from '../generated/prisma/client.js';

export class AppError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Request-body validation failures are the client's fault, not a server error
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.');
    res.status(400).json({
      success: false,
      message: first ? (field ? `${field}: ${first.message}` : first.message) : 'Invalid request',
      error: config.nodeEnv === 'development' ? JSON.stringify(err.issues) : undefined,
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 10 MB).' : `Upload failed: ${err.message}`;
    res.status(400).json({ success: false, message });
    return;
  }

  // Our own errors carry a message meant for the user
  if (err instanceof AppError) {
    if (err.statusCode >= 500) console.error(`[ERROR] ${err.statusCode} - ${err.message}`, err.stack);
    res.status(err.statusCode).json({ success: false, message: err.message });
    return;
  }

  // Database errors: map the ones caused by the request to 4xx; never send Prisma's text
  // (it includes the query and server file paths) to the client.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped: Record<string, [number, string]> = {
      P2002: [409, 'That already exists — refresh and try again.'],
      P2003: [409, 'This record is linked to others and cannot be changed that way.'],
      P2025: [404, 'Not found — it may have been deleted.'],
    };
    const hit = mapped[err.code];
    if (hit) {
      console.warn(`[DB ${err.code}] ${req.method} ${req.originalUrl}`, err.meta ?? '');
      res.status(hit[0]).json({ success: false, message: hit[1] });
      return;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    // e.g. ?status=BOGUS, ?page=abc, an invalid date
    console.warn(`[DB validation] ${req.method} ${req.originalUrl}`);
    res.status(400).json({ success: false, message: 'Invalid request — check the filters or values you sent.' });
    return;
  }

  // Anything else is a bug: log everything, tell the client nothing internal
  console.error(`[ERROR] 500 - ${req.method} ${req.originalUrl} - ${err.message}`);
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong on our side. Please try again.',
    error: config.nodeEnv === 'development' ? err.message : undefined,
  });
};
