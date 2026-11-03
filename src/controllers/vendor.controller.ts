import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pageParams, searchParam } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as vendorService from '../services/vendor.service.js';
import {
  optionalAccountNumberField,
  optionalGstinField,
  optionalIfscField,
  optionalStateField,
} from '../utils/gst.js';

const vendorSchema = z.object({
  name: z.string().trim().min(1, 'Vendor name is required'),
  contactPerson: z.string().trim().min(1, 'Contact person is required'),
  email: z.email('Invalid email address'),
  phone: z.string().trim().min(1, 'Phone is required'),
  address: z.string().trim().optional(),
  gstNumber: optionalGstinField,
  state: optionalStateField,
  products: z.array(z.string().trim().min(1)).optional(),
  bankName: z.string().trim().optional(),
  bankAccountName: z.string().trim().optional(),
  bankAccountNumber: optionalAccountNumberField,
  bankIfsc: optionalIfscField,
});

const updateVendorSchema = vendorSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const vendors = await vendorService.getAllVendors(
    { search: searchParam(req), includeInactive: req.query.includeInactive === 'true' },
    pageParams(req) ?? undefined
  );
  sendSuccess(res, vendors, 'Vendors retrieved');
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const vendor = await vendorService.getVendorById(String(req.params.id));
  sendSuccess(res, vendor, 'Vendor retrieved');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = vendorSchema.parse(req.body);
  const vendor = await vendorService.createVendor(data);
  sendCreated(res, vendor, 'Vendor created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const data = updateVendorSchema.parse(req.body);
  const vendor = await vendorService.updateVendor(String(req.params.id), data);
  sendSuccess(res, vendor, 'Vendor updated');
});
