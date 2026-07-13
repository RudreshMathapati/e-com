# @sentinel-dev/sdk

Browser-side client for the Sentinel post-login session monitoring API. It
auto-collects behavioral and device signals, sends them to a proxy route on
**your own server**, and routes the response to your callbacks — nothing
more.

- **Zero runtime dependencies.** Vanilla JS, ~4.5KB gzipped (30KB budget,
  enforced by `npm run size`).
- **Fails open.** If the proxy is unreachable, times out, or errors, the SDK
  never blocks your app — it returns a safe default and moves on.
- **Three public methods.** `init`, `identify`, `track`. That's the entire
  API surface.

> **v2 breaking change (security fix).**  The SDK no longer accepts an
> `apiKey`. In v1 that key shipped inside every browser bundle and was
> visible to any visitor via DevTools. In v2 you point `endpoint` at a
> route on your own server, and the real key lives there. See
> [Set up your proxy route](#set-up-your-proxy-route) below, or copy one
> of the working reference implementations in
> [`examples/proxy/`](../../examples/proxy/) (Express, Fastify, Next.js).

## Why the architecture changed

An API key that reaches the browser is a leaked API key. Every user of your
site can open DevTools → Network and read it in plain text. In v1 the fix
was "please rotate often"; in v2 the fix is "the key never touches the
browser in the first place." The browser SDK talks to a route on your own
server; that route authenticates the caller using your existing session
and forwards the request to Sentinel with the real key attached
server-side.

## Install

```bash
npm install @sentinel-dev/sdk
```

## Quick start

```js
import Sentinel from '@sentinel-dev/sdk';

// Point at YOUR OWN proxy route — never at Sentinel's public API directly.
Sentinel.init({ endpoint: '/api/sentinel-proxy' });
Sentinel.identify(user.id, session.id);
const result = await Sentinel.track('login');
```

`track()` never throws and never rejects — `result` is always a usable
object, even if the network request failed.

> `identify(userId, sessionId)` is a **client-side correlation hint only.**
> The proxy route re-derives the real user/session from its own session
> before forwarding to Sentinel — anything running in the browser can lie
> about these values, so they must never be trusted server-side.

## Set up your proxy route

This is code that runs on **your server**, never in the browser. It sits
behind whatever auth middleware you already use, resolves the real
`user_id`/`session_id` from the server session, attaches the real
`SENTINEL_API_KEY` (from an environment variable — see
[Environment variables](#environment-variables) below), and forwards the
request.

### Express

```js
// app.js  (Node/Express, runs on YOUR server)
import express from 'express';
import { createSentinelProxy } from '@sentinel-dev/sdk/examples/proxy/express/proxy.js';
import { yourAuthMiddleware } from './auth.js';

const app = express();
app.use(express.json());

app.post(
  '/api/sentinel-proxy',
  yourAuthMiddleware,                   // populates req.user / req.session
  createSentinelProxy({
    resolveUser: (req) => ({
      userId: req.user.id,              // from YOUR session — never req.body
      sessionId: req.session.id,
    }),
  }),
);
```

### Next.js (App Router)

```ts
// app/api/sentinel-proxy/route.ts  (runs on YOUR server)
import { auth } from '@/lib/auth';       // whatever your app uses

const SENTINEL_URL = process.env.SENTINEL_API_URL!;   // server-only
const SENTINEL_KEY = process.env.SENTINEL_API_KEY!;   // server-only, NEVER NEXT_PUBLIC_

const FAIL_OPEN = {
  risk: { score: 0, level: 'LOW' as const },
  recommended_action: 'ALLOW' as const,
  degraded: true,
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const forwarded = {
    ...body,
    user_id: session.user.id,           // server-authoritative
    session_id: session.id ?? null,
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const upstream = await fetch(SENTINEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sentinel-Key': SENTINEL_KEY },
      body: JSON.stringify(forwarded),
      signal: ac.signal,
    });
    if (!upstream.ok) return Response.json(FAIL_OPEN);
    const upstreamBody = await upstream.json().catch(() => null);
    return Response.json(upstreamBody && typeof upstreamBody === 'object' ? upstreamBody : FAIL_OPEN);
  } catch {
    return Response.json(FAIL_OPEN);
  } finally {
    clearTimeout(t);
  }
}
```

For Fastify, Next.js Pages Router, and a longer-form Express version see
[`examples/proxy/`](../../examples/proxy/) in this repo.

## Environment variables

Set these on **your server**, never in the client bundler's env:

```
SENTINEL_API_KEY=<the key from the dashboard>
SENTINEL_API_URL=https://api.sentinel.dev/evaluate
```

> **Common mistake — do not do this:**
> `NEXT_PUBLIC_SENTINEL_API_KEY=...`  or  `VITE_SENTINEL_API_KEY=...`
> Those prefixes tell Next.js / Vite to inline the value into the browser
> bundle. That reintroduces exactly the leak this whole architecture
> exists to prevent. If in doubt, unset any `NEXT_PUBLIC_*` / `VITE_*`
> variant of the key and set it under the plain server-side name only.

## Migrating from v1

v1 embedded the key in the browser:

```js
// v1 — INSECURE, no longer supported
Sentinel.init({ apiKey: 'sk_live_xxx', endpoint: 'https://api.sentinel.dev/evaluate' });
```

v2 removes `apiKey` entirely. Passing it throws
`SentinelApiKeyInBrowserError` at `init()` time — the SDK will not silently
fall back, on purpose, because a silent fallback would mean the leak
continues while you upgrade.

**Migration steps (do them in this order — zero downtime):**

1. **Deploy the proxy route first.** Ship [`examples/proxy/express/proxy.js`](../../examples/proxy/express/proxy.js) (or your framework's equivalent) to your server. Leave the old browser integration alone — the proxy is idle until you point at it.
2. **Confirm the proxy works** by curling it from your server (authenticated) and verifying you get a real Sentinel response back.
3. **Update the browser code.** Replace the `Sentinel.init({ apiKey, endpoint })` call with `Sentinel.init({ endpoint: '/api/sentinel-proxy' })`. Deploy.
4. **Rotate the old key from the dashboard.** Only after step 3 is in production — until then, the old key is still what the browser is using.

Existing keys keep working during the migration; nothing on the server side
is being invalidated by this rewrite.

## Config reference

```ts
Sentinel.init({
  endpoint: '/api/sentinel-proxy',        // REQUIRED. Your proxy route.
  timeout: 3000,                          // Per-request timeout (ms) before failing open.
  fieldSelector: '[data-sentinel-field]', // Which fields BehavioralCollector may observe.
  environmentRecheckIntervalMs: 5000,     // How often automation/DevTools signals refresh.
  onBlock: (result) => {},                // Fires on recommended_action BLOCK / TERMINATE_SESSION.
  onChallenge: (result) => {},            // Fires on recommended_action STEP_UP_AUTH.
  onEvaluate: (result) => {},             // Fires on every evaluation, regardless of outcome.
});
```

Mark any input you want typing-rhythm / paste signals collected from with
`data-sentinel-field`:

```html
<input type="password" data-sentinel-field="password" />
```

### API

```ts
Sentinel.init(config: SentinelConfig): void         // throws if `apiKey` is passed
Sentinel.identify(userId: string | number | null, sessionId: string | number | null): void
Sentinel.track(actionType: string, metadata?: Record<string, unknown>): Promise<EvaluateResult>
Sentinel.destroy(): void  // tears down listeners/timers; call on SPA unmount
```

- `track()` throws if called before `init()` — that's a developer error and
  should be visible immediately, not silently swallowed.
- `track()` logs a `console.warn` (not a throw) if called before
  `identify()`, and proceeds with `user_id: null` so it never blocks your app.

## What this SDK never collects, and why

These exclusions are permanent — they are not configurable, and they will
not be added later even if they would improve detection signal:

| Never collected | Why |
| --- | --- |
| Raw keystroke content (which keys were pressed) | Typing rhythm is a strong bot/automation signal on its own; reading `event.key`/`event.code` would mean this SDK could reconstruct passwords typed into monitored fields. Only `performance.now()` timing deltas are read. |
| Clipboard content | Paste detection only needs a length and a "looks credential-shaped" boolean — the pasted text itself is read into a local variable for one synchronous handler and never stored or transmitted. |
| Raw mouse coordinates | Coordinates are buffered only long enough to compute a linearity ratio for the current 50-point window, then discarded; only the resulting score is kept. |
| GPS / precise location | Out of scope for a behavioral SDK; geolocation requires an explicit browser permission prompt this SDK will never trigger. |
| Audio fingerprint | A well-known invasive fingerprinting technique; deliberately excluded. |
| Font enumeration | Same category as audio fingerprinting — high fingerprint entropy, low legitimate value, and it's exactly what fingerprinting-resistant browsers actively try to block. |
| Battery status | Deprecated/removed from most browsers for privacy reasons; never used. |
| Camera/mic device counts | Would require `navigator.mediaDevices.enumerateDevices()`, which is unnecessary for session monitoring and reads as a red flag to privacy-conscious users. |

Additionally:

- **No storage.** No `localStorage`, `sessionStorage`, or cookies are ever
  used — every collector reads live browser state on demand.
- **No API key in the browser.** The SDK does not accept, read, or transmit
  a Sentinel API key. That's the entire point of the proxy pattern above.
- **No IP / geo / ASN / TLS fingerprint client-side.** Those are
  network-level facts about the raw HTTP request, enriched server-side from
  the actual connection — a client-supplied value would be trivially
  spoofable, so this SDK never sends one. The SDK does send
  `navigator.onLine` and, where the browser supports the Network
  Information API, `connection.{effective_type,downlink,rtt,save_data}` —
  these describe the client's own link quality, not a claim about the
  request's origin, so they don't carry the same spoofing risk.
- **No `eval`, `new Function`, or dynamic code execution**, anywhere in the
  codebase.

## Fail-open guarantee

Every network failure — DNS error, timeout, 4xx, 5xx, malformed JSON —
resolves `track()` to:

```json
{ "risk": { "score": 0, "level": "LOW" }, "recommended_action": "ALLOW", "degraded": true }
```

Check `result.degraded` if you want to distinguish a real low-risk
evaluation from a Sentinel outage.

## Framework integrations

- [`@sentinel-dev/react`](../react) — `SentinelProvider` + `useSentinel()`
- [`@sentinel-dev/vue`](../vue) — Vue 3 plugin, `this.$sentinel`
- [`@sentinel-dev/nextjs`](../nextjs) — client-component init pattern

## Building from source

```bash
npm install
npm run build   # rollup -c && npm run size — fails the build over 30KB gzipped
npm test        # vitest
```

Build outputs (all generated by `rollup.config.js`):

| File | Format | Use case |
| --- | --- | --- |
| `dist/sentinel.min.js` | IIFE, minified, `console.*` stripped | `<script>` tag, attaches `window.Sentinel` |
| `dist/sentinel.esm.js` | ES module | Modern bundlers (Vite, webpack 5+, Rollup) |
| `dist/sentinel.cjs` | CommonJS | `require()` in Node / older bundlers |
| `dist/sentinel.umd.js` | UMD | Global / AMD / CJS fallback |
| `dist/types/index.d.ts` | TypeScript declarations | Bundled via `rollup-plugin-dts` from `src/types/index.d.ts` |
