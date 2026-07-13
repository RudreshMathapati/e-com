import nodemailer from "nodemailer";
import userModel from "../models/userModel.js";
import otpModel from "../models/otpModel.js";

/**
 * Nodemailer transporter — reads SMTP config from server-side env vars.
 * For Gmail: enable 2FA → Google Account → Security → App Passwords → generate one.
 * For other providers: update SMTP_HOST and SMTP_PORT accordingly.
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for port 465, false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/** Generates a cryptographically sufficient 6-digit numeric OTP */
const generateOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

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
      return res.json({ success: false, message: "User not found" });
    }

    const code = generateOtp();

    // Upsert: delete any existing OTP for this user, then save the new one.
    // This prevents OTP accumulation if the user clicks "Resend" multiple times.
    await otpModel.findOneAndDelete({ userId });
    await otpModel.create({ userId, code });

    // Send the OTP via email
    await transporter.sendMail({
      from: `"Forever Shop Security" <${process.env.SMTP_FROM}>`,
      to: user.email,
      subject: "Your One-Time Verification Code",
      html: `
        <div style="
          font-family: 'Segoe UI', Arial, sans-serif;
          max-width: 480px;
          margin: 0 auto;
          background: #ffffff;
          border: 1px solid #e5e5e5;
          border-radius: 12px;
          overflow: hidden;
        ">
          <div style="background: #111; padding: 24px 32px;">
            <h1 style="color: #fff; font-size: 22px; margin: 0; font-weight: 600; letter-spacing: 1px;">
              FOREVER SHOP
            </h1>
          </div>
          <div style="padding: 32px;">
            <h2 style="color: #111; font-size: 20px; margin: 0 0 8px;">Verify Your Identity</h2>
            <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 28px;">
              Hi ${user.name},<br/>
              We detected unusual activity on your account and need to verify it's really you.
              Enter the code below to continue signing in:
            </p>
            <div style="
              background: #f5f5f5;
              border-radius: 8px;
              padding: 20px;
              text-align: center;
              margin-bottom: 28px;
            ">
              <span style="
                font-size: 40px;
                font-weight: 700;
                letter-spacing: 16px;
                color: #111;
                font-family: 'Courier New', monospace;
              ">${code}</span>
            </div>
            <p style="color: #999; font-size: 12px; margin: 0;">
              This code expires in <strong>10 minutes</strong>.
              If you didn't attempt to sign in, please change your password immediately.
            </p>
          </div>
        </div>
      `,
    });

    res.json({ success: true, message: "Verification code sent to your registered email" });
  } catch (error) {
    console.error("[OTP] sendOtp error:", error);
    res.json({
      success: false,
      message: "Failed to send verification code. Please try again.",
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
    console.error("[OTP] verifyOtp error:", error);
    res.json({ success: false, message: error.message });
  }
};

export { sendOtp, verifyOtp };
