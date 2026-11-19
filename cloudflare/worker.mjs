import { createWorker } from './adapter.mjs';
import publicConfig from '../api/public-config.js';
import accountDeletion from '../api/account-deletion.js';
import completeActivation from '../api/complete-activation.js';
import companyTeam from '../api/company-team.js';
import quickbooks from '../api/quickbooks.js';
import employeePunch from '../api/employee-punch.js';
import employees from '../api/employees.js';
import employeeTimeOff from '../api/employee-time-off.js';
import managerTimeOff from '../api/manager-time-off.js';
import managerSession from '../api/manager-session.js';
import managerWorkplaces from '../api/manager-workplaces.js';
import managerTimecards from '../api/manager-timecards.js';
import managerApprovals from '../api/manager-timecard-approvals.js';
import managerReopen from '../api/manager-timecard-reopen.js';
import sendInvitation from '../api/send-invitation.js';
import resendInvitation from '../api/resend-invitation.js';
import workplaceMapConfig from '../api/workplace-map-config.js';

export const routes = {
  '/api/public-config': publicConfig,
  '/api/account-deletion': accountDeletion,
  '/api/complete-activation': completeActivation,
  '/api/company-team': companyTeam,
  '/api/quickbooks': quickbooks,
  '/api/employee-punch': employeePunch,
  '/api/employees': employees,
  '/api/employee-time-off': employeeTimeOff,
  '/api/manager-time-off': managerTimeOff,
  '/api/manager-session': managerSession,
  '/api/manager-workplaces': managerWorkplaces,
  '/api/manager-timecards': managerTimecards,
  '/api/manager-timecard-approvals': managerApprovals,
  '/api/manager-timecard-reopen': managerReopen,
  '/api/send-invitation': sendInvitation,
  '/api/resend-invitation': resendInvitation,
  '/api/workplace-map-config': workplaceMapConfig
};
export default createWorker(routes);
