import orderModel from "../models/orderModel.js";
import userModel from "../models/userModel.js";
import Stripe from "stripe";
import Razorpay from "razorpay";
import crypto from "crypto";

// global variables
const currency = "USD";
const deliveryCharge = 10;

// gateway initialize
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Initialize Razorpay only when keys are present to avoid startup crash
let razorpayInstance = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn("[Orders] Razorpay keys not set — Razorpay endpoints will return an error until configured.");
}

// Placing orders using COD Method
const placeOrder = async (req, res) => {
  try {
    const { userId, items, amount, address } = req.body;

    if (!userId || !items || !amount || !address) {
      return res.status(400).json({ success: false, message: "Missing required order fields" });
    }

    const orderData = {
      userId,
      items,
      address,
      amount,
      paymentMethod: "COD",
      payment: false,
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    res.json({ success: true, message: "Order Placed" });
  } catch (error) {
    console.error("[Orders] placeOrder error:", error.message);
    res.status(500).json({ success: false, message: "Failed to place order. Please try again." });
  }
};

// Placing orders using Stripe Method
const placeOrderStripe = async (req, res) => {
  try {
    const { userId, items, amount, address } = req.body;
    const { origin } = req.headers;

    if (!userId || !items || !amount || !address) {
      return res.status(400).json({ success: false, message: "Missing required order fields" });
    }

    const orderData = {
      userId,
      items,
      address,
      amount,
      paymentMethod: "Stripe",
      payment: false,
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();

    const line_items = items.map((item) => ({
      price_data: {
        currency: currency,
        product_data: { name: item.name },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    line_items.push({
      price_data: {
        currency: currency,
        product_data: { name: "Delivery Charges" },
        unit_amount: Math.round(deliveryCharge * 100),
      },
      quantity: 1,
    });

    const session = await stripe.checkout.sessions.create({
      success_url: `${origin}/verify?success=true&orderId=${newOrder._id}`,
      cancel_url: `${origin}/verify?success=false&orderId=${newOrder._id}`,
      line_items,
      mode: "payment",
    });

    // Store the Stripe session ID on the order so verifyStripe can
    // confirm payment_status server-side instead of trusting the client.
    await orderModel.findByIdAndUpdate(newOrder._id, { stripeSessionId: session.id });

    res.json({ success: true, session_url: session.url });
  } catch (error) {
    console.error("[Orders] placeOrderStripe error:", error.message);
    res.status(500).json({ success: false, message: "Failed to create Stripe checkout. Please try again." });
  }
};

// Placing orders using Razorpay Method
const placeOrderRazorpay = async (req, res) => {
  try {
    if (!razorpayInstance) {
      return res.status(503).json({ success: false, message: "Razorpay not configured on server" });
    }
    const { userId, items, amount, address } = req.body;

    if (!userId || !items || !amount || !address) {
      return res.status(400).json({ success: false, message: "Missing required order fields" });
    }

    const orderData = {
      userId,
      items,
      address,
      amount,
      paymentMethod: "Razorpay",
      payment: false,
      date: Date.now(),
    };

    const newOrder = new orderModel(orderData);
    await newOrder.save();

    const amountInPaise = Math.round(amount * 100);
    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: newOrder._id.toString(),
    };

    const order = await razorpayInstance.orders.create(options);
    res.json({ success: true, order, key_id: process.env.RAZORPAY_KEY_ID, orderId: newOrder._id });
  } catch (error) {
    console.error("[Orders] placeOrderRazorpay error:", error.message);
    res.status(500).json({ success: false, message: "Failed to create Razorpay order. Please try again." });
  }
};

// Verify Razorpay — uses crypto.timingSafeEqual to prevent timing attacks
const verifyRazorpay = async (req, res) => {
  try {
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ success: false, message: "Razorpay secret not configured on server" });
    }
    const { orderId, razorpay_payment_id, razorpay_order_id, razorpay_signature, userId } = req.body;

    if (!orderId || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing required payment verification fields" });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // Use timingSafeEqual to prevent timing-based signature attacks
    const sigA = Buffer.from(generated_signature, "hex");
    const sigB = Buffer.from(razorpay_signature, "hex");
    const signatureValid =
      sigA.length === sigB.length && crypto.timingSafeEqual(sigA, sigB);

    if (!signatureValid) {
      console.warn("[Orders] Razorpay signature mismatch", { orderId });
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    await orderModel.findByIdAndUpdate(orderId, { payment: true, paymentMethod: "Razorpay" });
    await userModel.findByIdAndUpdate(userId, { cartData: {} });
    res.json({ success: true });
  } catch (error) {
    console.error("[Orders] verifyRazorpay error:", error.message);
    res.status(500).json({ success: false, message: "Payment verification failed. Please try again." });
  }
};

// Verify Stripe — retrieves the Stripe session server-side to confirm
// payment_status === 'paid' instead of trusting req.body.success.
const verifyStripe = async (req, res) => {
  const { orderId, success, userId } = req.body;

  try {
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    if (success === "true") {
      // Look up the order and retrieve the stored Stripe session ID
      const order = await orderModel.findById(orderId);
      if (!order) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      if (order.stripeSessionId) {
        // Server-side verification: retrieve session from Stripe and check payment_status
        const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        if (session.payment_status !== "paid") {
          console.warn("[Orders] Stripe session not paid", { orderId, payment_status: session.payment_status });
          return res.status(402).json({ success: false, message: "Payment not completed" });
        }
      } else {
        // Fallback for orders created before stripeSessionId was stored
        console.warn("[Orders] No stripeSessionId on order — falling back to client success flag", { orderId });
      }

      await orderModel.findByIdAndUpdate(orderId, { payment: true });
      await userModel.findByIdAndUpdate(userId, { cartData: {} });
      res.json({ success: true });
    } else {
      await orderModel.findByIdAndDelete(orderId);
      res.json({ success: false });
    }
  } catch (error) {
    console.error("[Orders] verifyStripe error:", error.message);
    res.status(500).json({ success: false, message: "Payment verification failed. Please try again." });
  }
};

// All Orders data for Admin Panel
const allOrders = async (req, res) => {
  try {
    const orders = await orderModel.find({});
    res.json({ success: true, orders });
  } catch (error) {
    console.error("[Orders] allOrders error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
};

// User Order Data for Frontend
const userOrders = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }
    const orders = await orderModel.find({ userId });
    res.json({ success: true, orders });
  } catch (error) {
    console.error("[Orders] userOrders error:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
};

// update order status from Admin Panel
const updateStatus = async (req, res) => {
  try {
    const { orderId, status } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({ success: false, message: "orderId and status are required" });
    }
    await orderModel.findByIdAndUpdate(orderId, { status });
    res.json({ success: true, message: "Status Updated" });
  } catch (error) {
    console.error("[Orders] updateStatus error:", error.message);
    res.status(500).json({ success: false, message: "Failed to update order status." });
  }
};

export {
  verifyStripe,
  placeOrder,
  placeOrderStripe,
  placeOrderRazorpay,
  verifyRazorpay,
  allOrders,
  userOrders,
  updateStatus,
};
