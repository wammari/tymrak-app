import { requireManager } from "./_manager-auth.js";
import { databaseHeaders } from "./_employee-management.js";

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export default async function handler(req,res) {
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 try {
  const auth=await requireManager(req);
  if(!auth.ok)return res.status(auth.status).json({error:auth.error});
  const {supabaseUrl,secretKey}=auth.configuration;
  const headers={...databaseHeaders(secretKey),"Content-Type":"application/json"};
  const check=await fetch(supabaseUrl+"/rest/v1/rpc/is_platform_administrator",{method:"POST",headers,body:JSON.stringify({p_auth_user_id:auth.user.id})});
  if(!check.ok)return res.status(503).json({error:"Administrator verification unavailable"});
  if(await check.json()!==true)return res.status(403).json({error:"Main administrator access required"});
  const {organizationId,email,grant}=req.body||{};
  if(!uuid(organizationId)||typeof email!=="string"||email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof grant!=="boolean")
   return res.status(400).json({error:"Valid company, member email and grant choice required"});
  const response=await fetch(supabaseUrl+"/rest/v1/rpc/set_company_administrator",{
   method:"POST",headers,body:JSON.stringify({p_platform_admin:auth.user.id,p_organization_id:organizationId,p_member_email:email.trim(),p_grant:grant})
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok)return res.status(response.status===400?400:response.status===403?403:409).json({error:result?.message||"Unable to update administrator"});
  return res.status(200).json(result);
 }catch(error){console.error("Company administrator delegation failed",{name:error?.name});return res.status(500).json({error:"Administrator update unavailable"});}
}
