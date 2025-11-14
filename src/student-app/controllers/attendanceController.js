import { Attendance } from '../../models/attendanceModel.js';
import { QRCodeSession } from '../../models/qrCodeSessionModel.js';
import { ClassEnrollment } from '../../models/classEnrollmentModel.js';
import { User } from '../../models/userModel.js';
import { ScheduleInstance } from '../../models/recurringScheduleModel.js';
import { Class } from '../../models/classModel.js';
import { compareFaces } from '../../AWS/rekognitionService.js';

/**
 * @desc    Submit a new attendance record after face verification
 * @route   POST /api/student/attendance
 * @access  Private (Student)
 */
export const submitAttendance = async (req, res) => {
  try {
    const { 
      sessionId, 
      classId, 
      studentCoordinates, 
      livenessPassed, 
      faceImage // Expecting a base64 encoded image string
    } = req.body;
    
    const studentId = req.user.id;

    console.log('New attendance submission request:', { 
      sessionId, 
      classId, 
      studentId,
      livenessPassed
    });

    // --- 1. Basic Validation ---
    if (!sessionId || !classId || !studentCoordinates || !faceImage) {
      return res.status(400).json({ message: 'Missing required attendance data.' });
    }
    if (livenessPassed !== true) {
      return res.status(400).json({ message: 'Liveness check was not passed.' });
    }

    // --- 2. Find Student and their Reference Face Image Key ---
    const student = await User.findById(studentId);
    if (!student || !student.faceImageS3Key) {
      return res.status(404).json({ message: 'Student profile not found or face is not registered.' });
    }

    // --- 3. Perform Face Recognition via AWS Rekognition ---
    // Convert the base64 image string from the app into a Buffer for the AWS SDK
    const base64Data = faceImage.replace(/^data:image\/\w+;base64,/, '');
    const targetImageBuffer = Buffer.from(base64Data, 'base64');
    
    // Check image size (AWS Rekognition has limits)
    const imageSizeInMB = targetImageBuffer.length / (1024 * 1024);
    console.log(`Image size: ${imageSizeInMB.toFixed(2)}MB`);
    
    if (imageSizeInMB > 5) {
      return res.status(400).json({ message: 'Image too large. Please try again with a smaller image.' });
    }
    
    const facesDoMatch = await compareFaces(student.faceImageS3Key, targetImageBuffer);

    if (!facesDoMatch) {
      return res.status(401).json({ message: 'Face recognition failed. Identity could not be verified.' });
    }
    console.log(`✅ Face successfully verified for student: ${student.fullName}`);

    // --- 4. Verify QR Session and Prevent Duplicates ---
    const qrSession = await QRCodeSession.findOne({
      sessionId,
      classId,
      isActive: true,
      sessionExpiresAt: { $gt: new Date() }
    });

    if (!qrSession) {
      return res.status(400).json({ message: 'This QR code is invalid or has expired.' });
    }
    
    const existingAttendance = await Attendance.findOne({ studentId, sessionId: qrSession._id });
    if (existingAttendance) {
      return res.status(409).json({ message: 'You have already marked attendance for this session.' });
    }

    // --- 5. Save the Attendance Record ---
    const attendanceRecord = new Attendance({
      studentId,
      classId,
      sessionId: qrSession._id, // Use QRCodeSession's ObjectId instead of sessionId string
      scheduleId: qrSession.scheduleId, // Associate with schedule from QR session
      // status: 'present',
      studentCoordinates: {
        latitude: studentCoordinates.latitude, 
        longitude: studentCoordinates.longitude,
      },
      // markedBy: 'student',
      livenessPassed: true,
      timestamp: new Date(),
      manualEntry: false,
    });

    await attendanceRecord.save();

    res.status(201).json({
      message: 'Attendance marked successfully!',
      attendance: attendanceRecord,
    });

  } catch (error) {
    console.error('Error submitting attendance:', error);
    if (error.message.includes('Face could not be verified')) {
      return res.status(401).json({ message: error.message });
    }
    res.status(500).json({ message: error.message || 'An unexpected server error occurred.' });
  }
};


/**
 * @desc    Sync multiple offline attendance records
 * @route   POST /api/student/attendance/sync
 * @access  Private (Student)
 */
