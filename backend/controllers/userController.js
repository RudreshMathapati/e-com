import validator from "validator";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import userModel from "../models/userModel.js";

// 7-day expiry matches the cookie maxAge so tokens and cookies
// expire together — a token never outlives its cookie.
const TOKEN_TTL = "7d";

const createToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
};

/**
 * Sets an httpOnly cookie carrying the same JWT already returned in the
 * response body. This is ONLY consumed by the Sentinel proxy routes — the
 * real @sentinel-dev/sdk browser transport authenticates via
 * `credentials: 'include'` (cookies) and cannot attach the custom `token`
 * header every other route here uses. All other routes are unaffected;
 * they keep reading the header exactly as before.
 */
const setSentinelCookie = (res, name, token) => {
  res.cookie(name, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

// Route for user login
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const user = await userModel.findOne({ email });

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const token = createToken(user._id);
    setSentinelCookie(res, "sentinel_user_token", token);
    res.json({ success: true, token });
  } catch (error) {
    console.error("[Auth] loginUser error:", error.message);
    res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
};

// Route for user registration
const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const exists = await userModel.findOne({ email });
    if (exists) {
      return res.status(409).json({ success: false, message: "User already exists" });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Please enter a stronger password (min 8 characters)" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new userModel({ name, email, password: hashedPassword });
    const user = await newUser.save();

    const token = createToken(user._id);
    setSentinelCookie(res, "sentinel_user_token", token);
    res.status(201).json({ success: true, token });
  } catch (error) {
    console.error("[Auth] registerUser error:", error.message);
    res.status(500).json({ success: false, message: "Registration failed. Please try again." });
  }
};

// Route for admin login
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      email === process.env.ADMIN_EMAIL &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = jwt.sign(
        { role: "admin", email },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_TTL }
      );
      setSentinelCookie(res, "sentinel_admin_token", token);
      res.json({ success: true, token });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (error) {
    console.error("[Auth] adminLogin error:", error.message);
    res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
};

export { loginUser, registerUser, adminLogin };
