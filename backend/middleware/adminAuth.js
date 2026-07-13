import jwt from "jsonwebtoken";
import { isBlacklisted } from "../utils/sentinelBlacklist.js";

const adminAuth = async (req, res, next) => {
  try {
    // Header first (existing routes); cookie fallback lets the real
    // Sentinel SDK's cookie-only browser transport reach the admin proxy.
    const token = req.headers.token || req.cookies?.sentinel_admin_token;
    if (!token) {
      return res.json({
        success: false,
        message: "Not Authorized Login Again",
      });
    }

    if (await isBlacklisted(token)) {
      return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
    }

    const token_decode = jwt.verify(token, process.env.JWT_SECRET);
    if (token_decode !== process.env.ADMIN_EMAIL + process.env.ADMIN_PASSWORD) {
      return res.json({
        success: false,
        message: "Not Authorized Login Again",
      });
    }
    req.sentinelSessionId = token; // resolved header-or-cookie token, for the admin proxy route
    next();
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

export default adminAuth;
