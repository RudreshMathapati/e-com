import sentinelBlacklistModel from "../models/sentinelBlacklistModel.js";

/**
 * Marks a single session as terminated (automatic detection — webhook
 * event "alert.created" with TERMINATE_SESSION/CRITICAL). Idempotent — a
 * retried webhook delivery just refreshes `reason`.
 */
export async function blacklistSession(sessionId, reason = "TERMINATE_SESSION") {
  if (!sessionId) return;
  await sentinelBlacklistModel.findOneAndUpdate(
    { type: "session", value: sessionId },
    { type: "session", value: sessionId, reason, createdAt: new Date() },
    { upsert: true }
  );
}

/**
 * Marks EVERY session for a user/admin as terminated (manual dashboard
 * action — webhook event "session.terminated_by_operator"). Sentinel only
 * ever stores a one-way hash of the session token, so that event can't
 * carry the original session_id — user_id is all we have, and blocking by
 * user is the only way to actually stop the killed session.
 */
export async function blacklistUser(userId, reason = "session.terminated_by_operator") {
  if (!userId) return;
  await sentinelBlacklistModel.findOneAndUpdate(
    { type: "user", value: String(userId) },
    { type: "user", value: String(userId), reason, createdAt: new Date() },
    { upsert: true }
  );
}

/**
 * Returns true if this exact session, or the user it belongs to, was
 * killed by Sentinel and hasn't yet expired off the TTL index. Called on
 * every authenticated request — a single indexed query covers both entry
 * types so there's only one round trip regardless of which kind fired.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} [params.userId] omit if not yet known (e.g. before JWT verification)
 */
export async function isBlacklisted({ sessionId, userId }) {
  if (!sessionId && !userId) return false;
  const or = [];
  if (sessionId) or.push({ type: "session", value: sessionId });
  if (userId) or.push({ type: "user", value: String(userId) });

  const entry = await sentinelBlacklistModel.findOne({ $or: or }).lean();
  return Boolean(entry);
}
