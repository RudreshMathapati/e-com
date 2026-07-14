import mongoose from "mongoose";

/**
 * Sessions or users Sentinel has told us to kill.
 *
 * Two entry types, because Sentinel notifies us of terminations two ways:
 *  - "session": automatic detection (webhook event "alert.created" with
 *    recommended_action TERMINATE_SESSION, or risk_level CRITICAL). Carries
 *    the real session_id — the raw JWT string, same value this app uses as
 *    both the auth token and the Sentinel session_id (see sentinelProxy.js).
 *  - "user": a manual "Kill Session" click in the Sentinel dashboard
 *    (webhook event "session.terminated_by_operator"). This event does NOT
 *    carry the original session_id — Sentinel only ever stores a one-way
 *    hash of the token it was given, so the raw value isn't recoverable —
 *    only `user_id`, the same external id this app already sends on every
 *    /evaluate call. We block by user instead: every active session for
 *    that user/admin is treated as terminated, not just the one killed.
 *
 * A Mongo collection (not an in-memory Map) is required here because the
 * backend runs as a Vercel serverless function: each invocation can land on
 * a fresh, stateless instance, so an in-memory blacklist would silently stop
 * working in production.
 *
 * TTL index auto-expires entries after 24h — long enough to outlive any
 * legitimate session for this app (JWTs here are not otherwise time-limited),
 * short enough not to grow unbounded.
 *
 * NOTE: this schema replaced an earlier version with a single unique
 * `sessionId` field. If a database already has that older index, drop it
 * manually (`db.sentinelblacklists.dropIndex("sessionId_1")`) — Mongoose's
 * autoIndex creates the new compound index but doesn't remove stale ones.
 */
const sentinelBlacklistSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["session", "user"],
    required: true,
  },
  value: {
    type: String,
    required: true,
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
sentinelBlacklistSchema.index({ type: 1, value: 1 }, { unique: true });

const sentinelBlacklistModel =
  mongoose.models.sentinelBlacklist ||
  mongoose.model("sentinelBlacklist", sentinelBlacklistSchema);

export default sentinelBlacklistModel;
