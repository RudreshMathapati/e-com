import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import "dotenv/config";

import connectDB from "../config/mongodb.js";
import connectCloudinary from "../config/cloudinary.js";
import { corsOptions } from "../config/cors.js";

import userRouter from "../routes/userRoute.js";
import productRouter from "../routes/productRoute.js";
import cartRouter from "../routes/cartRoute.js";
import orderRouter from "../routes/orderRoute.js";
import sentinelProxy from "../routes/sentinelProxy.js";
import adminSentinelProxy from "../routes/adminSentinelProxy.js";
import sentinelWebhookRoute from "../routes/sentinelWebhookRoute.js";
import otpRouter from "../routes/otpRoute.js";

// ── Startup env validation ────────────────────────────────────────────────
// Vercel serverless functions run this file on each cold start. Fail-fast
// on missing critical vars so errors surface immediately in Vercel logs.
const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`[Startup] Missing required environment variables: ${missing.join(", ")}`);
  // In serverless env we cannot process.exit — log and let the first request fail
  // with a clear error rather than a cryptic undefined-read later.
}
if (!process.env.SENTINEL_API_KEY) {
  console.warn("[Startup] SENTINEL_API_KEY not set — Sentinel events will fail open");
}
if (!process.env.SENTINEL_API_URL) {
  console.warn("[Startup] SENTINEL_API_URL not set — Sentinel events will fail open");
}

const app = express();

connectDB();
connectCloudinary();

// Security headers — applied before any route handler
app.use(helmet({ contentSecurityPolicy: false }));

// Body parsing with explicit size limit
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(cors(corsOptions));

// Sentinel async webhook — signature-verified, no auth middleware needed
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

export default app;