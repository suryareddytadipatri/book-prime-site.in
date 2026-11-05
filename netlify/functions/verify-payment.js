// Verifies the Razorpay signature, then reduces stock (once per order).
const crypto = require("crypto");
const { db } = require("../lib/db");
const reply = (b) => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
 
exports.handler = async (event) => {
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig } = JSON.parse(event.body || "{}");
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(o + "|" + p).digest("hex");
  const ok = !!sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return reply({ ok: false });
 
  let oversold = false;
  try {
    await db.runTransaction(async (t) => {
      oversold = false; // a transaction can retry, so start clean
      const oref = db.collection("orders").doc(o);
      const os = await t.get(oref);
      if (!os.exists || os.data().status !== "created") return; // unknown or already processed
      const items = os.data().items;
      const refs = items.map((i) => db.collection("stock").doc(String(i.id)));
      const snaps = await Promise.all(refs.map((r) => t.get(r)));
      let over = false;
      items.forEach((i, k) => {
        const q = snaps[k].exists ? snaps[k].data().qty : 0;
        if (q < i.qty) over = true;
        t.set(refs[k], { qty: Math.max(0, q - i.qty) }, { merge: true });
      });
      oversold = over;
      t.update(oref, { status: over ? "paid_oversold" : "paid", paymentId: p });
    });
  } catch (e) { console.error("stock update failed", e); }
  return reply({ ok: true, oversold });
};
