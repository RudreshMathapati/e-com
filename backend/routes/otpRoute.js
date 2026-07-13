import express from "express";
import authUser from "../middleware/auth.js";
import { sendOtp, verifyOtp } from "../controllers/otpController.js";

const otpRouter = express.Router();

// Both routes sit behind authUser — an unauthenticated request cannot
// send or verify an OTP (no JWT = 401 from authUser).
otpRouter.post("/send-otp", authUser, sendOtp);
otpRouter.post("/verify-otp", authUser, verifyOtp);

export default otpRouter;
