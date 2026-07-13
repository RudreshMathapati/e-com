import jwt from "jsonwebtoken";
import { isBlacklisted } from "../utils/sentinelBlacklist.js";

const authUser = async (req, res, next) => {
  // Header first (every existing route sends it this way); cookie fallback
  // exists only so the real Sentinel SDK's browser transport — which can
  // only authenticate via `credentials: 'include'` cookies, not custom
  // headers — can reach /api/sentinel-proxy.
  const token = req.headers.token || req.cookies?.sentinel_user_token;

  if (!token) {
    return res.status(401).json({ success: false, message: "Not Authorized Login Again" });
  }

  if (await isBlacklisted(token)) {
    return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
  }

  try {
    const token_decode = jwt.verify(token, process.env.JWT_SECRET);
    req.body.userId = token_decode.id;
    req.sentinelSessionId = token; // resolved header-or-cookie token, for the proxy routes
    next();
  } catch (error) {
    console.error("[Auth] JWT error:", error.message);
    res.status(401).json({ success: false, message: error.message });
  }
};

export default authUser;
