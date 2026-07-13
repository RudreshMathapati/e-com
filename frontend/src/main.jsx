import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import ShopContextProvider from "./context/ShopContext.jsx";
import axios from "axios";
import { toast } from "react-toastify";
import { initSentinel, sentinelTrack } from "./sentinel.js";
import { setupLogger } from "./logger.js";

// Set up request/response/error logging before anything else
setupLogger();

// Required for cross-origin cookie flow (Vercel frontend → Render backend):
// The browser only stores a Set-Cookie from a cross-origin response when the
// originating request was made with credentials. Without this, the backend's
// `Set-Cookie: sentinel_user_token` on login is silently discarded, the cookie
// is never in the browser jar, and the Sentinel SDK's `credentials:'include'`
// finds nothing to send → 401 on every proxy call.
// The backend CORS config (config/cors.js) already has `credentials: true` and
// explicit allowed origins, so this is safe.
axios.defaults.withCredentials = true;


// Initialize the Sentinel SDK early at app boot.
//
// The endpoint is intentionally a RELATIVE path ("/api/sentinel-proxy"), not
// an absolute URL. In development, Vite's proxy (vite.config.js) forwards
// this to http://localhost:4000/api/sentinel-proxy — keeping the request
// same-origin so the httpOnly sentinel_user_token cookie is sent (SameSite=lax
// only allows cookies on same-origin or top-level navigation, not cross-origin
// fetches). In production (Vercel), the frontend and backend are separate
// deployments — set the VITE_SENTINEL_PROXY_URL env var in the Vercel frontend
// dashboard to point at your deployed backend, e.g.:
//   VITE_SENTINEL_PROXY_URL=https://your-backend.railway.app/api/sentinel-proxy
// If unset, falls back to the relative path (only works if frontend and backend
// share the same domain/origin in production).
const sentinelEndpoint =
  import.meta.env.VITE_SENTINEL_PROXY_URL || "/api/sentinel-proxy";
initSentinel({ endpoint: sentinelEndpoint });

// Global Axios Interceptor to track every state-changing action (POST/PUT/DELETE)
axios.interceptors.request.use(async (config) => {
  // Exclude internal security routes to prevent infinite loops
  const isSecurityRoute =
    config.url.includes("/api/sentinel-proxy") ||
    config.url.includes("/api/user/send-otp") ||
    config.url.includes("/api/user/verify-otp");

  if (isSecurityRoute) {
    return config;
  }

  // Derive action name from URL path (e.g. "/api/cart/add" -> "add")
  const urlParts = config.url.split("/");
  const actionName = urlParts[urlParts.length - 1] || "api_request";

  try {
    // Only intercept write/state-changing operations
    if (config.method === "post" || config.method === "put" || config.method === "delete") {
      // Don't intercept calls already manually handled in the UI files (like Login, Signup, or Order checkout)
      const isAlreadyHandledInUI =
        config.url.includes("/api/user/login") ||
        config.url.includes("/api/user/register") ||
        config.url.includes("/api/order/place") ||
        config.url.includes("/api/order/stripe") ||
        config.url.includes("/api/order/razorpay");

      if (!isAlreadyHandledInUI) {
        const verdict = await sentinelTrack(actionName, { url: config.url });

        if (verdict.recommended_action === "BLOCK") {
          toast.error("Action blocked due to security detection.");
          throw new axios.Cancel("Blocked by Sentinel");
        }

        if (verdict.recommended_action === "TERMINATE_SESSION") {
          toast.error("Session terminated due to security risk. Please login again.");
          localStorage.removeItem("token");
          window.location.href = "/login";
          throw new axios.Cancel("Session terminated by Sentinel");
        }

        if (verdict.recommended_action === "STEP_UP_AUTH") {
          toast.warn("Unusual activity detected on your session.");
        }
      }
    }
  } catch (err) {
    if (axios.isCancel(err)) {
      throw err;
    }
    console.warn("[Sentinel Interceptor] fail open on tracking error:", err);
  }

  return config;
}, (error) => {
  return Promise.reject(error);
});

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <ShopContextProvider>
      <App />
    </ShopContextProvider>
  </BrowserRouter>
);
