import emailjs from "@emailjs/nodejs";
import userModel from "../models/userModel.js";
import otpModel from "../models/otpModel.js";
import crypto from "crypto";

// ── Startup check: log which EmailJS env vars are present (values redacted) ──
const EJS_VARS = ["EMAILJS_SERVICE_ID","EMAILJS_TEMPLATE_ID","EMAILJS_PUBLIC_KEY","EMAILJS_PRIVATE_KEY"];
EJS_VARS.forEach(k => {
  console.log(`[OTP] ${k}: ${process.env[k] ? "✓ set" : "✗ MISSING"}`);
});


const generateOtp = () =>
  String(crypto.randomInt(100000, 1000000));

/**
 * POST /api/user/send-otp
 *
 * Generates an OTP, persists it in MongoDB (TTL: 10 min),
 * and sends it to the user's registered email address.
 *
 * userId is injected by the authUser middleware — never taken from req.body.
 */
const sendOtp = async (req, res) => {
  try {
    const userId = req.body.userId; // set by authUser after JWT verification

    // Look up the user's registered email (source of truth is the DB)
    const user = await userModel.findById(userId).select("email name");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const code = generateOtp();

    // Upsert: delete any existing OTP for this user, then save the new one.
    // This prevents OTP accumulation if the user clicks "Resend" multiple times.
    await otpModel.findOneAndDelete({ userId });
    await otpModel.create({ userId, code });

    // Send the OTP using the predefined EmailJS template.
    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      {
        to_email: user.email,
        user_name: user.name || "there",
        otp_code: code,
        expires_in_minutes: 10,
      },
      {
        publicKey: process.env.EMAILJS_PUBLIC_KEY,
        privateKey: process.env.EMAILJS_PRIVATE_KEY,
      },
    );

    res.json({ success: true, message: "Verification code sent to your registered email" });
  } catch (error) {
    // Log the full error so Render logs show the real EmailJS reason
    console.error("[OTP] sendOtp error — full details:", {
      message: error?.message,
      status: error?.status,
      text: error?.text,
      stack: error?.stack,
    });
    res.status(500).json({
      success: false,
      message: "Failed to send verification code. Please try again.",
      // expose detail in non-production so you can see it in the Render dashboard
      ...(process.env.NODE_ENV !== "production" && { detail: error?.text || error?.message }),
    });
  }
};

/**
 * POST /api/user/verify-otp
 *
 * Validates the OTP entered by the user.
 * On success, deletes the OTP document so it cannot be reused.
 *
 * Body: { code: "123456" }
 * userId is injected by authUser middleware.
 */
const verifyOtp = async (req, res) => {
  try {
    const userId = req.body.userId; // set by authUser
    const { code } = req.body;

    if (!code) {
      return res.json({ success: false, message: "Verification code is required" });
    }

    const otpRecord = await otpModel.findOne({ userId });

    if (!otpRecord) {
      return res.json({
        success: false,
        message: "Code expired. Please request a new one.",
      });
    }

    if (otpRecord.code !== String(code).trim()) {
      return res.json({ success: false, message: "Incorrect code. Please try again." });
    }

    // Verified — delete immediately so the code cannot be reused
    await otpModel.findOneAndDelete({ userId });

    res.json({ success: true, message: "Identity verified successfully" });
  } catch (error) {
    console.error("[OTP] verifyOtp error:", error.message);
    res.status(500).json({ success: false, message: "Verification failed. Please try again." });
  }
};

export { sendOtp, verifyOtp };