export const syncAttendance = async (req, res) => {
  try {
    const { attendances } = req.body;
    const studentId = req.user.id;

    if (!Array.isArray(attendances) || attendances.length === 0) {
      return res.status(400).json({ message: 'No attendance records to sync.' });
    }

    const syncResults = [];
    for (const record of attendances) {
      const { sessionId, classId, scheduleId, studentCoordinates, livenessPassed, faceEmbedding, timestamp } = record;
      
      const existing = await Attendance.findOne({ studentId, sessionId });

      if (existing) {
        syncResults.push({ sessionId, status: 'skipped', message: 'Already exists.' });
        continue;
      }

      const newRecord = new Attendance({
        studentId,
        sessionId,
        classId,
        scheduleId,
        studentCoordinates,
        livenessPassed,
        faceEmbedding,
        timestamp: new Date(timestamp),
        synced: true,
        notes: " Synced from offline data",
      });

      await newRecord.save();
      syncResults.push({ sessionId, status: 'success' });
    }

    res.status(200).json({
      message: 'Sync completed.',
      results: syncResults,
    });

  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ message: error.message });
  }
};

// --- (NEW) Get Student's Attendance Records (Paginated) ---

/**
 * @desc    Get all attendance records for the logged-in student, paginated.
 * @route   GET /api/attendance/records
 * @access  Private (Student)
 */
export const getMyAttendanceRecords = async (req, res) => {
  try {
    const studentId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const records = await Attendance.find({ studentId })
      .populate('classId', 'subjectName subjectCode')
      .sort({ timestamp: -1 })
      .limit(limit)
      .skip(skip)
      .lean(); // Use .lean() for faster read-only queries

    const totalRecords = await Attendance.countDocuments({ studentId });
    const totalPages = Math.ceil(totalRecords / limit);

    res.status(200).json({
      message: "Records fetched successfully",
      data: records,
      pagination: {
        totalRecords,
        totalPages,
        currentPage: page,
        limit
      }
    });
  } catch (error) {
    console.error('Error fetching attendance records:', error);
    res.status(500).json({ message: 'Failed to fetch attendance records.' });
  }
};

// --- (NEW) Get Student's Records by Class (Paginated) ---

/**
 * @desc    Get all attendance records for a specific class, paginated.
 * @route   GET /api/attendance/records/class/:classId
 * @access  Private (Student)
 */
export const getMyAttendanceRecordsByClass = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { classId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const records = await Attendance.find({ studentId, classId })
      .populate('classId', 'subjectName subjectCode')
      .sort({ timestamp: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const totalRecords = await Attendance.countDocuments({ studentId, classId });
    const totalPages = Math.ceil(totalRecords / limit);

    res.status(200).json({
      message: "Class records fetched successfully",
      data: records,
      pagination: {
        totalRecords,
        totalPages,
        currentPage: page,
        limit
      }
    });
  } catch (error) {
    console.error('Error fetching class attendance records:', error);
    res.status(500).json({ message: 'Failed to fetch class attendance records.' });
  }
};

// --- (NEW) Get Overall Attendance Summary ---

/**
 * @desc    Get an attendance summary (total/attended/percentage) for all enrolled classes.
 * @route   GET /api/attendance/summary
 * @access  Private (Student)
 */
export const getMyAttendanceSummary = async (req, res) => {
  try {
    const studentId = req.user.id;

    // 1. Find all classes student is enrolled in
    const enrollments = await ClassEnrollment.find({ studentId }).select('classId');
    if (enrollments.length === 0) {
      return res.status(200).json({ message: "Student is not enrolled in any classes." });
    }
    const classIds = enrollments.map(e => e.classId);

    // 2. Find total held sessions (Denominator)
    // A "held" session is one that is in the past and was not 'cancelled'
    // const totalHeldSessions = await Attendance.countDocuments({
    //   classId: { $in: classIds },
    //   // scheduledDate: { $lte: new Date() }, // In the past or today
    //   // status: { $ne: 'cancelled' }
    // });

    const heldSessionIds = await Attendance.distinct('sessionId', {
      classId: { $in: classIds },
    })
    const totalHeldSessions = heldSessionIds.length;

    // 3. Find total attended sessions (Numerator)
    const totalAttendedSessions = await Attendance.countDocuments({
      studentId,
      classId: { $in: classIds }
    });

    // 4. Calculate percentage
    const percentage = (totalHeldSessions === 0)
      ? 100 // If no sessions held, attendance is 100%
      : (totalAttendedSessions / totalHeldSessions) * 100;

    res.status(200).json({
      message: "Overall summary fetched successfully",
      summary: {
        totalHeldSessions,
        totalAttendedSessions,
        totalMissedSessions: totalHeldSessions - totalAttendedSessions,
        percentage: parseFloat(percentage.toFixed(2))
      }
    });

  } catch (error) {
    console.error('Error fetching attendance summary:', error);
    res.status(500).json({ message: 'Failed to fetch attendance summary.' });
  }
};

// --- (NEW) Get Single Class Attendance Summary ---

/**
 * @desc    Get a detailed attendance summary for a single class.
 * @route   GET /api/attendance/summary/class/:classId
 * @access  Private (Student)
 */
export const getMyClassAttendanceSummary = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { classId } = req.params;

    // 1. Find total held sessions for this class (Denominator)
    // const totalHeldSessions = await Attendance.countDocuments({
    //   classId: classId,
    //   // scheduledDate: { $lte: new Date() },
    //   // status: { $ne: 'cancelled' }
    // });

    const heldSessionIds = await Attendance.distinct('sessionId', {
      classId: classId,
    });
    const totalHeldSessions = heldSessionIds.length;

    // 2. Find total attended sessions for this class (Numerator)
    const totalAttendedSessions = await Attendance.countDocuments({
      studentId,
      classId: classId
    });

    // 3. Calculate percentage
    const percentage = (totalHeldSessions === 0)
      ? 100
      : (totalAttendedSessions / totalHeldSessions) * 100;

    res.status(200).json({
      message: "Class summary fetched successfully",
      summary: {
        classId,
        totalHeldSessions,
        totalAttendedSessions,
        totalMissedSessions: totalHeldSessions - totalAttendedSessions,
        percentage: parseFloat(percentage.toFixed(2))
      }
    });

  } catch (error) {
    console.error('Error fetching class summary:', error);
    res.status(500).json({ message: 'Failed to fetch class summary.' });
  }
};

