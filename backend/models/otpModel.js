import mongoose from "mongoose";

/**
 * Stores one-time passwords for MFA verification.
 * The TTL index on `createdAt` makes MongoDB automatically delete
 * expired OTP documents after 600 seconds (10 minutes).
 * Only one OTP per user is allowed at a time (unique userId index).
 */
const otpSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
    unique: true, // one active OTP per user at a time
  },
  code: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600, // TTL: MongoDB auto-deletes after 10 minutes
  },
});

const otpModel = mongoose.models.otp || mongoose.model("otp", otpSchema);

export default otpModel;
