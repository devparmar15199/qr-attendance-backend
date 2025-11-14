import { User } from '../../models/userModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '30d' });
};

// Register Teacher
export const registerTeacher = async (req, res) => {
  console.log('Teacher registration request received:', req.body);
  try {
    const { name, fullName, email, password, role } = req.body;
    // Use fullName if provided, otherwise use name
    const teacherName = fullName || name;
    console.log('Extracted teacher data:', { name: teacherName, email });

    // Validate required fields
    if (!teacherName || !email || !password) {
      return res.status(400).json({ 
        message: 'Name, email, and password are required for teachers' 
      });
    }

    // Check if user exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      console.log('User already exists with email:', email);
      return res.status(400).json({ message: 'User already exists' });
    }

    console.log('Creating new teacher...');
    // Note: Password will be hashed by pre-save hook in User model
    
    // Create teacher user data
    const userData = {
      fullName: teacherName,
      email,
      password, // Will be hashed by pre-save hook
      role
    };

    console.log('Creating teacher with data:', { ...userData, password: '[HIDDEN]' });

    // Create user
    const user = await User.create(userData);

    console.log('Teacher created successfully:', user._id);

    if (user) {
      res.status(201).json({
        _id: user._id,
        name: user.fullName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        token: generateToken(user._id)
      });
    } else {
      console.log('Failed to create teacher');
      res.status(400).json({ message: 'Invalid teacher data' });
    }
  } catch (error) {
    console.error('Teacher registration error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Login Teacher
export const loginTeacher = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check for user email and ensure it's a teacher
    const user = await User.findOne({ email });

    if (user && (await bcrypt.compare(password, user.password))) {
      res.json({
        _id: user._id,
        name: user.fullName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        token: generateToken(user._id)
      });
    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get Teacher Profile
export const getTeacherProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user || user.role !== 'teacher') {
      return res.status(404).json({ message: 'Teacher not found' });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update Teacher Profile
export const updateTeacherProfile = async (req, res) => {
  try {
    const { name, fullName, email } = req.body;
    const user = await User.findById(req.user.id);

    if (!user || user.role !== 'teacher') {
      return res.status(404).json({ message: 'Teacher not found' });
    }

    // Use fullName if provided, otherwise use name
    if (fullName) user.fullName = fullName;
    else if (name) user.fullName = name;
    if (email) user.email = email;

    const updatedUser = await user.save();

    res.json({
      _id: updatedUser._id,
      name: updatedUser.fullName,
      fullName: updatedUser.fullName,
      email: updatedUser.email,
      role: updatedUser.role,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
