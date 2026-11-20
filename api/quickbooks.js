import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";
import { loadPaySchedule, requestedPayPeriod } from "./_pay-schedule.js";
import { PROVINCE_TIME_ZONES, calculationStart, periodInstants, summarizeEmployee } from "./_manager-timecards.js";
import { nextPayPeriod, previousPayPeriod } from "../pay-periods.js";
import {
  QuickBooksError, authorizationUrl, exchangeCode, quickBooksClient, quickBooksConfig, revokeToken,
  decryptSecret, signState, tokenRecord, verifyState
} from "./_quickbooks.js";
import { missingEntries, suggestMatches, timeActivity, timecardEntries } from "./_quickbooks-sync.js";

// QuickBooks for one company (admins only): connect, match employees, send approved
// timecards. GET returns the page data; POST takes { action, ... }.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QB_ID = /^[0-9]{1,32}$/;
const STALE_SENDING_MS = 10 * 60 * 1000;

function database(auth) {
  const { supabaseUrl, secretKey } = auth.configuration;
  async function call(path, { method = "GET", body, prefer } = {}) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { ...databaseHeaders(secretKey, prefer), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const error = new Error(`QuickBooks data request failed (${path.split("?")[0]})`);
      error.httpStatus = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  return call;
}

const idList = ids => encodeURIComponent(`(${ids.map(id => `"${String(id).replaceAll('"', "")}"`).join(",")})`);

async function loadConnection(db, organizationId) {
  const rows = await db(`accounting_connections?organization_id=eq.${organizationId}&select=*`);
  return rows?.[0] || null;
}

function clientFor(config, db, connection) {
  return quickBooksClient(config, connection, record =>
    db(`accounting_connections?organization_id=eq.${connection.organization_id}`, { method: "PATCH", body: record, prefer: "return=minimal" }));
}

// Approved timecards in a period, with their hours worked out exactly like the manager's
// timecard list (same punches, same overtime rule, same calculation).
async function approvedTimecards(db, auth, period) {
  const org = auth.organizationId;
  const employees = await db(`employees?organization_id=eq.${org}&select=id,first_name,last_name,province,email`);
  if (!employees.length) return [];
  const approvals = await db(`timecard_approvals?employee_id=in.${idList(employees.map(e => e.id))}&period_start=eq.${period.startKey}&period_end=eq.${period.endKey}&status=eq.approved&select=id,employee_id`);
  if (!approvals.length) return [];
  const people = employees.filter(employee => approvals.some(a => a.employee_id === employee.id));
  const rules = await db("overtime_rules?is_active=eq.true&is_default=eq.true&is_special_rule=eq.false&select=province_code,daily_threshold_hours,weekly_threshold_hours,daily_overtime_enabled,weekly_overtime_enabled,calculation_method,week_start_day,overtime_multiplier,double_time_threshold_hours,double_time_multiplier,holiday_rule,holiday_week_threshold_hours,holiday_reduction_hours,effective_from,effective_to");
  const zone = person => PROVINCE_TIME_ZONES[person.province] || "America/Toronto";
  const earliest = Math.min(...people.map(person => calculationStart(period, 0, zone(person)).getTime()));
  const latest = Math.max(...people.map(person => periodInstants(period, zone(person)).end.getTime())) + 86400000;
  const punches = await db(`punches?employee_id=in.${idList(people.map(p => p.id))}&punched_at=gte.${encodeURIComponent(new Date(earliest).toISOString())}&punched_at=lte.${encodeURIComponent(new Date(latest).toISOString())}&select=id,employee_id,punch_type,punched_at,location_name&order=punched_at.asc,id.asc`);
  return people.map(person => {
    const own = punches.filter(punch => punch.employee_id === person.id);
    const applicable = rules.filter(rule => rule.province_code === person.province && rule.effective_from <= period.endKey && (!rule.effective_to || rule.effective_to >= period.startKey));
    const summary = summarizeEmployee(person, own, own.length ? applicable[0] || null : null, period);
    return { employee: person, approvalId: approvals.find(a => a.employee_id === person.id).id, days: summary.days, ruleMissing: own.length > 0 && applicable.length !== 1 };
  });
}

async function pageData(db, auth, config, periodKey) {
  const org = auth.organizationId;
  const connection = config ? await loadConnection(db, org) : null;
  const employees = await db(`employees?organization_id=eq.${org}&is_active=eq.true&select=id,first_name,last_name,email&order=last_name.asc,first_name.asc`);
  const links = await db(`employee_accounting_links?organization_id=eq.${org}&select=employee_id,external_id,external_name,matched_by`);
  let quickBooksEmployees = [], connectionProblem = null;
  if (connection) {
    try { quickBooksEmployees = await clientFor(config, db, connection).employees(); }
    catch (error) { if (!(error instanceof QuickBooksError)) throw error; connectionProblem = error.message; }
  }
  const schedule = await loadPaySchedule(auth);
  const period = requestedPayPeriod(periodKey || null, schedule);
  if (!period) { const error = new Error("Select a valid current or previous pay period"); error.status = 400; throw error; }
  const previous = previousPayPeriod(period, schedule);
  const current = requestedPayPeriod(null, schedule);
  // Everyone in the company, including people who left during the period: their last
  // approved timecard still needs to reach QuickBooks.
  const everyone = await db(`employees?organization_id=eq.${org}&select=id,first_name,last_name`);
  const approvals = everyone.length ? await db(`timecard_approvals?employee_id=in.${idList(everyone.map(e => e.id))}&period_start=eq.${period.startKey}&period_end=eq.${period.endKey}&status=eq.approved&select=id,employee_id`) : [];
  const syncs = approvals.length ? await db(`accounting_timecard_syncs?approval_id=in.${idList(approvals.map(a => a.id))}&select=approval_id,status,entries,manual_hours,error,synced_at`) : [];
  const nameOf = id => { const e = everyone.find(x => x.id === id); return e ? `${e.first_name} ${e.last_name}`.trim() : "Former employee"; };
  return {
    configured: Boolean(config),
    environment: config?.environment || null,
    connection: connection ? { companyName: connection.company_name, environment: connection.environment, connectedAt: connection.connected_at,
      runsPayroll: connection.runs_payroll ?? null, problem: connectionProblem } : null,
    employees: employees.map(e => {
      const link = links.find(l => l.employee_id === e.id);
      return { id: e.id, name: `${e.first_name} ${e.last_name}`.trim(), email: e.email || "", link: link ? { externalId: link.external_id, externalName: link.external_name, matchedBy: link.matched_by } : null };
    }),
    quickBooksEmployees: quickBooksEmployees.map(({ id, name, email }) => ({ id, name, email })),
    suggestions: connection && !connectionProblem ? suggestMatches(employees, quickBooksEmployees, links) : [],
    period: { key: period.key, startDate: period.startKey, endDate: period.endKey, previousKey: previous.key,
      nextKey: period.key === current.key ? null : nextPayPeriod(period, schedule).key },
    timecards: approvals.map(a => {
      const sync = syncs.find(s => s.approval_id === a.id);
      return { approvalId: a.id, employeeId: a.employee_id, employeeName: nameOf(a.employee_id),
        matched: links.some(l => l.employee_id === a.employee_id),
        status: sync?.status || "not_sent", entriesSent: sync?.entries?.length || 0,
        manualHours: sync?.manual_hours || [], error: sync?.error || null, syncedAt: sync?.synced_at || null };
    })
  };
}

// Takes the timecard for sending. Returns the claimed row, or null with a reason.
async function claim(db, auth, approvalId, employeeId, realmId, now) {
  const fresh = { approval_id: approvalId, organization_id: auth.organizationId, employee_id: employeeId, realm_id: realmId,
    status: "sending", entries: [], manual_hours: [], error: null, attempted_by: auth.user.id, attempted_at: now.toISOString() };
  const inserted = await db("accounting_timecard_syncs?on_conflict=approval_id", { method: "POST", body: fresh, prefer: "resolution=ignore-duplicates,return=representation" });
  if (inserted?.length) return { row: inserted[0] };
  const [existing] = await db(`accounting_timecard_syncs?approval_id=eq.${approvalId}&select=*`);
  if (!existing) return { reason: "Could not start sending. Try again." };
  if (existing.status === "synced") return { reason: "already_sent" };
  if (existing.realm_id && existing.realm_id !== realmId && existing.entries.length) {
    return { reason: "Part of this timecard was sent to a different QuickBooks company. Contact Tymrak support." };
  }
  const stale = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  const filter = existing.status === "failed" ? "status=eq.failed" : `status=eq.sending&attempted_at=lt.${encodeURIComponent(stale)}`;
  const updated = await db(`accounting_timecard_syncs?approval_id=eq.${approvalId}&${filter}`, { method: "PATCH",
    body: { status: "sending", realm_id: realmId, error: null, attempted_by: auth.user.id, attempted_at: now.toISOString() }, prefer: "return=representation" });
  return updated?.length ? { row: updated[0] } : { reason: "Someone else is sending this timecard right now." };
}

async function sendPeriod(db, auth, config, periodKey) {
  const connection = await loadConnection(db, auth.organizationId);
  if (!connection) return { status: 400, body: { error: "Connect QuickBooks first." } };
  if (connection.runs_payroll !== true) {
    return { status: 409, body: { error: "Hours are only sent to businesses that run payroll in QuickBooks Online. Answer the payroll question first." } };
  }
  const period = requestedPayPeriod(periodKey, await loadPaySchedule(auth));
  if (!period) return { status: 400, body: { error: "Select a valid current or previous pay period" } };
  const client = clientFor(config, db, connection);
  const timecards = await approvedTimecards(db, auth, period);
  const links = await db(`employee_accounting_links?organization_id=eq.${auth.organizationId}&select=employee_id,external_id`);
  const results = [];
  for (const card of timecards) {
    const name = `${card.employee.first_name} ${card.employee.last_name}`.trim();
    const link = links.find(l => l.employee_id === card.employee.id);
    const claimed = await claim(db, auth, card.approvalId, card.employee.id, connection.realm_id, new Date());
    if (!claimed.row) { results.push({ employeeName: name, status: claimed.reason === "already_sent" ? "synced" : "skipped", message: claimed.reason === "already_sent" ? "Already sent." : claimed.reason }); continue; }
    const finish = (patch) => db(`accounting_timecard_syncs?approval_id=eq.${card.approvalId}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    if (!link) {
      await finish({ status: "failed", error: "Not matched to a QuickBooks employee." });
      results.push({ employeeName: name, status: "failed", message: "Not matched to a QuickBooks employee." }); continue;
    }
    if (card.ruleMissing) {
      await finish({ status: "failed", error: "No overtime rule applies to this employee's province for this period." });
      results.push({ employeeName: name, status: "failed", message: "No overtime rule for this period." }); continue;
    }
    const { entries, manual } = timecardEntries(card.days);
    let sent = [...claimed.row.entries], problem = null;
    const todo = missingEntries(entries, sent);
    try {
      for (let start = 0; start < todo.length && !problem; start += 30) {
        const chunk = todo.slice(start, start + 30);
        const created = await client.createTimeActivities(chunk.map(entry => timeActivity(entry, link.external_id, period)));
        created.forEach((result, index) => {
          if (result.externalId) sent.push({ ...chunk[index], externalId: result.externalId });
          else problem = problem || result.error;
        });
        await finish({ entries: sent });
      }
    } catch (error) {
      problem = error instanceof QuickBooksError ? error.message : "QuickBooks could not be reached.";
    }
    if (problem) {
      await finish({ status: "failed", entries: sent, error: String(problem).slice(0, 500) });
      results.push({ employeeName: name, status: "failed", message: problem, entriesSent: sent.length }); continue;
    }
    await finish({ status: "synced", entries: sent, manual_hours: manual, synced_at: new Date().toISOString(), error: null });
    results.push({ employeeName: name, status: "synced", entriesSent: sent.length, manualHours: manual });
  }
  return { status: 200, body: { period: { key: period.key, startDate: period.startKey, endDate: period.endKey }, results } };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const auth = await requireManager(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (auth.role !== "admin") return res.status(403).json({ error: "Only this business's admins can manage QuickBooks." });
    const config = quickBooksConfig();
    const db = database(auth);

    if (req.method === "GET") {
      const periodKey = Array.isArray(req.query?.period) ? req.query.period[0] : req.query?.period;
      return res.status(200).json(await pageData(db, auth, config, periodKey));
    }

    const action = req.body?.action;
    if (!config) return res.status(503).json({ error: "QuickBooks isn't set up for Tymrak yet." });

    if (action === "connect") {
      return res.status(200).json({ url: authorizationUrl(config, signState({ organizationId: auth.organizationId, userId: auth.user.id }, config.key)) });
    }

    if (action === "complete") {
      const { code, state, realmId } = req.body || {};
      if (typeof code !== "string" || !code || code.length > 2000 || !QB_ID.test(realmId || "")) return res.status(400).json({ error: "QuickBooks didn't return a valid sign-in. Try connecting again." });
      if (!verifyState(state, config.key, { organizationId: auth.organizationId, userId: auth.user.id })) {
        return res.status(400).json({ error: "This QuickBooks sign-in expired or was started by someone else. Try connecting again." });
      }
      const tokens = await exchangeCode(config, code);
      const record = { organization_id: auth.organizationId, provider: "quickbooks", realm_id: realmId, environment: config.environment,
        ...tokenRecord(config, tokens), connected_by: auth.user.id, connected_at: new Date().toISOString() };
      const client = quickBooksClient(config, { ...record }, async () => {});
      record.company_name = (await client.companyName().catch(() => null))?.slice(0, 200) || null;
      const previous = await loadConnection(db, auth.organizationId);
      if (previous && previous.realm_id !== realmId) {
        // A different QuickBooks company: old employee matches no longer apply.
        await db(`employee_accounting_links?organization_id=eq.${auth.organizationId}`, { method: "DELETE", prefer: "return=minimal" });
        record.runs_payroll = null; // a different QuickBooks company: ask again
      }
      await db("accounting_connections?on_conflict=organization_id", { method: "POST", body: record, prefer: "resolution=merge-duplicates,return=minimal" });
      return res.status(200).json({ success: true, companyName: record.company_name });
    }

    if (action === "disconnect") {
      const connection = await loadConnection(db, auth.organizationId);
      if (connection) {
        try { await revokeToken(config, decryptSecret(connection.refresh_token_encrypted, config.key)); } catch {}
        await db(`accounting_connections?organization_id=eq.${auth.organizationId}`, { method: "DELETE", prefer: "return=minimal" });
      }
      return res.status(200).json({ success: true });
    }

    if (action === "set_payroll") {
      const runsPayroll = req.body?.runsPayroll;
      if (typeof runsPayroll !== "boolean") return res.status(400).json({ error: "Answer yes or no." });
      const connection = await loadConnection(db, auth.organizationId);
      if (!connection) return res.status(400).json({ error: "Connect QuickBooks first." });
      await db(`accounting_connections?organization_id=eq.${auth.organizationId}`, { method: "PATCH",
        body: { runs_payroll: runsPayroll, updated_at: new Date().toISOString() }, prefer: "return=minimal" });
      return res.status(200).json({ success: true, runsPayroll });
    }

    if (action === "match" || action === "auto_match") {
      const connection = await loadConnection(db, auth.organizationId);
      if (!connection) return res.status(400).json({ error: "Connect QuickBooks first." });
      const people = await clientFor(config, db, connection).employees();
      const employees = await db(`employees?organization_id=eq.${auth.organizationId}&is_active=eq.true&select=id,first_name,last_name,email`);
      const links = await db(`employee_accounting_links?organization_id=eq.${auth.organizationId}&select=employee_id,external_id`);
      const save = (employeeId, person, matchedBy) => db("employee_accounting_links?on_conflict=employee_id", { method: "POST",
        body: { employee_id: employeeId, organization_id: auth.organizationId, provider: "quickbooks", external_id: person.id,
          external_name: (person.name || "").slice(0, 200), matched_by: matchedBy, updated_by: auth.user.id, updated_at: new Date().toISOString() },
        prefer: "resolution=merge-duplicates,return=minimal" });
      if (action === "auto_match") {
        const suggestions = suggestMatches(employees, people, links);
        for (const s of suggestions) await save(s.employeeId, { id: s.externalId, name: s.externalName }, s.matchedBy);
        return res.status(200).json({ success: true, matched: suggestions.length });
      }
      const { employeeId, externalId } = req.body || {};
      if (!UUID.test(employeeId || "") || !employees.some(e => e.id === employeeId)) return res.status(404).json({ error: "Employee not found." });
      if (externalId === null || externalId === "") {
        await db(`employee_accounting_links?employee_id=eq.${employeeId}&organization_id=eq.${auth.organizationId}`, { method: "DELETE", prefer: "return=minimal" });
        return res.status(200).json({ success: true });
      }
      const person = people.find(p => p.id === String(externalId));
      if (!person) return res.status(400).json({ error: "That QuickBooks employee wasn't found. Refresh and try again." });
      const takenBy = links.find(l => l.external_id === person.id && l.employee_id !== employeeId);
      if (takenBy) return res.status(409).json({ error: `${person.name} is already matched to another Tymrak employee.` });
      await save(employeeId, person, "manual");
      return res.status(200).json({ success: true });
    }

    if (action === "sync") {
      if (typeof req.body?.period !== "string" || !req.body.period) return res.status(400).json({ error: "Select a valid current or previous pay period" });
      const result = await sendPeriod(db, auth, config, req.body.period);
      return res.status(result.status).json(result.body);
    }

    return res.status(400).json({ error: "Unknown QuickBooks action." });
  } catch (error) {
    if (error instanceof QuickBooksError) return res.status(error.reconnect ? 409 : 502).json({ error: error.message, reconnect: error.reconnect });
    if (error?.status === 400) return res.status(400).json({ error: error.message });
    console.error("QuickBooks operation failed", { errorName: error?.name || "Error", status: error?.httpStatus || null });
    return res.status(500).json({ error: "QuickBooks is unavailable right now. Please try again." });
  }
}
