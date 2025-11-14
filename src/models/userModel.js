/**
 * @file userModel.js
 * @description Defines the Mongoose schema for a User. This model stores
 * information for all user types (student, teacher, admin), including
 * credentials, roles, and profile information.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * @schema userSchema
 * @description Schema definition for the User model.
 */
const userSchema = new mongoose.Schema({
  /**
   * Enrollment number, required only for students.
   * Indexed for unique, fast lookups. Sparse index allows multiple nulls.
   */
  enrollmentNo: {
    type: String,
    required: function() { return this.role === 'student'; },
    index: { unique: true, sparse: true } // Only enforce uniqueness for non-null values
  },
  /**
   * User's email address. Must be unique and is stored in lowercase.
   */
  email: { type: String, unique: true, required: true, lowercase: true },
  /**
   * User's hashed password.
   */
  password: { type: String, required: true },
  /**
   * User's full name.
   */
  fullName: { type: String, required: true },
  /**
   * User's role, restricted to 'teacher', 'student', or 'admin'.
   */
  role: { type: String, enum: ['teacher', 'student', 'admin'], required: true },
  /**
   * Class year, required only for students. (e.g., "FE", "SE", "TE", "BE")
   */
  classYear: {
    type: String,
    required: function() { return this.role === 'student'; }
  },
  /**
   * Current semester, required only for students. (e.g., "I", "II", "VII")
   */
  semester: {
    type: String,
    required: function() { return this.role === 'student'; }
  },
  division: {
    type: String,
    required: false,
  },
  /**
   * The S3 object key for the user's registered face image.
   * This replaces storing a large embedding directly in the database.
   */
  faceImageS3Key: { type: String, default: null },
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt fields
  strict: true      // Prevents non-schema fields from being saved
});

/**
 * @function pre-save
 * @description Mongoose pre-save hook to automatically hash the user's
 * password before saving it to the database, only if it has been modified.
 */
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

/**
 * @method matchPassword
 * @description Instance method on the userSchema to compare an entered
 * password with the stored hashed password.
 * @param {string} enteredPassword - The plain-text password to compare.
 * @returns {Promise<boolean>} True if the passwords match, false otherwise.
 */
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

/**
 * @model User
 * @description Mongoose model compiled from the userSchema.
 */
export const User = mongoose.model('User', userSchema);
