// Creates a Razorpay order. Amount is calculated HERE, never trusted from the browser.
const { db, auth: fbAuth } = require("../lib/db");
const PRICES = {1:399,2:499,3:299,4:250,5:299,6:20,7:225,8:699,9:199,10:349}; // same ids/prices as the books list in index.html
const COUPONS = { WELCOME10: 10 };
const SHIPPING_FEE = 50;

const reply = (s, b) => ({ statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  try {
    const { items = [], coupon, state, pin, idToken } = JSON.parse(event.body || "{}");
    // Who is buying? Verified on the server so nobody can attach an order to someone else's account.
    let uid, email;
    try { const t = await fbAuth.verifyIdToken(idToken); uid = t.uid; email = t.email || null; }
    catch (e) { console.error("verifyIdToken failed:", e.code, e.message); return reply(401, { error: "Login check failed (" + (e.code || "error") + "): " + String(e.message || "").slice(0, 140) }); }
    if (!Array.isArray(items) || !items.length) return reply(400, { error: "Invalid cart" });
    // Merge repeated ids so the same book can't be counted twice to get past the stock check
    const merged = {};
    let sub = 0;
    for (const i of items) {
      const p = PRICES[i.id];
      if (!p || !Number.isInteger(i.qty) || i.qty < 1) return reply(400, { error: "Invalid cart" });
      merged[i.id] = (merged[i.id] || 0) + i.qty;
      sub += p * i.qty;
    }
    const lines = Object.entries(merged).map(([id, qty]) => ({ id: Number(id), qty }));
    if (lines.some((l) => l.qty > 20) || !sub || !state) return reply(400, { error: "Invalid order" });
    // Stock check: refuse the order if anything is sold out or short
    const refs = lines.map((l) => db.collection("stock").doc(String(l.id)));
    const snaps = await db.getAll(...refs);
    for (let k = 0; k < lines.length; k++) {
      const q = snaps[k].exists ? snaps[k].data().qty : 0;
      if (q < lines[k].qty) return reply(409, { error: q <= 0 ? "Sorry, a book in your cart just sold out." : "Only " + q + " copies left of a book in your cart." });
    }
    const disc = COUPONS[coupon] ? Math.round(sub * COUPONS[coupon] / 100) : 0;
    const shipping = (state === "Telangana" && /^500\d{3}$/.test(String(pin || "").trim())) ? 0 : SHIPPING_FEE; // free in Hyderabad
    const amount = (sub - disc + shipping) * 100; // paise

    const auth = Buffer.from(process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET).toString("base64");
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, currency: "INR", receipt: "bp_" + Date.now() }),
    });
    const o = await r.json();
    if (!r.ok) return reply(502, { error: (o.error && o.error.description) || "Razorpay error" });
    await db.collection("orders").doc(o.id).set({ items: lines, amount: o.amount, coupon: coupon || null, state, status: "created", uid, email, subtotal: sub, discount: disc, shipping, createdAt: new Date() });
    return reply(200, { order_id: o.id, amount: o.amount, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    return reply(500, { error: "Server error" });
  }
};
