import { createWorker } from './adapter.mjs';
import publicConfig from '../api/public-config.js';
import completeActivation from '../api/complete-activation.js';
import employeePunch from '../api/employee-punch.js';
import employees from '../api/employees.js';
import managerSession from '../api/manager-session.js';
import managerWorkplaces from '../api/manager-workplaces.js';
import managerTimecards from '../api/manager-timecards.js';
import managerApprovals from '../api/manager-timecard-approvals.js';
import managerReopen from '../api/manager-timecard-reopen.js';
import sendInvitation from '../api/send-invitation.js';
import resendInvitation from '../api/resend-invitation.js';
import workplaceMapConfig from '../api/workplace-map-config.js';

export default createWorker({
  '/api/public-config': publicConfig,
  '/api/complete-activation': completeActivation,
  '/api/employee-punch': employeePunch,
  '/api/employees': employees,
  '/api/manager-session': managerSession,
  '/api/manager-workplaces': managerWorkplaces,
  '/api/manager-timecards': managerTimecards,
  '/api/manager-timecard-approvals': managerApprovals,
  '/api/manager-timecard-reopen': managerReopen,
  '/api/send-invitation': sendInvitation,
  '/api/resend-invitation': resendInvitation,
  '/api/workplace-map-config': workplaceMapConfig
});
