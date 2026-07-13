import sentinelBlacklistModel from "../models/sentinelBlacklistModel.js";

/**
 * Marks a session as terminated. Idempotent — re-blacklisting the same
 * sessionId (e.g. a retried webhook delivery) just refreshes `reason`
 * rather than erroring on the unique index.
 */
export async function blacklist(sessionId, reason = "TERMINATE_SESSION") {
  if (!sessionId) return;
  await sentinelBlacklistModel.findOneAndUpdate(
    { sessionId },
    { sessionId, reason, createdAt: new Date() },
    { upsert: true }
  );
}

/**
 * Returns true if this session was killed by Sentinel and has not yet
 * expired off the TTL index. Called on every authenticated request, so
 * this is a single indexed lookup by design.
 */
export async function isBlacklisted(sessionId) {
  if (!sessionId) return false;
  const entry = await sentinelBlacklistModel.findOne({ sessionId }).lean();
  return Boolean(entry);
}
