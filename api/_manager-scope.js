// IDs come only from the service RPC after verified Auth and live membership.
export function employeeScopeFilter(auth) {
  if (auth.role === 'admin') return '';
  if (!Array.isArray(auth.employeeIds)) throw new Error('Workplace scope unavailable');
  return auth.employeeIds.length ? `&id=in.(${auth.employeeIds.join(',')})` : '&id=is.null';
}
export function canManageEmployee(auth, id) {
  return auth.role === 'admin' || Boolean(auth.employeeIds?.includes(id));
}
