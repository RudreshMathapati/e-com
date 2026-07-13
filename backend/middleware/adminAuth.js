import jwt from "jsonwebtoken";
import { isBlacklisted } from "../utils/sentinelBlacklist.js";

const adminAuth = async (req, res, next) => {
  try {
    // Header first (existing routes); cookie fallback lets the real
    // Sentinel SDK's cookie-only browser transport reach the admin proxy.
    const token = req.headers.token || req.cookies?.sentinel_admin_token;
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not Authorized Login Again",
      });
    }

    if (await isBlacklisted(token)) {
      return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
    }

    const token_decode = jwt.verify(token, process.env.JWT_SECRET);
    // Admin token payload is { role: 'admin', email } — reject anything else.
    if (token_decode.role !== "admin" || token_decode.email !== process.env.ADMIN_EMAIL) {
      return res.status(401).json({
        success: false,
        message: "Not Authorized Login Again",
      });
    }
    req.sentinelSessionId = token;
    next();
  } catch (error) {
    console.error("[AdminAuth] error:", error.message);
    res.status(401).json({ success: false, message: error.message });
  }
};

export default adminAuth;
