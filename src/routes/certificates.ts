import express from 'express';
import {
  createCertificateRequest,
  getDonorCertificates,
  getPendingCertificates,
  getAllCertificates,
  approveCertificate,
  generateCertificate,
  downloadCertificate,
  getCertificateById,
} from '../controllers/certificateController';
import { authenticate, authorize } from '../middleware/auth';

const router = express.Router();

// Student routes
router.post('/request', authenticate, authorize('student'), createCertificateRequest);
router.get('/my-certificates', authenticate, authorize('student'), getDonorCertificates);
router.get('/:id', authenticate, getCertificateById);
router.get('/:id/download', authenticate, downloadCertificate);

// Admin routes
router.get('/admin/pending', authenticate, authorize('admin'), getPendingCertificates);
router.get('/admin/all', authenticate, authorize('admin'), getAllCertificates);
router.post('/admin/:id/approve', authenticate, authorize('admin'), approveCertificate);
router.post('/admin/:id/generate', authenticate, authorize('admin'), generateCertificate);

export default router; 