/**
 * logger.js — logs every Axios request/response/error + Sentinel verdicts.
 * Call setupLogger() once in main.jsx before anything else.
 */
import axios from "axios";

export function setupLogger() {
  // ── Request ──────────────────────────────────────────────────────────
  axios.interceptors.request.use(
    (config) => {
      console.log(
        `%c→ ${config.method?.toUpperCase()} ${config.url}`,
        "color:#6366f1;font-weight:bold;"
      );
      return config;
    },
    (error) => {
      console.error("✗ Request setup error:", error.message);
      return Promise.reject(error);
    }
  );

  // ── Response ──────────────────────────────────────────────────────────
  axios.interceptors.response.use(
    (response) => {
      console.log(
        `%c← ${response.status} ${response.config.url}`,
        "color:#10b981;font-weight:bold;"
      );
      return response;
    },
    (error) => {
      const status = error.response?.status ?? "ERR";
      const url    = error.config?.url ?? "unknown";

      // Re-attach the server's human-readable message onto the error so
      // every existing `catch (e) { toast.error(e.message) }` block shows
      // the real reason instead of "Request failed with status code 4xx".
      if (error.response?.data?.message) {
        error.message = error.response.data.message;
      }

      console.error(
        `%c✗ ${status} ${url}`,
        "color:#ef4444;font-weight:bold;",
        error.message
      );
      return Promise.reject(error);
    }
  );
}

// ── Sentinel evaluate logging ─────────────────────────────────────────────
// Called from sentinel.js wrapper around Sentinel.track().

export function logSentinelTrack(action, metadata) {
  console.groupCollapsed(
    `%c🛡️ Sentinel → evaluate("%c${action}%c")`,
    "color:#7c3aed;font-weight:bold;",
    "color:#7c3aed;font-weight:bold;font-style:italic;",
    "color:inherit;font-weight:normal;"
  );
  console.log("action  :", action);
  console.log("metadata:", metadata);
  console.groupEnd();
}

export function logSentinelVerdict(action, verdict) {
  const ra = verdict?.recommended_action ?? "unknown";
  const score = verdict?.risk?.score ?? "?";
  const level = verdict?.risk?.level ?? "?";
  const degraded = verdict?.degraded === true;

  const color =
    ra === "ALLOW"                               ? "#10b981" :
    ra === "BLOCK" || ra === "TERMINATE_SESSION" ? "#ef4444" :
    ra === "STEP_UP_AUTH"                        ? "#f59e0b" : "#6b7280";

  const badge =
    ra === "ALLOW"            ? "✅ ALLOW" :
    ra === "BLOCK"            ? "🚫 BLOCK" :
    ra === "TERMINATE_SESSION"? "💀 TERMINATE" :
    ra === "STEP_UP_AUTH"     ? "🔐 STEP_UP_AUTH" : ra;

  console.groupCollapsed(
    `%c🛡️ Sentinel ← verdict("%c${action}%c") ${badge}${degraded ? " [fail-open]" : ""}`,
    `color:${color};font-weight:bold;`,
    `color:${color};font-weight:bold;font-style:italic;`,
    `color:${color};font-weight:bold;`
  );
  console.log("verdict :", badge);
  console.log("risk    :", level, "| score:", score);
  if (degraded) {
    console.warn("⚠️ Sentinel unreachable — failed open (no log recorded in dashboard)");
    if (verdict?.fail_reason)    console.warn("reason  :", verdict.fail_reason);
    if (verdict?.upstream_status) console.warn("upstream:", verdict.upstream_status, verdict?.upstream_body ?? "");
  }
  if (verdict?.shadow_verdict) console.log("shadow  :", verdict.shadow_verdict, "(enforced as ALLOW)");
  console.log("raw     :", verdict);
  console.groupEnd();
}
