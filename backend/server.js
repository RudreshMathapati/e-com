import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import "dotenv/config";
import connectDB from "./config/mongodb.js";
import connectCloudinary from "./config/cloudinary.js";
import { corsOptions } from "./config/cors.js";
import userRouter from "./routes/userRoute.js";
import productRouter from "./routes/productRoute.js";
import cartRouter from "./routes/cartRoute.js";
import orderRouter from "./routes/orderRoute.js";
import sentinelProxy from "./routes/sentinelProxy.js";
import adminSentinelProxy from "./routes/adminSentinelProxy.js";
import sentinelWebhookRoute from "./routes/sentinelWebhookRoute.js";
import otpRouter from "./routes/otpRoute.js";

// ── Startup env validation ────────────────────────────────────────────────
// Fail fast on missing critical vars rather than silently misbehaving at
// request time. Only checked in the server.js entry point (local dev);
// api/index.js carries the same check for Vercel.
const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`[Startup] Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.SENTINEL_API_KEY) {
  console.warn("[Startup] SENTINEL_API_KEY not set — Sentinel events will fail open (no data in dashboard)");
}
if (!process.env.SENTINEL_API_URL) {
  console.warn("[Startup] SENTINEL_API_URL not set — Sentinel events will fail open (no data in dashboard)");
}

// App Config
const app = express();
const port = process.env.PORT || 4000;

// Connect services
connectDB();
connectCloudinary();

// This backend runs behind Vercel's edge network (and possibly another
// load balancer in front of that) — without this, req.ip resolves to
// that infrastructure's own address rather than the real caller's, which
// breaks resolveRealClientIp()'s final fallback (utils/sentinelForward.js).
app.set("trust proxy", 1);

// Security headers — applied before any route handler.
// contentSecurityPolicy is disabled here because the API serves only JSON;
// the frontend CSP is handled at Vercel edge headers.
app.use(helmet({ contentSecurityPolicy: false }));

// Middlewares
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(cors(corsOptions));

// Routes
// Sentinel webhook — signature-verified, sits before authUser routes
app.use("/webhooks/sentinel", sentinelWebhookRoute);

app.use("/api/user", userRouter);
app.use("/api/product", productRouter);
app.use("/api/cart", cartRouter);
app.use("/api/order", orderRouter);
app.use("/api", sentinelProxy);
app.use("/api/admin", adminSentinelProxy);
app.use("/api/user", otpRouter);

app.get("/", (req, res) => {
  res.send("API Working");
});

// Global error handler — CORS rejections become clean 403s;
// all other unhandled errors return a generic 500 (no stack trace to client).
app.use((err, req, res, next) => {
  if (err && err.message?.startsWith("[CORS]")) {
    return res.status(403).json({ success: false, message: "Origin not allowed" });
  }
  console.error("[Server] Unhandled error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// Start server only when running locally
if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`[Server] Started on PORT: ${port}`);
  });
}

// Export app for Vercel
export default app;