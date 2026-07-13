import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
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

// App Config
const app = express();
const port = process.env.PORT || 4000;
connectDB();
connectCloudinary();

// middlewares
app.use(express.json());
app.use(cookieParser());
app.use(cors(corsOptions));

// Sentinel async webhook — signature-verified, no auth middleware needed
app.use("/webhooks/sentinel", sentinelWebhookRoute);

// api endpoints
app.use("/api/user", userRouter);
app.use("/api/product", productRouter);
app.use("/api/cart", cartRouter);
app.use("/api/order", orderRouter);
app.use("/api", sentinelProxy);          // POST /api/sentinel-proxy
app.use("/api/admin", adminSentinelProxy); // POST /api/admin/sentinel-proxy
app.use("/api/user", otpRouter);         // POST /api/user/send-otp, /api/user/verify-otp

app.get("/", (req, res) => {
  res.send("API Working");
});

// Turns a disallowed-origin CORS rejection (config/cors.js) into a clean
// 403 instead of Express's default error handler, which would otherwise
// leak a full filesystem stack trace to whatever origin made the request.
app.use((err, req, res, next) => {
  if (err && err.message?.startsWith("[CORS]")) {
    return res.status(403).json({ success: false, message: "Origin not allowed" });
  }
  next(err);
});

app.listen(port, () => console.log("Server started on PORT : " + port));
