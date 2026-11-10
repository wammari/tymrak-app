import {requireManager} from './_manager-auth.js';
import {activationServerHeaders} from './complete-activation.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateWorkplace(b) {
 if(!b || (b.id!==null&&!uuid(b.id)) || typeof b.name!=='string'||!b.name.trim()||b.name.length>120 ||
 typeof b.address!=='string'||b.address.length>300 || typeof b.isActive!=='boolean' ||
 !Number.isFinite(b.latitude)||Math.abs(b.latitude)>90||!Number.isFinite(b.longitude)||Math.abs(b.longitude)>180||
 !Number.isFinite(b.radiusMetres)||b.radiusMetres<25||b.radiusMetres>5000||
 !Array.isArray(b.employeeIds)||b.employeeIds.length>1000||!b.employeeIds.every(uuid)||new Set(b.employeeIds).size!==b.employeeIds.length) return null;
 return {id:b.id,name:b.name.trim(),address:b.address.trim(),latitude:b.latitude,longitude:b.longitude,radiusMetres:b.radiusMetres,isActive:b.isActive,employeeIds:b.employeeIds};
}
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed'});}
 try {
  const auth=await requireManager(req);if(!auth.ok)return res.status(auth.status).json({error:auth.error});
  const value=req.method==='POST'?validateWorkplace(req.body):null;
  if(req.method==='POST'&&!value)return res.status(400).json({error:'Enter a name, valid coordinates, a radius from 25 to 5000 metres, and valid employee assignments.'});
  const response=await fetch(`${auth.configuration.supabaseUrl}/rest/v1/rpc/manage_workplaces`,{method:'POST',headers:activationServerHeaders(auth.configuration.secretKey),body:JSON.stringify({p_manager_id:auth.user.id,p_workplace:value})});
  if(!response.ok)throw new Error('Workplace operation failed');
  const result=await response.json();
  if(result.error)return res.status(result.error==='manager_required'?403:409).json({error:'Unable to save workplace. Refresh and check employee assignments.',code:result.error});
  return res.status(200).json(result);
 } catch {return res.status(503).json({error:'Unable to load or save workplaces. Please try again.'});}
}
