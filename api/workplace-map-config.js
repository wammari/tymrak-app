import {requireManager} from './_manager-auth.js';
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
 try {
  const auth=await requireManager(req);if(!auth.ok)return res.status(auth.status).json({error:auth.error});
  // No key, billing account, geocoding or paid fallback. Browser caching is left intact.
  return res.status(200).json({configured:true,provider:'openstreetmap',tileUrl:'https://tile.openstreetmap.org/{z}/{x}/{y}.png'});
 } catch {return res.status(503).json({error:'The map is temporarily unavailable.'});}
}