// --- (NEW) Get Missed Classes ---

/**
 * @desc    Get a list of all class sessions the student has missed.
 * @route   GET /api/attendance/missed
 * @access  Private (Student)
 */
export const getMyMissedClasses = async (req, res) => {
  try {
    const studentId = req.user.id;

    // 1. Get all classes student is enrolled in
    const enrollments = await ClassEnrollment.find({ studentId }).select('classId');
    if (enrollments.length === 0) {
      return res.status(200).json({ message: "Student is not enrolled in any classes.", data: [] });
    }
    const classIds = enrollments.map(e => e.classId);

    // 2. Get all sessions that were held (past, not cancelled)
    const heldSessions = await ScheduleInstance.find({
      classId: { $in: classIds },
      scheduledDate: { $lte: new Date() },
      status: { $ne: 'cancelled' }
    })
      .populate('classId', 'subjectName subjectCode')
      .select('scheduledDate classId attendanceSessionId')
      .lean();

    // 3. Get all attendance records for this student
    // We get the `sessionId` which links to `ScheduleInstance.attendanceSessionId`
    const attendedRecords = await Attendance.find({ studentId })
      .select('sessionId')
      .lean();

    // Create a Set for fast lookup
    const attendedSessionIds = new Set(
      attendedRecords.map(rec => rec.sessionId.toString())
    );

    // 4. Filter held sessions to find the missed ones
    const missedClasses = heldSessions.filter(session => {
      // If the session had no QR code generated, it's not "missed" by the student.
      // Or, if you want to show it, you'd remove this check.
      // For this logic, we'll assume a "missed" class is one where a session
      // *was* created, but the student didn't attend.
      if (!session.attendanceSessionId) {
        return false;
      }
      
      // Return true (it's "missed") if the session's ID is NOT in the attended set
      return !attendedSessionIds.has(session.attendanceSessionId.toString());
    });

    res.status(200).json({
      message: "Missed classes fetched successfully",
      count: missedClasses.length,
      data: missedClasses
    });

  } catch (error) {
    console.error('Error fetching missed classes:', error);
    res.status(500).json({ message: 'Failed to fetch missed classes.' });
  }
};


