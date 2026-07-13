/**
 * Hand-authored TypeScript definitions for the Sentinel SDK. The source is
 * modern JS (not TS), so these types are the single source of truth and are
 * bundled into `dist/types/index.d.ts` by the build (see rollup.config.js).
 *
 * v2 breaking change (SEC-010):
 *   `apiKey` is no longer part of SentinelConfig. Passing it to init()
 *   throws SentinelApiKeyInBrowserError synchronously. Point `endpoint`
 *   at your own server-side proxy route instead — see the README's
 *   "Set up your proxy route" section.
 */

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

type RecommendedAction =
  | 'ALLOW'
  | 'STEP_UP_AUTH'
  | 'BLOCK'
  | 'TERMINATE_SESSION';

interface EvaluateResult {
  request_id?: string;
  user_id?: string | null;
  session_id?: string | null;
  evaluated_at?: string;
  risk: {
    score: number;
    level: RiskLevel;
    confidence?: number;
    baseline_ready?: boolean;
  };
  recommended_action: RecommendedAction;
  anomalies?: Array<{
    name: string;
    severity: RiskLevel;
    score_contribution: number;
    description: string;
    evidence?: Record<string, unknown>;
  }>;
  session?: Record<string, unknown>;
  baseline?: Record<string, unknown>;
  /** True only for the client-side fail-open fallback response. */
  degraded?: boolean;
}

interface SentinelConfig {
  /**
   * URL of YOUR OWN proxy route (e.g. `/api/sentinel-proxy`). Required.
   *
   * The SDK sends the payload here with `credentials: 'include'` — your
   * proxy authenticates the caller using the host application's own
   * session, then forwards to Sentinel with the real API key attached
   * server-side. Never point this at Sentinel's public API directly.
   */
  endpoint: string;
  /** Per-request timeout in milliseconds before failing open. Default: `3000`. */
  timeout?: number;
  /** CSS selector for fields the behavioral collector may observe. Default: `[data-sentinel-field]`. */
  fieldSelector?: string;
  /** How often (ms) automation/DevTools signals are re-checked. Default: `5000`. */
  environmentRecheckIntervalMs?: number;
  /** Called when the server recommends BLOCK or TERMINATE_SESSION. */
  onBlock?: (result: EvaluateResult) => void;
  /** Called when the server recommends STEP_UP_AUTH. */
  onChallenge?: (result: EvaluateResult) => void;
  /** Called on every evaluation, regardless of outcome. */
  onEvaluate?: (result: EvaluateResult) => void;
}

declare class SentinelApiKeyInBrowserError extends Error {
  readonly name: 'SentinelApiKeyInBrowserError';
}

declare class SentinelSDK {
  /**
   * Starts the SDK. Repeat calls after the first are ignored (with a console warning).
   *
   * @throws {SentinelApiKeyInBrowserError}
   *   if the caller passes `apiKey` — v1's config field, removed in v2
   *   because a browser-side SDK cannot safely hold a real API key.
   */
  init(config: SentinelConfig): void;

  /**
   * Stores the current user/session identifiers in memory only. Safe to call before `init()`.
   *
   * These are a CLIENT-SIDE HINT only. The server proxy MUST resolve
   * the real user from its own authenticated session before forwarding
   * — anything running in the browser can lie about these values.
   */
  identify(userId: string | number | null, sessionId: string | number | null): void;

  /**
   * Builds a payload from all collectors, sends it to the configured proxy
   * endpoint, and routes the response to configured callbacks. Always
   * resolves — never rejects — even when the network request fails.
   *
   * @throws {Error} if called before `init()`.
   */
  track(actionType: string, metadata?: Record<string, unknown>): Promise<EvaluateResult>;

  /** Tears down all collector listeners/timers. Call on SPA unmount. */
  destroy(): void;
}

declare const Sentinel: SentinelSDK;

export { SentinelApiKeyInBrowserError, SentinelSDK, Sentinel as default };
export type { EvaluateResult, RecommendedAction, RiskLevel, SentinelConfig };
