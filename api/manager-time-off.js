import { requireManager } from './_manager-auth.js';
import { activationServerHeaders } from './complete-activation.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const MESSAGES = {
  manager_required: 'Manager access required.',
  request_not_found: 'That request could not be found.',
  not_pending: 'This request has already been decided. Refresh and try again.',
  not_cancellable: 'This request can no longer be cancelled.',
  insufficient_balance: 'The employee does not have enough vacation days left to approve this request.',
  employee_not_found: 'That employee could not be found in your workplaces.',
  below_ontario_minimum: 'Annual vacation cannot be below the Ontario minimum for this employee.',
  invalid_request: 'This request is not valid.'
};

async function rpc(configuration, name, args) {
  const response = await fetch(`${configuration.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: activationServerHeaders(configuration.secretKey), body: JSON.stringify(args)
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    console.error('Manager time off RPC failed', { name, status: response.status, code: details.code });
    throw new Error('Time off service unavailable');
  }
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const authorization = await requireManager(req);
    if (!authorization.ok) return res.status(authorization.status).json({ error: authorization.error });
    const { configuration, organizationId } = authorization;
    const managerId = authorization.user.id;

    let result;
    if (req.method === 'GET') {
      result = await rpc(configuration, 'manager_time_off', { p_manager_id: managerId, p_organization_id: organizationId });
      if (!result?.error && !(Array.isArray(result?.requests) && Array.isArray(result?.balances))) throw new Error('Invalid time off response');
    } else {
      const body = req.body || {};
      const action = body.action;
      if (action === 'approve' || action === 'decline') {
        const note = body.note ?? null;
        if (!uuid(body.requestId) || !(note === null || (typeof note === 'string' && note.length <= 500))) return res.status(400).json({ error: 'Invalid time off request' });
        result = await rpc(configuration, 'decide_time_off', {
          p_manager_id: managerId, p_organization_id: organizationId, p_request_id: body.requestId,
          p_decision: action === 'approve' ? 'approved' : 'declined', p_note: note
        });
      } else if (action === 'cancel') {
        if (!uuid(body.requestId)) return res.status(400).json({ error: 'Invalid time off request' });
        result = await rpc(configuration, 'manager_cancel_time_off', { p_manager_id: managerId, p_organization_id: organizationId, p_request_id: body.requestId });
      } else if (action === 'set_entitlement') {
        const days = body.annualDays;
        if (!uuid(body.employeeId) || typeof days !== 'number' || !Number.isFinite(days) || days < 0 || days > 100 || (days * 2) !== Math.trunc(days * 2)) {
          return res.status(400).json({ error: 'Annual days must be a number in steps of half a day.' });
        }
        result = await rpc(configuration, 'set_time_off_entitlement', {
          p_manager_id: managerId, p_organization_id: organizationId, p_employee_id: body.employeeId, p_days: days
        });
      } else return res.status(400).json({ error: 'Unknown time off action' });
    }

    if (result?.error) {
      const status = result.error === 'manager_required' ? 403 : result.error === 'request_not_found' || result.error === 'employee_not_found' ? 404 : 409;
      return res.status(status).json({ error: MESSAGES[result.error] || 'This request could not be completed.', code: result.error, ...(result.minimum !== undefined ? { minimum: result.minimum } : {}) });
    }
    if (req.method === 'POST' && result?.success !== true) throw new Error('Invalid time off response');
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: 'Time off is temporarily unavailable. Please try again.' });
  }
}
