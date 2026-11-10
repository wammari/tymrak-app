import { getBearerToken, getSupabaseConfiguration } from './_manager-auth.js';
import { activationServerHeaders } from './complete-activation.js';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (!['GET','POST'].includes(req.method)) {res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed'});}
  const token=getBearerToken(req);
  if (!token) return res.status(401).json({error:'Authentication required'});
  const config=getSupabaseConfiguration();
  if (!config) return res.status(503).json({error:'TYMRAK configuration unavailable'});
  const body=req.body;
  if(req.method==='POST' && (!uuid(body?.requestId) || !['clock_in','clock_out','break_start','break_end'].includes(body?.punchType) ||
    !(body?.expectedLastId===null || (typeof body?.expectedLastId==='string' && /^\d+$/.test(body.expectedLastId))))) {
    return res.status(400).json({error:'Invalid punch request'});
  }
  try {
    const userResponse=await fetch(`${config.supabaseUrl}/auth/v1/user`,{headers:{apikey:config.secretKey,Authorization:`Bearer ${token}`}});
    if(!userResponse.ok) {if(userResponse.status>=500) throw new Error('Auth unavailable');return res.status(401).json({error:'Session expired. Please sign in again.'});}
    const user=await userResponse.json();
    if(!uuid(user?.id)) return res.status(401).json({error:'Invalid session'});
    const response=await fetch(`${config.supabaseUrl}/rest/v1/rpc/record_geofenced_punch`,{
      method:'POST',headers:activationServerHeaders(config.secretKey),body:JSON.stringify({
        p_auth_user_id:user.id,...(req.method==='POST'?{p_punch_type:body.punchType,p_request_id:body.requestId,p_expected_last_id:body.expectedLastId,p_location:body.location??null}:{})
      })});
    if(!response.ok) {
      const details=await response.json().catch(()=>({}));
      if(details.code==='P0001') return res.status(409).json({error:'This timecard period is locked. Please contact your manager.',code:'locked'});
      console.error('Employee punch RPC failed',{status:response.status,code:details.code});
      throw new Error('Punch service unavailable');
    }
    const result=await response.json();
    if(result?.error) {
      const locationErrors={location_required:'Allow location access and try again.',invalid_location:'Unable to verify your location. Try again with location services enabled.',stale_location:'Your location is too old. Try again for a fresh reading.',inaccurate_location:'Location accuracy is too low. Move near a window or outside and try again.',outside_geofence:'You are outside your assigned workplace area. Move inside the area and try again.',workplace_unassigned:'No active workplace is assigned to you. Please contact your manager.'};
      if(locationErrors[result.error])return res.status(409).json({error:locationErrors[result.error],code:result.error});
      const unavailable=result.error==='employee_unavailable';
      return res.status(unavailable?403:409).json({error:unavailable?'This employee account is unavailable. Please contact your manager.':result.error==='future_punch'?'Your timecard contains a future-dated punch. Please contact your manager to correct it before clocking again.':'Your clock state changed or this punch is not allowed. Refresh and try again.',code:result.error});
    }
    if(req.method==='GET' ? !Array.isArray(result?.punches) : result?.success!==true) throw new Error('Invalid punch response');
    if(req.method==='GET') {
      // Keep the actual last ID for transition checks; never count future fixtures as worked time.
      const now=Date.now();
      result.punches=result.punches.filter(p=>Number.isFinite(Date.parse(p.punched_at)) && Date.parse(p.punched_at)<=now);
    }
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({error:'Unable to confirm your punch. Retry the same request before starting another punch.'});
  }
}
