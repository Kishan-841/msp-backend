import { Response } from 'express';

interface ApiResponsePayload<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): void {
  const payload: ApiResponsePayload<T> = { success: true, data };
  if (message) payload.message = message;
  res.status(statusCode).json(payload);
}

export function sendError(res: Response, message: string, statusCode = 500, error?: string): void {
  const payload: ApiResponsePayload = { success: false, message };
  if (error) payload.error = error;
  res.status(statusCode).json(payload);
}

export function sendCreated<T>(res: Response, data: T, message?: string): void {
  sendSuccess(res, data, message, 201);
}
