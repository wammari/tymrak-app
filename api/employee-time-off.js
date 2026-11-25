import { getBearerToken, getSupabaseConfiguration } from './_manager-auth.js';
import { activationServerHeaders } from './complete-activation.js';
import { CHOOSE_BUSINESS_MESSAGE, chosenEmployeeId } from './_chosen-employee.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const MESSAGES = {
  employee_unavailable: 'This employee account is unavailable. Please contact your manager.',
  choose_business: CHOOSE_BUSINESS_MESSAGE,
  invalid_dates: 'Choose a valid start and end date.',
  past_dates: 'Time off cannot start in the past.',
  spans_two_years: 'A request cannot span two calendar years. Submit one request for each year.',
  invalid_request: 'This request is not valid.',
  no_working_days: 'The selected dates contain no working days (weekends and public holidays are not counted).',
  province_not_supported: 'Time off requests are not available yet for your province. Please ask your manager.',
  insufficient_balance: 'You do not have enough vacation days left for this request.',
  overlaps_existing: 'You already have a pending or approved request on these dates.',
  request_not_found: 'That request could not be found.',
  not_cancellable: 'This request can no longer be cancelled.',
  already_started: 'This time off has already started. Ask your manager to cancel it.'
};

async function rpc(config, name, args) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: activationServerHeaders(config.secretKey), body: JSON.stringify(args)
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    console.error('Employee time off RPC failed', { name, status: response.status, code: details.code });
    throw new Error('Time off service unavailable');
  }
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, DELETE'); return res.status(405).json({ error: 'Method not allowed' }); }
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const config = getSupabaseConfiguration();
  if (!config) return res.status(503).json({ error: 'TYMRAK configuration unavailable' });

  // Validate input before any database work.
  const employeeId = chosenEmployeeId(req);
  if (employeeId === null) return res.status(400).json({ error: 'Invalid business choice' });
  const chosen = employeeId ? { p_employee_id: employeeId } : {};
  let requestId = null;
  if (req.method === 'POST') {
    const body = req.body;
    const startHalf = body?.startHalf ?? 'full', endHalf = body?.endHalf ?? 'full';
    const note = body?.note ?? null;
    if (!dateKey(body?.startDate) || !dateKey(body?.endDate) || !['full', 'pm'].includes(startHalf) || !['full', 'am'].includes(endHalf)
      || !(note === null || (typeof note === 'string' && note.length <= 500))) {
      return res.status(400).json({ error: 'Invalid time off request' });
    }
  }
  if (req.method === 'DELETE') {
    requestId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
    if (!uuid(requestId)) return res.status(400).json({ error: 'Invalid time off request' });
  }

  try {
    const userResponse = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.secretKey, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) { if (userResponse.status >= 500) throw new Error('Auth unavailable'); return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
    const user = await userResponse.json();
    if (!uuid(user?.id)) return res.status(401).json({ error: 'Invalid session' });

    let result;
    if (req.method === 'GET') result = await rpc(config, 'employee_time_off', { p_auth_user_id: user.id, ...chosen });
    else if (req.method === 'POST') {
      result = await rpc(config, 'request_time_off', {
        p_auth_user_id: user.id, p_start: req.body.startDate, p_end: req.body.endDate,
        p_start_half: req.body.startHalf ?? 'full', p_end_half: req.body.endHalf ?? 'full', p_note: req.body.note ?? null, ...chosen
      });
    } else result = await rpc(config, 'cancel_time_off', { p_auth_user_id: user.id, p_request_id: requestId });

    if (result?.error) {
      const unavailable = result.error === 'employee_unavailable';
      return res.status(unavailable ? 403 : 409).json({ error: MESSAGES[result.error] || 'This request could not be completed.', code: result.error });
    }
    if (req.method === 'GET' ? !(result?.balance && Array.isArray(result?.requests)) : result?.success !== true) throw new Error('Invalid time off response');
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: 'Time off is temporarily unavailable. Please try again.' });
  }
}
