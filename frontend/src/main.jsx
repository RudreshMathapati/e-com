import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import ShopContextProvider from "./context/ShopContext.jsx";
import axios from "axios";
import { toast } from "react-toastify";
import { initSentinel, sentinelTrack } from "./sentinel.js";

// Initialize the Sentinel SDK early at app boot. The endpoint MUST be
// absolute (not a relative "/api/sentinel-proxy") — frontend and backend
// are separate Vercel deployments with no API rewrite between them, so a
// relative path would resolve against this app's own domain in production
// and silently 404 (the SDK would fail open, but Sentinel would never see
// any traffic). `credentials: 'include'` on the SDK's fetch is why the
// backend cookie is issued with SameSite=None; Secure in production —
// see backend/controllers/userController.js.
const backendUrl = import.meta.env.VITE_BACKEND_URL;
initSentinel({ endpoint: `${backendUrl}/api/sentinel-proxy` });

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