// Get attendance records for a class (for teachers/admins)
export const getAttendanceByClass = async (req, res) => {
  try {
    const { classId } = req.params;
    const { startDate, endDate, status } = req.query;

    const query = { classId };

    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }
    if (status && status !== 'all') {
      query.status = status;
    }

    const records = await Attendance.find(query)
      .populate({
        path: 'studentId',
        select: 'fullName enrollmentNo name'
      })
      .populate({
        path: 'classId',
        select: 'classNumber subjectCode subjectName'
      })
      .sort({ timestamp: -1 });
    
    // Also, we need a list of all enrolled students to mark absentees
    const enrolledStudents = await ClassEnrollment.find({ classId }).populate('studentId', 'fullName enrollmentNo name');

    // This logic needs to be more sophisticated.
    // For a given day/session, you'd find who from the enrolled list DID NOT attend.
    // The current implementation just returns recorded presences/manual entries.

    const transformedRecords = records.map(record => ({
      _id: record._id,
      student: record.studentId ? {
        _id: record.studentId._id,
        fullName: record.studentId.fullName || record.studentId.name,
        enrollmentNo: record.studentId.enrollmentNo,
      } : null,
      classInfo: record.classId,
      attendedAt: record.timestamp,
      status: record.status,
    }));

    const stats = {
      totalEnrolled: enrolledStudents.length,
      present: transformedRecords.filter(r => r.status === 'present').length,
      absent: enrolledStudents.length - transformedRecords.filter(r => r.status === 'present').length, // Simplistic calculation
    };

    res.json({
      attendance: transformedRecords,
      stats,
    });

  } catch (error) {
    console.error('Error fetching attendance records:', error);
    res.status(500).json({ message: error.message });
  }
};


// Get attendance records for a student
export const getStudentAttendance = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { classId } = req.query; // optional filter by class

    const query = { studentId };
    if (classId) {
      query.classId = classId;
    }

    const records = await Attendance.find(query)
      .populate({
        path: 'classId',
        select: 'subjectName subjectCode'
      })
      .sort({ timestamp: -1 });

    res.json(records);
    
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ message: error.message });
  }
};

// Update an attendance record (e.g., mark as absent)
export const updateAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['present', 'absent', 'late'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const updatedRecord = await Attendance.findByIdAndUpdate(id, { status }, { new: true });

    if (!updatedRecord) {
      return res.status(404).json({ message: 'Record not found.' });
    }

    res.json(updatedRecord);
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ message: error.message });
  }
};


// Manually create an attendance record
export const createManualAttendance = async (req, res) => {
  try {
    const { studentId, classId, scheduleId, status, timestamp } = req.body;
    
    const newRecord = new Attendance({
      studentId,
      classId,
      scheduleId,
      status,
      timestamp: new Date(timestamp),
      manualEntry: true,
      markedBy: req.user.id, // Log who made the manual entry
    });

    await newRecord.save();
    res.status(201).json(newRecord);
    
  } catch (error) {
    console.error('Error with manual attendance:', error);
    res.status(500).json({ message: error.message });
  }
};

export const getAttendanceBySchedule = async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const attendanceRecords = await Attendance.find({ scheduleId: scheduleId })
      .populate('studentId', 'fullName enrollmentNo');
      
    if (!attendanceRecords) {
      return res.status(404).json({ message: 'No attendance records found for this schedule.' });
    }

    res.status(200).json(attendanceRecords);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};


export const getFullAttendanceReport = async (req, res) => {
  try {
    const { classId } = req.params;
    const { startDate, endDate, studentId } = req.query;

    const matchQuery = { classId: mongoose.Types.ObjectId(classId) };
    if (startDate) {
      matchQuery.timestamp = { $gte: new Date(startDate) };
    }
    if (endDate) {
      matchQuery.timestamp = { ...matchQuery.timestamp, $lte: new Date(endDate) };
    }
    if (studentId) {
      matchQuery.studentId = mongoose.Types.ObjectId(studentId);
    }

    const report = await Attendance.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: '$studentId',
          presentDays: {
            $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] }
          },
          absentDays: {
            $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] }
          },
          lateDays: {
            $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'studentInfo'
        }
      },
      { $unwind: '$studentInfo' },
      {
        $project: {
          _id: 0,
          studentId: '$_id',
          studentName: '$studentInfo.fullName',
          enrollmentNo: '$studentInfo.enrollmentNo',
          presentDays: 1,
          absentDays: 1,
          lateDays: 1,
          totalDays: { $add: ['$presentDays', '$absentDays', '$lateDays'] }
        }
      },
      {
        $project: {
          studentId: 1,
          studentName: 1,
          enrollmentNo: 1,
          presentDays: 1,
          absentDays: 1,
          lateDays: 1,
          totalDays: 1,
          percentage: {
            $cond: [
              { $eq: ['$totalDays', 0] },
              0,
              { $multiply: [{ $divide: ['$presentDays', '$totalDays'] }, 100] }
            ]
          }
        }
      }
    ]);

    res.json(report);
  } catch (error) {
    console.error('Error generating full report:', error);
    res.status(500).json({ message: error.message });
  }
};
