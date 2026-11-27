import "./_test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import handler, { resetDemoRequestLimits } from "../api/demo-request.js";

function install({ key = "re_test", status = 200 } = {}) {
  const originalFetch = global.fetch, originalEnv = { ...process.env };
  if (key) process.env.RESEND_API_KEY = key; else delete process.env.RESEND_API_KEY;
  const sent = [];
  global.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.resend.com/emails") { sent.push(JSON.parse(options.body)); return new Response("{}", { status }); }
    throw new Error(`Unexpected URL: ${url}`);
  };
  resetDemoRequestLimits();
  return { sent, restore() { global.fetch = originalFetch; process.env = originalEnv; } };
}

async function call({ method = "POST", origin = "https://tymrak.com", body, ip = "203.0.113.7" } = {}) {
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; }, end() { return this; }, headers };
  await handler({ method, headers: { origin, "x-forwarded-for": `${ip}, 10.0.0.1` }, body }, res);
  return res;
}

const good = { topic: "demo", name: "Maya Patel", business: "Bright Smile Dental", email: "Maya@BrightSmile.ca", phone: "(416) 555-0199",
  size: "11–25", message: "We have two clinics.\nCan we see geofencing?", website: "", elapsedMs: 12000 };

test("a request is emailed to info@tymrak.com with the visitor as reply-to", async () => {
  const env = install();
  try {
    const res = await call({ body: good });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { success: true });
    assert.equal(res.headers["Access-Control-Allow-Origin"], "https://tymrak.com");
    const [mail] = env.sent;
    assert.deepEqual(mail.to, ["info@tymrak.com"]);
    assert.equal(mail.reply_to, "maya@brightsmile.ca");
    assert.equal(mail.from, "TYMRAK <invite@tymrak.com>");
    assert.equal(mail.subject, "Demo request: Bright Smile Dental (Maya Patel)");
    assert.match(mail.text, /Phone: \(416\) 555-0199\nEmployees: 11–25\nSent from: tymrak\.com/);
    assert.match(mail.text, /Message:\nWe have two clinics\.\nCan we see geofencing\?/);
  } finally { env.restore(); }
});

test("partnership requests are labelled, and everything from the visitor is escaped", async () => {
  const env = install();
  try {
    await call({ origin: "https://www.tymrak.com", body: { ...good, topic: "partner", name: "<b>Eve</b>", business: "A & B\r\nBcc: x@y.z", message: "<script>alert(1)</script>" } });
    const [mail] = env.sent;
    assert.equal(mail.subject, "Partnership inquiry: A & B Bcc: x@y.z (<b>Eve</b>)", "no line breaks in the subject");
    assert.doesNotMatch(mail.html, /<script>|<b>Eve<\/b>/);
    assert.match(mail.html, /&lt;script&gt;/);
  } finally { env.restore(); }
});

test("other websites can't use it", async () => {
  const env = install();
  try {
    for (const origin of ["https://evil.example", "http://tymrak.com", null]) {
      const res = await call({ origin, body: good });
      assert.equal(res.statusCode, 403, String(origin));
      assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
    }
    assert.equal((await call({ method: "OPTIONS" })).statusCode, 204);
    assert.equal((await call({ method: "OPTIONS", origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await call({ method: "GET" })).statusCode, 405);
    assert.equal(env.sent.length, 0);
  } finally { env.restore(); }
});

test("bots get a quiet 'success' and nothing is sent", async () => {
  const env = install();
  try {
    assert.equal((await call({ body: { ...good, website: "http://spam" } })).statusCode, 200);
    assert.equal((await call({ body: { ...good, elapsedMs: 800 } })).statusCode, 200);
    assert.equal((await call({ body: { ...good, elapsedMs: undefined } })).statusCode, 200);
    assert.equal(env.sent.length, 0);
  } finally { env.restore(); }
});

test("missing or bad fields are explained", async () => {
  const env = install();
  try {
    const res = await call({ body: { ...good, name: "", email: "maya@", phone: "call me" } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, "Please enter your name, a valid email address, a valid phone number (or leave it empty).");
    assert.equal((await call({ body: { ...good, message: "x".repeat(2001) } })).statusCode, 400);
    assert.equal((await call({ body: { ...good, phone: "", size: "lots" } })).statusCode, 200, "phone and size are optional; an unknown size is dropped");
    assert.doesNotMatch(env.sent[0].text, /Employees/);
  } finally { env.restore(); }
});

test("one connection can send 5 an hour; email trouble points to info@tymrak.com", async () => {
  let env = install();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await call({ body: good })).statusCode, 200);
    const sixth = await call({ body: good });
    assert.equal(sixth.statusCode, 429);
    assert.match(sixth.payload.error, /info@tymrak\.com/);
    assert.equal((await call({ body: good, ip: "198.51.100.9" })).statusCode, 200, "someone else isn't affected");
  } finally { env.restore(); }
  env = install({ status: 500 });
  try {
    const res = await call({ body: good });
    assert.equal(res.statusCode, 502);
    assert.match(res.payload.error, /email us at info@tymrak\.com/);
  } finally { env.restore(); }
});
