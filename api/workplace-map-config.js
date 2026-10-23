import {requireManager} from './_manager-auth.js';
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'Method not allowed'});}
 try {
  const auth=await requireManager(req);if(!auth.ok)return res.status(auth.status).json({error:auth.error});
  // This is a browser key: restrict it to Maps/Places and the exact deployed website referrers.
  const apiKey=process.env.GOOGLE_MAPS_BROWSER_KEY||'',mapId=process.env.GOOGLE_MAPS_MAP_ID||'';
  if(!/^AIza[A-Za-z0-9_-]{20,100}$/.test(apiKey)||!/^[A-Za-z0-9_-]{5,100}$/.test(mapId))return res.status(200).json({configured:false});
  return res.status(200).json({configured:true,apiKey,mapId});
 } catch {return res.status(503).json({error:'Map search is temporarily unavailable.'});}
}
