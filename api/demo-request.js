import { demoRequestEmail, sendEmail, REPLY_TO } from "./_email.js";

// The "Request a demo" form on tymrak.com posts here. It emails the request to the support
// mailbox (info@tymrak.com) with the visitor's address as Reply-To. Nothing is stored and
// nothing is sent to the visitor, so the form can't be used to email anyone else.
//
// Only tymrak.com may call it from a browser. Bots are filtered with a hidden field that
// people leave empty, a minimum time on the page, length limits and a small per-address
// limit (per server instance: a speed bump, not a guarantee).

export const ALLOWED_ORIGINS = new Set(["https://tymrak.com", "https://www.tymrak.com"]);
const TOPICS = { demo: "Demo request", partner: "Partnership inquiry", other: "Question" };
const SIZES = new Set(["1–10", "11–25", "26–50", "51–100", "100+"]);
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const LIMIT = 5, WINDOW_MS = 60 * 60 * 1000, MIN_FILL_MS = 3000;
const recent = new Map();

const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max + 1) : "";
const oneLine = (value, max) => clean(value, max).replace(/\s+/g, " ");

function cors(req, res) {
  const origin = req.headers?.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  return ALLOWED_ORIGINS.has(origin);
}

function tooMany(req, now) {
  const address = String(req.headers?.["x-real-ip"] || req.headers?.["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const times = (recent.get(address) || []).filter(t => now - t < WINDOW_MS);
  if (recent.size > 5000) recent.clear();
  if (times.length >= LIMIT) { recent.set(address, times); return true; }
  times.push(now); recent.set(address, times);
  return false;
}

export function resetDemoRequestLimits() { recent.clear(); }

export default async function handler(req, res, now = Date.now()) {
  res.setHeader("Cache-Control", "no-store");
  const allowed = cors(req, res);
  if (req.method === "OPTIONS") return res.status(allowed ? 204 : 403).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ error: "Method not allowed" }); }
  if (!allowed) return res.status(403).json({ error: "Not allowed" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  // Bots: the hidden "website" field is filled, or the form was sent too fast. Pretend it worked.
  if (clean(body.website, 200) || !(Number(body.elapsedMs) >= MIN_FILL_MS)) return res.status(200).json({ success: true });

  const request = {
    topic: TOPICS[body.topic] || TOPICS.demo,
    name: oneLine(body.name, 100), business: oneLine(body.business, 150), email: oneLine(body.email, 254).toLowerCase(),
    phone: oneLine(body.phone, 40), size: SIZES.has(body.size) ? body.size : "", message: clean(body.message, 2000),
    page: ALLOWED_ORIGINS.has(req.headers.origin) ? req.headers.origin.replace("https://", "") : ""
  };
  const problems = [];
  if (request.name.length < 2 || request.name.length > 100) problems.push("your name");
  if (request.business.length < 2 || request.business.length > 150) problems.push("your business name");
  if (!EMAIL.test(request.email) || request.email.length > 254) problems.push("a valid email address");
  if (request.phone && !/^[0-9+().\-\s]{7,40}$/.test(request.phone)) problems.push("a valid phone number (or leave it empty)");
  if (request.message.length > 2000) problems.push("a shorter message (2,000 characters at most)");
  if (problems.length) return res.status(400).json({ error: `Please enter ${problems.join(", ")}.` });

  if (tooMany(req, now)) return res.status(429).json({ error: `Too many requests from this connection. Please email us at ${REPLY_TO}.` });

  const sent = await sendEmail({ to: REPLY_TO, replyTo: request.email, ...demoRequestEmail(request) });
  if (!sent.sent) {
    console.error("Demo request email failed", { reason: sent.reason });
    return res.status(502).json({ error: `Your request couldn't be sent right now. Please email us at ${REPLY_TO}.` });
  }
  return res.status(200).json({ success: true });
}
