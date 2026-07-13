import mongoose from "mongoose";

/**
 * Sessions Sentinel has told us to kill (TERMINATE_SESSION / CRITICAL risk).
 * sessionId is the raw JWT string — the same value this app already uses
 * as both the auth token and the Sentinel session_id (see sentinelProxy.js).
 *
 * A Mongo collection (not an in-memory Map) is required here because the
 * backend runs as a Vercel serverless function: each invocation can land on
 * a fresh, stateless instance, so an in-memory blacklist would silently stop
 * working in production.
 *
 * TTL index auto-expires entries after 24h — long enough to outlive any
 * legitimate session for this app (JWTs here are not otherwise time-limited),
 * short enough not to grow unbounded.
 */
const sentinelBlacklistSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  reason: {
    type: String,
    default: "TERMINATE_SESSION",
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24, // TTL: MongoDB auto-deletes after 24 hours
  },
});

const sentinelBlacklistModel =
  mongoose.models.sentinelBlacklist ||
  mongoose.model("sentinelBlacklist", sentinelBlacklistSchema);

export default sentinelBlacklistModel;
