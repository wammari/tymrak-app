import crypto from "node:crypto";
import { getSiteUrl } from "./_deployment-config.js";

// QuickBooks Online connection: configuration, OAuth 2.0, encrypted token storage and
// the few API calls Tymrak makes (company name, employees, time entries).
//
// Server settings (Vercel environment variables), from the Intuit Developer app:
//   QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET
//   QUICKBOOKS_ENVIRONMENT   "sandbox" (test companies) or "production"
//   QUICKBOOKS_TOKEN_KEY     32 random bytes, base64: encrypts tokens and signs sign-in state
// The Intuit app's redirect URI must be exactly <SITE_URL>/quickbooks.html.

export const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE = { sandbox: "https://sandbox-quickbooks.api.intuit.com", production: "https://quickbooks.api.intuit.com" };
const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";
const STATE_LIFETIME_SECONDS = 600;

export class QuickBooksError extends Error {
  constructor(message, { status = 502, code = "quickbooks_error", reconnect = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.reconnect = reconnect;
  }
}

// Returns the settings, or null when QuickBooks has not been set up for this deployment.
export function quickBooksConfig(env = process.env) {
  const clientId = env.QUICKBOOKS_CLIENT_ID, clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
  const environment = env.QUICKBOOKS_ENVIRONMENT || "sandbox";
  if (!clientId || !clientSecret || !env.QUICKBOOKS_TOKEN_KEY) return null;
  if (!(environment in API_BASE)) throw new Error("QUICKBOOKS_ENVIRONMENT must be sandbox or production");
  const key = Buffer.from(env.QUICKBOOKS_TOKEN_KEY, "base64");
  if (key.length !== 32) throw new Error("QUICKBOOKS_TOKEN_KEY must be 32 bytes, base64 encoded");
  return { clientId, clientSecret, environment, key, apiBase: API_BASE[environment], redirectUri: `${getSiteUrl(env)}/quickbooks.html` };
}

// ---- Token encryption (AES-256-GCM) -----------------------------------------------------
const b64url = buffer => Buffer.from(buffer).toString("base64url");

export function encryptSecret(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(data)}`;
}

export function decryptSecret(value, key) {
  const [version, iv, tag, data] = String(value || "").split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new QuickBooksError("Stored QuickBooks connection is unreadable. Reconnect QuickBooks.", { reconnect: true });
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new QuickBooksError("Stored QuickBooks connection is unreadable. Reconnect QuickBooks.", { reconnect: true });
  }
}

// ---- Sign-in state: who started connecting, for which company, valid for 10 minutes ----
function stateKey(key) {
  return crypto.createHmac("sha256", key).update("tymrak-quickbooks-oauth-state").digest();
}

export function signState({ organizationId, userId }, key, now = Date.now()) {
  const payload = b64url(JSON.stringify({ o: organizationId, u: userId, e: Math.floor(now / 1000) + STATE_LIFETIME_SECONDS, n: b64url(crypto.randomBytes(12)) }));
  return `${payload}.${b64url(crypto.createHmac("sha256", stateKey(key)).update(payload).digest())}`;
}

export function verifyState(state, key, { organizationId, userId }, now = Date.now()) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", stateKey(key)).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return false; }
  return data.o === organizationId && data.u === userId && Number.isInteger(data.e) && data.e >= Math.floor(now / 1000);
}

export function authorizationUrl(config, state) {
  const url = new URL(INTUIT_AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", scope: SCOPE, redirect_uri: config.redirectUri, state }).toString();
  return url.toString();
}

// ---- OAuth tokens ----------------------------------------------------------------------
async function tokenRequest(config, form) {
  const response = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(form).toString()
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token || !body?.refresh_token) {
    const invalid = body?.error === "invalid_grant";
    throw new QuickBooksError(invalid ? "QuickBooks needs to be reconnected." : "QuickBooks sign-in could not be completed.",
      { code: invalid ? "reconnect_required" : "token_request_failed", reconnect: invalid });
  }
  return body;
}

export function tokenRecord(config, tokens, now = Date.now()) {
  return {
    access_token_encrypted: encryptSecret(tokens.access_token, config.key),
    refresh_token_encrypted: encryptSecret(tokens.refresh_token, config.key),
    access_expires_at: new Date(now + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
    refresh_expires_at: tokens.x_refresh_token_expires_in ? new Date(now + Number(tokens.x_refresh_token_expires_in) * 1000).toISOString() : null,
    updated_at: new Date(now).toISOString()
  };
}

export function exchangeCode(config, code) {
  return tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
}

export function refreshTokens(config, refreshToken) {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function revokeToken(config, token) {
  await fetch(INTUIT_REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      Accept: "application/json", "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  }).catch(() => null);
}

// ---- API client ------------------------------------------------------------------------
// A client for one stored connection. It refreshes the access token when it is about to
// expire and hands the new (encrypted) tokens to `saveTokens` before using them.
export function quickBooksClient(config, connection, saveTokens) {
  let accessToken = null;
  let expiresAt = Date.parse(connection.access_expires_at);
  async function token() {
    if (accessToken && expiresAt - Date.now() > 60000) return accessToken;
    if (!accessToken && expiresAt - Date.now() > 60000) {
      accessToken = decryptSecret(connection.access_token_encrypted, config.key);
      return accessToken;
    }
    const tokens = await refreshTokens(config, decryptSecret(connection.refresh_token_encrypted, config.key));
    const record = tokenRecord(config, tokens);
    await saveTokens(record);
    Object.assign(connection, record);
    accessToken = tokens.access_token;
    expiresAt = Date.parse(record.access_expires_at);
    return accessToken;
  }
  async function request(path, { method = "GET", body } = {}) {
    const url = new URL(`${config.apiBase}/v3/company/${encodeURIComponent(connection.realm_id)}/${path}`);
    url.searchParams.set("minorversion", MINOR_VERSION);
    const send = async () => fetch(url, {
      method, headers: { Authorization: `Bearer ${await token()}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let response = await send();
    if (response.status === 401) { expiresAt = 0; response = await send(); }
    const data = await response.json().catch(() => null);
    if (response.status === 401) throw new QuickBooksError("QuickBooks needs to be reconnected.", { code: "reconnect_required", reconnect: true });
    if (!response.ok) {
      const detail = data?.Fault?.Error?.[0];
      throw new QuickBooksError(detail?.Message ? `QuickBooks: ${detail.Message}` : `QuickBooks request failed (${response.status}).`);
    }
    return data;
  }
  return {
    request,
    async companyName() {
      const data = await request(`companyinfo/${encodeURIComponent(connection.realm_id)}`);
      return data?.CompanyInfo?.CompanyName || null;
    },
    async employees() {
      const data = await request(`query?query=${encodeURIComponent("select * from Employee where Active = true maxresults 1000")}`);
      return (data?.QueryResponse?.Employee || []).map(employee => ({
        id: String(employee.Id),
        name: employee.DisplayName || [employee.GivenName, employee.FamilyName].filter(Boolean).join(" "),
        givenName: employee.GivenName || "", familyName: employee.FamilyName || "",
        email: employee.PrimaryEmailAddr?.Address || ""
      }));
    },
    // Creates up to 30 time entries in one call. Returns one result per entry, in order:
    // { externalId } or { error }.
    async createTimeActivities(activities) {
      const data = await request("batch", { method: "POST", body: {
        BatchItemRequest: activities.map((activity, index) => ({ bId: String(index), operation: "create", TimeActivity: activity }))
      } });
      const byId = new Map((data?.BatchItemResponse || []).map(item => [String(item.bId), item]));
      return activities.map((_, index) => {
        const item = byId.get(String(index));
        if (item?.TimeActivity?.Id) return { externalId: String(item.TimeActivity.Id) };
        return { error: item?.Fault?.Error?.[0]?.Message || "QuickBooks did not create this time entry." };
      });
    }
  };
}
