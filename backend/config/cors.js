/**
 * Shared CORS options for server.js and api/index.js (Vercel serverless entry).
 *
 * Sentinel cookies (sentinel_user_token / sentinel_admin_token) require
 * `credentials: true` — a wildcard origin ("*") is rejected by browsers
 * whenever credentials are involved, so origins must be an explicit list.
 *
 * ALLOWED_ORIGINS is a comma-separated list of origins (no trailing slash),
 * e.g. "https://forever-frontend-delta-five.vercel.app,https://forever-admin-jet.vercel.app"
 */
const DEV_DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:5174"];

const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : DEV_DEFAULT_ORIGINS;

export const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser tools (curl, server-to-server, health checks) which
    // send no Origin header at all.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`[CORS] Origin not allowed: ${origin}`));
  },
  credentials: true,
};
