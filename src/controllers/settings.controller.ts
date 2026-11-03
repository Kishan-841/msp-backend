import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import * as settingsService from '../services/settings.service.js';
import { optionalGstinField, optionalStateField } from '../utils/gst.js';

const companySchema = z.object({
  name: z.string().trim().min(1, 'Company name is required'),
  gstin: optionalGstinField,
  state: optionalStateField,
  address: z.string().trim().optional(),
  email: z.union([z.literal(''), z.email('Invalid email address')]).optional(),
  phone: z.string().trim().optional(),
  pan: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(v), 'Invalid PAN')
    .optional(),
  cin: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[LU][0-9]{5}[A-Za-z]{2}[0-9]{4}[A-Za-z]{3}[0-9]{6}$/.test(v), 'Invalid CIN')
    .optional(),
  tan: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[A-Za-z]{4}[0-9]{5}[A-Za-z]$/.test(v), 'Invalid TAN')
    .optional(),
  bankName: z.string().trim().optional(),
  bankAccountName: z.string().trim().optional(),
  bankAccountNumber: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[0-9]{9,18}$/.test(v), 'Account number should be 9–18 digits')
    .optional(),
  bankIfsc: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(v), 'Invalid IFSC (e.g. HDFC0000794)')
    .optional(),
  bankBranch: z.string().trim().optional(),
  poTerms: z.string().max(3000).optional(),
  logoDataUrl: z
    .string()
    .refine(
      (v) => v === '' || /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(v),
      'Logo must be a PNG, JPG, WebP or SVG image'
    )
    .refine((v) => v.length <= 700_000, 'Logo is too large (max ~500 KB)')
    .optional(),
})
  // GSTIN embeds the PAN (characters 3–12) — they must agree
  .refine((d) => !d.gstin || !d.pan || d.gstin.slice(2, 12) === d.pan.toUpperCase(), {
    message: "GSTIN doesn't match the PAN (characters 3–12 of the GSTIN are the PAN)",
    path: ['gstin'],
  });

export const getCompany = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await settingsService.getCompanySettings();
  sendSuccess(res, settings, 'Company settings retrieved');
});

export const saveCompany = asyncHandler(async (req: Request, res: Response) => {
  const data = companySchema.parse(req.body);
  const settings = await settingsService.saveCompanySettings(data);
  sendSuccess(res, settings, 'Company settings saved');
});
