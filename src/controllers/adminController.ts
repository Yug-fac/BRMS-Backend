import { Request, Response } from 'express';
import { BloodRequest, User, StudentOptIn, Certificate, Notification } from '../models/associations';
import { emitToStudents, emitToUser } from '../config/socket';
import { createNotification } from '../services/notificationService';
import { sendEmail } from '../services/emailService';
import { CertificateService, generateDonationExcelReport } from '../services/certificateService';
import { Op, QueryTypes } from 'sequelize';
import fs from 'fs';
import csv from 'csv-parser';
import sequelize from '../config/database';
import path from 'path';

interface AuthRequest extends Request {
  user?: User;
}

export const getAllRequests = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      bloodGroup,
      urgency,
      search,
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const whereClause: any = {};

    if (status) whereClause.status = status;
    if (bloodGroup) whereClause.bloodGroup = bloodGroup;
    if (urgency) whereClause.urgency = urgency;
    if (search) {
      whereClause[Op.or] = [
        { requestorName: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { hospitalName: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await BloodRequest.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'assignedDonor',
          attributes: ['id', 'name', 'email', 'phone'],
        },
        {
          model: StudentOptIn,
          as: 'optedInStudents',
          include: [
            {
              model: User,
              as: 'student',
              attributes: ['id', 'name', 'email', 'phone', 'bloodGroup'],
            },
          ],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset,
    });

    res.json({
      success: true,
      data: {
        data: rows,
        total: count,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(count / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get all requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const getRequestById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const bloodRequest = await BloodRequest.findByPk(id, {
      include: [
        {
          model: User,
          as: 'assignedDonor',
          attributes: ['id', 'name', 'email', 'phone'],
        },
        {
          model: StudentOptIn,
          as: 'optedInStudents',
          include: [
            {
              model: User,
              as: 'student',
              attributes: ['id', 'name', 'email', 'phone', 'bloodGroup'],
            },
          ],
        },
      ],
    });

    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    res.json({
      success: true,
      data: bloodRequest,
    });
  } catch (error) {
    console.error('Get request by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const approveRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const bloodRequest = await BloodRequest.findByPk(id);

    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    if (bloodRequest.status !== 'pending') {
      res.status(400).json({
        success: false,
        message: 'Request is not in pending status',
      });
      return;
    }

    // Update request status
    await bloodRequest.update({ status: 'approved' });

    // Get Socket.IO instance
    const io = req.app.get('io');

    // Find matching students who are available for donation
    const matchingStudents = await User.findAll({
      where: {
        role: 'student',
        bloodGroup: bloodRequest.bloodGroup,
        availability: true,
      },
    });

    // Filter students who are actually eligible (3 months since last donation)
    const eligibleStudents = matchingStudents.filter(student => student.isAvailableForDonation());

    // Notify eligible students (real-time)
    for (const student of eligibleStudents) {
      if (io) {
        emitToUser(io, student.id, 'request_approved', {
          message: `New ${bloodRequest.bloodGroup} blood request approved`,
          bloodGroup: bloodRequest.bloodGroup,
          urgency: bloodRequest.urgency,
          requestId: bloodRequest.id,
        });
      }
      await createNotification({
        userId: student.id,
        type: 'request_approved',
        title: 'New Blood Request Available',
        message: `${bloodRequest.requestorName} needs ${bloodRequest.bloodGroup} blood (${bloodRequest.units} units)`,
        metadata: { requestId: bloodRequest.id },
      });
    }

    // Send emails to eligible students
    const studentEmails = eligibleStudents.map(student => student.email);
    if (studentEmails.length > 0) {
      await sendEmail({
        to: studentEmails,
        subject: `Blood Request Approved - ${bloodRequest.bloodGroup} Needed`,
        template: 'requestApproved',
        data: {
          requestorName: bloodRequest.requestorName,
          bloodGroup: bloodRequest.bloodGroup,
          units: bloodRequest.units,
          urgency: bloodRequest.urgency,
          hospitalName: bloodRequest.hospitalName,
          location: bloodRequest.location,
          dateTime: bloodRequest.dateTime,
        },
      });
    }

    res.json({
      success: true,
      data: bloodRequest,
      message: 'Blood request approved successfully',
    });
  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const rejectRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const bloodRequest = await BloodRequest.findByPk(id);

    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    if (bloodRequest.status !== 'pending') {
      res.status(400).json({
        success: false,
        message: 'Request is not in pending status',
      });
      return;
    }

    // Update request status
    await bloodRequest.update({
      status: 'rejected',
      rejectionReason: reason,
    });

    // Send rejection email to requestor
    await sendEmail({
      to: [bloodRequest.email],
      subject: 'Blood Request Update',
      template: 'requestRejected',
      data: {
        requestorName: bloodRequest.requestorName,
        reason: reason || 'Request did not meet our criteria',
      },
    });

    res.json({
      success: true,
      data: bloodRequest,
      message: 'Blood request rejected',
    });
  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const fulfillRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Fulfill request called with:', { params: req.params, body: req.body });
    
    const { id } = req.params;
    const { donorId } = req.body;

    // Validate input
    if (!donorId) {
      console.log('No donorId provided');
      res.status(400).json({
        success: false,
        message: 'Donor ID is required',
      });
      return;
    }

    // Find the blood request
    const bloodRequest = await BloodRequest.findByPk(id);
    if (!bloodRequest) {
      console.log('Blood request not found:', id);
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    console.log('Found blood request:', {
      id: bloodRequest.id,
      status: bloodRequest.status,
      requestorName: bloodRequest.requestorName
    });

    // Check if request is in approved status
    if (bloodRequest.status !== 'approved') {
      console.log('Request is not in approved status:', bloodRequest.status);
      res.status(400).json({
        success: false,
        message: 'Request is not in approved status',
      });
      return;
    }

    // Find the donor
    const donor = await User.findByPk(donorId);
    if (!donor) {
      console.log('Donor not found:', donorId);
      res.status(404).json({
        success: false,
        message: 'Donor not found',
      });
      return;
    }

    console.log('Found donor:', {
      id: donor.id,
      name: donor.name,
      email: donor.email,
      bloodGroup: donor.bloodGroup
    });

    // Check if donor has opted in to this request
    const optIn = await StudentOptIn.findOne({
      where: {
        studentId: donorId,
        requestId: id,
      },
    });

    if (!optIn) {
      console.log('Donor has not opted in to this request');
      res.status(400).json({
        success: false,
        message: 'Donor has not opted in to this request',
      });
      return;
    }

    console.log('Found opt-in record:', optIn.id);

    // Update request status and assign donor
    await bloodRequest.update({
      status: 'fulfilled',
      assignedDonorId: donorId,
    });

    // Update donor's last donation date and availability
    await donor.update({
      lastDonationDate: new Date(),
      availability: false, // Will be unavailable for next 3 months
    });

    console.log('Updated blood request status to fulfilled and donor availability');

    // Get Socket.IO instance
    const io = req.app.get('io');

    // Notify the assigned donor
    if (io) {
      emitToUser(io, donorId, 'donor_assigned', {
        message: 'You have been selected as a donor',
        requestId: id,
      });
    }

    // Create notification for the donor
    await createNotification({
      userId: donorId,
      type: 'donor_assigned',
      title: 'Selected as Donor',
      message: `You have been selected to donate blood for ${bloodRequest.requestorName}`,
      metadata: { requestId: id },
    });

    console.log('Created notification for donor');

    // Send email to requestor with donor details
    try {
      await sendEmail({
        to: [bloodRequest.email],
        subject: 'Donor Found for Your Blood Request',
        template: 'donorAssigned',
        data: {
          requestorName: bloodRequest.requestorName,
          donorName: donor.name,
          donorEmail: donor.email,
          donorPhone: donor.phone,
          bloodGroup: bloodRequest.bloodGroup,
          units: bloodRequest.units,
          hospitalName: bloodRequest.hospitalName,
          location: bloodRequest.location,
          dateTime: bloodRequest.dateTime,
        },
      });
      console.log('Sent email to requestor');
    } catch (emailError) {
      console.error('Failed to send email to requestor:', emailError);
    }

    // Send email to donor with request details
    try {
      await sendEmail({
        to: [donor.email],
        subject: 'You Have Been Selected as a Blood Donor',
        template: 'donorSelected',
        data: {
          donorName: donor.name,
          requestorName: bloodRequest.requestorName,
          requestorEmail: bloodRequest.email,
          requestorPhone: bloodRequest.phone,
          bloodGroup: bloodRequest.bloodGroup,
          units: bloodRequest.units,
          hospitalName: bloodRequest.hospitalName,
          location: bloodRequest.location,
          dateTime: bloodRequest.dateTime,
          urgency: bloodRequest.urgency,
        },
      });
      console.log('Sent email to donor');
    } catch (emailError) {
      console.error('Failed to send email to donor:', emailError);
    }

    // Fetch updated request with donor details for response
    const updatedRequest = await BloodRequest.findByPk(id, {
      include: [
        {
          model: User,
          as: 'assignedDonor',
          attributes: ['id', 'name', 'email', 'phone'],
        },
      ],
    });

    console.log('Successfully fulfilled request');

    res.json({
      success: true,
      data: updatedRequest,
      message: 'Donor assigned successfully',
    });
  } catch (error) {
    console.error('Fulfill request error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

export const getDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const totalRequests = await BloodRequest.count();
    const pendingRequests = await BloodRequest.count({ where: { status: 'pending' } });
    const approvedRequests = await BloodRequest.count({ where: { status: 'approved' } });
    const totalStudents = await User.count({ where: { role: 'student' } });
    const availableStudents = await User.count({
      where: { role: 'student', availability: true },
    });

    // Recent opt-ins (last 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const recentOptIns = await StudentOptIn.count({
      where: {
        createdAt: {
          [Op.gte]: yesterday,
        },
      },
    });

    res.json({
      success: true,
      data: {
        totalRequests,
        pendingRequests,
        approvedRequests,
        totalStudents,
        availableStudents,
        recentOptIns,
      },
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const getDonationStatistics = async (req: Request, res: Response): Promise<void> => {
  try {
    // Total fulfilled donations
    const totalDonations = await BloodRequest.count({ where: { status: 'fulfilled' } });
    // Total unique donors (assignedDonorId on fulfilled requests)
    const uniqueDonorIds = await sequelize.query(
      `SELECT DISTINCT assigned_donor_id as "assignedDonorId" 
       FROM blood_requests 
       WHERE status = 'fulfilled' 
       AND assigned_donor_id IS NOT NULL 
       AND assigned_donor_id::text != ''
       AND assigned_donor_id::text != 'null'`,
      { type: QueryTypes.SELECT }
    );
    const totalUniqueDonors = uniqueDonorIds.length;
    // Total requests
    const totalRequests = await BloodRequest.count();
    // Total units donated (sum of units for fulfilled requests)
    const totalUnitsDonatedResult = await BloodRequest.findOne({
      where: { status: 'fulfilled' },
      attributes: [[sequelize.fn('SUM', sequelize.col('units')), 'totalUnits']],
      raw: true,
    });
    // The result is an object like { totalUnits: '5' } or { totalUnits: null }
    const totalUnitsDonated = Number((totalUnitsDonatedResult as any)?.totalUnits || 0);

    res.json({
      success: true,
      data: {
        totalDonations,
        totalUniqueDonors,
        totalRequests,
        totalUnitsDonated,
      },
    });
  } catch (error) {
    console.error('Get donation statistics error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const downloadDonationReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const filePath = await generateDonationExcelReport();
    res.download(filePath, 'donation-report.xlsx', (err) => {
      if (err) {
        console.error('Error sending report:', err);
      }
      // Delete the file after sending
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error('Error deleting report file:', unlinkErr);
        }
      });
    });
  } catch (error) {
    console.error('Download donation report error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate report',
    });
  }
};

export const getBloodGroupStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    const stats = [];

    for (const bloodGroup of bloodGroups) {
      const totalStudents = await User.count({
        where: { role: 'student', bloodGroup },
      });
      const availableStudents = await User.count({
        where: { role: 'student', bloodGroup, availability: true },
      });
      const totalRequests = await BloodRequest.count({
        where: { bloodGroup },
      });

      stats.push({
        bloodGroup,
        totalStudents,
        availableStudents,
        totalRequests,
      });
    }

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Get blood group stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const getAllStudents = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      page = 1,
      limit = 10,
      bloodGroup,
      availability,
      search,
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const whereClause: any = { role: 'student' };

    if (bloodGroup) whereClause.bloodGroup = bloodGroup;
    if (availability !== undefined) whereClause.availability = availability === 'true';
    if (search) {
      whereClause[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { rollNo: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await User.findAndCountAll({
      where: whereClause,
      attributes: { exclude: ['password'] }, // Exclude password from response
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset,
    });

    res.json({
      success: true,
      data: {
        data: rows,
        total: count,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(count / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get all students error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const createStudent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, bloodGroup, rollNo, phone, availability = true } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      res.status(400).json({
        success: false,
        message: 'User with this email already exists',
      });
      return;
    }

    // Generate a temporary password
    const tempPassword = Math.random().toString(36).slice(-8);

    const student = await User.create({
      name,
      email,
      password: tempPassword,
      role: 'student',
      bloodGroup,
      rollNo,
      phone,
      availability,
    });

    // Send welcome email with temporary password
    try {
      await sendEmail({
        to: [email],
        subject: 'Welcome to BloodConnect',
        template: 'studentWelcome',
        data: {
          name,
          email,
          tempPassword,
          loginUrl: `${process.env.FRONTEND_URL}/login`,
        },
      });
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({
      success: true,
      data: student,
      message: 'Student created successfully',
    });
  } catch (error) {
    console.error('Create student error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const updateStudent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const student = await User.findOne({
      where: { id, role: 'student' },
    });

    if (!student) {
      res.status(404).json({
        success: false,
        message: 'Student not found',
      });
      return;
    }

    // Check if email is being changed and if it's already taken
    if (updateData.email && updateData.email !== student.email) {
      const existingUser = await User.findOne({ where: { email: updateData.email } });
      if (existingUser) {
        res.status(400).json({
          success: false,
          message: 'Email already in use',
        });
        return;
      }
    }

    const updatedStudent = await student.update(updateData);

    res.json({
      success: true,
      data: updatedStudent,
      message: 'Student updated successfully',
    });
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const deleteStudent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const student = await User.findOne({
      where: { id, role: 'student' },
    });

    if (!student) {
      res.status(404).json({
        success: false,
        message: 'Student not found',
      });
      return;
    }

    await student.destroy();

    res.json({
      success: true,
      message: 'Student deleted successfully',
    });
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const bulkUploadStudents = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        message: 'No file uploaded',
      });
      return;
    }

    const results: any[] = [];
    const errors: any[] = [];

    // Read CSV file
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        let created = 0;

        for (const row of results) {
          try {
            const { name, email, bloodGroup, rollNo, phone, availability } = row;

            // Validate required fields
            if (!name || !email || !bloodGroup || !rollNo || !phone) {
              errors.push({
                row: row,
                error: 'Missing required fields',
              });
              continue;
            }

            // Check if user already exists
            const existingUser = await User.findOne({ where: { email } });
            if (existingUser) {
              errors.push({
                row: row,
                error: 'Email already exists',
              });
              continue;
            }

            // Generate temporary password
            const tempPassword = Math.random().toString(36).slice(-8);

            await User.create({
              name,
              email,
              password: tempPassword,
              role: 'student',
              bloodGroup,
              rollNo,
              phone,
              availability: availability === 'true' || availability === true,
            });

            created++;

            // Send welcome email
            try {
              await sendEmail({
                to: [email],
                subject: 'Welcome to BloodConnect',
                template: 'studentWelcome',
                data: {
                  name,
                  email,
                  tempPassword,
                  loginUrl: `${process.env.FRONTEND_URL}/login`,
                },
              });
            } catch (emailError) {
              console.error('Failed to send welcome email to:', email, emailError);
              // Don't fail the creation if email fails
            }
          } catch (error) {
            errors.push({
              row: row,
              error: error.message,
            });
          }
        }

        // Clean up uploaded file
        fs.unlinkSync(req.file!.path);

        res.json({
          success: true,
          data: {
            created,
            errors,
          },
          message: `${created} students uploaded successfully`,
        });
      });
  } catch (error) {
    console.error('Bulk upload students error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Get all admins
export const getAllAdmins = async (req: Request, res: Response): Promise<void> => {
  try {
    const admins = await User.findAll({
      where: { role: 'admin' },
      attributes: ['id', 'name', 'email', 'phone', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });

    res.json({
      success: true,
      data: admins,
    });
  } catch (error) {
    console.error('Get all admins error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Create new admin
export const createAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, phone, password } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !password) {
      res.status(400).json({
        success: false,
        message: 'Name, email, phone, and password are required',
      });
      return;
    }

    // Check if admin already exists
    const existingAdmin = await User.findOne({
      where: { email },
    });

    if (existingAdmin) {
      res.status(400).json({
        success: false,
        message: 'Admin with this email already exists',
      });
      return;
    }

    // Create admin
    const admin = await User.create({
      name,
      email,
      phone,
      password,
      role: 'admin',
    });

    // Send email to all admins
    try {
      const allAdmins = await User.findAll({
        where: { role: 'admin' },
        attributes: ['email'],
      });

      const adminEmails = allAdmins.map(admin => admin.email);
      
      if (adminEmails.length > 0) {
        await sendEmail({
          to: adminEmails,
          subject: 'New Admin Added to BRMS',
          template: 'newAdminNotification',
          data: {
            newAdminName: name,
            newAdminEmail: email,
            newAdminPhone: phone,
          },
        });
      }
    } catch (emailError) {
      console.error('Error sending admin notification email:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({
      success: true,
      data: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
      },
      message: 'Admin created successfully',
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Update assigned donor for a request
export const updateAssignedDonor = async (req: Request, res: Response): Promise<void> => {
  try {
    const { requestId } = req.params;
    const { donorId } = req.body;

    const bloodRequest = await BloodRequest.findByPk(requestId);

    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    if (bloodRequest.status !== 'approved') {
      res.status(400).json({
        success: false,
        message: 'Can only assign donor to approved requests',
      });
      return;
    }

    // Check if donor exists and is available
    let donor = null;
    if (donorId) {
      donor = await User.findOne({
        where: { id: donorId, role: 'student' },
      });

      if (!donor) {
        res.status(404).json({
          success: false,
          message: 'Donor not found',
        });
        return;
      }

      if (!donor.availability) {
        res.status(400).json({
          success: false,
          message: 'Donor is not available for donation',
        });
        return;
      }
    }

    // Update assigned donor
    const oldDonorId = bloodRequest.assignedDonorId;
    await bloodRequest.update({ assignedDonorId: donorId || null });

    // If changing donor, notify the old donor
    if (donorId && donor && oldDonorId && oldDonorId !== donorId) {
      try {
        const oldDonor = await User.findByPk(oldDonorId);
        if (oldDonor) {
          await sendEmail({
            to: [oldDonor.email],
            subject: 'You have been unassigned from a Blood Request',
            template: 'donorUnassigned',
            data: {
              donorName: oldDonor.name,
              requestorName: bloodRequest.requestorName,
              bloodGroup: bloodRequest.bloodGroup,
              hospitalName: bloodRequest.hospitalName,
              dateTime: bloodRequest.dateTime,
            },
          });
        }
      } catch (emailError) {
        console.error('Failed to send unassignment email to old donor:', emailError);
      }
    }

    // Send email to the student (requestor) about the donor assignment/change
    if (donorId && donor) {
      try {
        await sendEmail({
          to: [bloodRequest.email],
          subject: 'Assigned Donor Updated for Your Blood Request',
          template: 'donorChanged',
          data: {
            requestorName: bloodRequest.requestorName,
            donorName: donor.name,
            donorEmail: donor.email,
            donorPhone: donor.phone,
            bloodGroup: bloodRequest.bloodGroup,
            units: bloodRequest.units,
            hospitalName: bloodRequest.hospitalName,
            location: bloodRequest.location,
            dateTime: bloodRequest.dateTime,
          },
        });
      } catch (emailError) {
        console.error('Failed to send donor change email to requestor:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Assigned donor updated successfully',
      data: bloodRequest,
    });
  } catch (error) {
    console.error('Update assigned donor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Complete donation with geotag photo
export const completeDonation = async (req: Request, res: Response): Promise<void> => {
  try {
    const requestId = req.params.requestId || req.params.id;
    const userId = (req as any).user?.id;
    // Handle geotagPhoto as a file upload
    let geotagPhoto: string | undefined = undefined;
    if (req.file) {
      geotagPhoto = req.file.filename;
    } else if (req.body.geotagPhoto) {
      geotagPhoto = req.body.geotagPhoto;
    }

    if (!geotagPhoto) {
      res.status(400).json({
        success: false,
        message: 'Geotag photo is required for donation completion',
      });
      return;
    }

    const bloodRequest = await BloodRequest.findByPk(requestId, {
      include: [
        {
          model: User,
          as: 'assignedDonor',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    if (!bloodRequest.assignedDonorId || bloodRequest.assignedDonorId !== userId) {
      res.status(403).json({
        success: false,
        message: 'You are not the assigned donor for this request',
      });
      return;
    }

    if (bloodRequest.status === 'fulfilled') {
      // Allow updating geotagPhoto if already fulfilled
      await bloodRequest.update({ geotagPhoto });
      res.json({
        success: true,
        message: 'Geotag photo uploaded successfully',
        data: bloodRequest,
      });
      return;
    }

    if (bloodRequest.status !== 'approved') {
      res.status(400).json({
        success: false,
        message: 'Request must be approved before donation completion',
      });
      return;
    }

    // Update request with geotag photo and mark as fulfilled
    await bloodRequest.update({
      geotagPhoto,
      status: 'fulfilled',
    });

    // Update donor's last donation date and availability
    if (typeof bloodRequest.assignedDonorId === 'string') {
      const donor = await User.findByPk(bloodRequest.assignedDonorId);
      if (donor) {
        await donor.update({
          lastDonationDate: new Date(),
          availability: false, // Set to false immediately after donation
        });
      }
    }

    // Create certificate request automatically
    const certificateService = new CertificateService();
    if (typeof bloodRequest.assignedDonorId === 'string') {
      await certificateService.createCertificateRequest(bloodRequest.assignedDonorId, requestId);
      // Send notification to assigned donor
      try {
        await createNotification({
          userId: bloodRequest.assignedDonorId,
          type: 'donation_completed',
          title: 'Donation Completed',
          message: `Your donation for ${bloodRequest.requestorName} has been completed successfully.`,
          metadata: { requestId: bloodRequest.id },
        });
      } catch (notificationError) {
        console.error('Error creating notification:', notificationError);
      }
    }

    res.json({
      success: true,
      message: 'Donation completed successfully',
      data: bloodRequest,
    });
  } catch (error) {
    console.error('Complete donation error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Approve and generate certificate in one step
export const approveAndGenerateCertificate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { certificateId } = req.params;
    const adminId = req.user!.id;

    const certificateService = new CertificateService();
    let certificate = await Certificate.findByPk(certificateId);
    if (!certificate) {
      res.status(404).json({
        success: false,
        message: 'Certificate not found',
      });
      return;
    }

    // If pending, approve it
    if (certificate.status === 'pending') {
      certificate = await certificateService.approveCertificate(certificateId, adminId);
    }

    // Refetch to get updated status after possible approval
    certificate = await Certificate.findByPk(certificateId);

    // If approved, generate it
    if (certificate && certificate.status === 'approved') {
      const result = await certificateService.generateCertificate(certificateId);
      certificate = result.certificate;
      const filePath = result.filePath;
      res.json({
        success: true,
        message: 'Certificate approved and generated successfully',
        data: {
          certificate,
          downloadUrl: filePath,
        },
      });
      return;
    }

    // If already generated, just return
    if (certificate && certificate.status === 'generated') {
      res.json({
        success: true,
        message: 'Certificate already generated',
        data: {
          certificate,
          downloadUrl: certificate.certificateUrl,
        },
      });
      return;
    }

    // If status is something else, return error
    res.status(400).json({
      success: false,
      message: `Cannot approve/generate certificate in status: ${certificate?.status}`,
    });
  } catch (error) {
    console.error('Approve and generate certificate error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Update admin
export const updateAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const admin = await User.findOne({
      where: { id, role: 'admin' },
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found',
      });
      return;
    }

    // Check if email is being changed and if it's already taken
    if (updateData.email && updateData.email !== admin.email) {
      const existingUser = await User.findOne({ where: { email: updateData.email } });
      if (existingUser) {
        res.status(400).json({
          success: false,
          message: 'Email already in use',
        });
        return;
      }
    }

    // Only update password if provided
    if (!updateData.password) {
      delete updateData.password;
    }

    const updatedAdmin = await admin.update(updateData);

    res.json({
      success: true,
      data: {
        id: updatedAdmin.id,
        name: updatedAdmin.name,
        email: updatedAdmin.email,
        phone: updatedAdmin.phone,
        role: updatedAdmin.role,
      },
      message: 'Admin updated successfully',
    });
  } catch (error) {
    console.error('Update admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Delete admin
export const deleteAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const admin = await User.findOne({
      where: { id, role: 'admin' },
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found',
      });
      return;
    }

    // Prevent deleting the last admin
    const adminCount = await User.count({ where: { role: 'admin' } });
    if (adminCount <= 1) {
      res.status(400).json({
        success: false,
        message: 'Cannot delete the last admin user',
      });
      return;
    }

    await admin.destroy();

    res.json({
      success: true,
      message: 'Admin deleted successfully',
    });
  } catch (error) {
    console.error('Delete admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Delete a blood request
export const deleteRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const bloodRequest = await BloodRequest.findByPk(id);
    if (!bloodRequest) {
      res.status(404).json({
        success: false,
        message: 'Blood request not found',
      });
      return;
    }

    // Delete related StudentOptIn records
    await StudentOptIn.destroy({ where: { requestId: id } });
    // Delete related Certificate records
    await Certificate.destroy({ where: { requestId: id } });
    // Optionally: Delete related notifications (if you want to clean up)
    // await Notification.destroy({ where: { metadata: { requestId: id } } });

    // Delete the blood request itself
    await bloodRequest.destroy();

    res.json({
      success: true,
      message: 'Blood request deleted successfully',
    });
    return;
  } catch (error) {
    console.error('Delete blood request error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
    return;
  }
};