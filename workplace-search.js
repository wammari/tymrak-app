import {validPosition} from './workplace-map.js';

// Explicit manager searches only: no autocomplete, background requests or paid fallback.
export function createAddressSearch({fetcher=fetch,now=Date.now}={}) {
 const cache=new Map();let lastRequest=-Infinity;
 return async function search(address) {
  const query=String(address||'').trim();
  if(query.length<5||query.length>300)throw new Error('Enter a full address, including the city and country.');
  const cacheKey=query.toLowerCase();if(cache.has(cacheKey))return cache.get(cacheKey);
  if(now()-lastRequest<2000)throw new Error('Please wait a moment before searching again.');
  lastRequest=now();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try {
   const url=new URL('https://photon.komoot.io/api/');url.searchParams.set('q',query);url.searchParams.set('limit','5');url.searchParams.set('lang','en');
   const response=await fetcher(url.href,{signal:controller.signal,credentials:'omit',referrerPolicy:'strict-origin-when-cross-origin'});
   if(!response.ok)throw new Error('Address search is unavailable. Try again later or choose the location on the map.');
   const data=await response.json();if(!Array.isArray(data.features))throw new Error('Invalid address search response.');
   const results=data.features.slice(0,5).flatMap(feature=>{
    const coords=feature.geometry?.coordinates,p=feature.properties||{};
    if(feature.geometry?.type!=='Point'||!Array.isArray(coords)||!validPosition(coords[1],coords[0]))return [];
    const label=[p.name,[p.housenumber,p.street].filter(Boolean).join(' '),p.city||p.town||p.village,p.state,p.postcode,p.country].filter(v=>typeof v==='string'&&v.trim()).join(', ').slice(0,600);
    const hasHouseNumber=typeof p.housenumber==='string'&&p.housenumber.trim()!=='';
    return label?[{latitude:coords[1],longitude:coords[0],label,precision:hasHouseNumber?'address':'area'}]:[];
   });
   if(cache.size>=20)cache.delete(cache.keys().next().value);cache.set(cacheKey,results);return results;
  }catch(error){if(error.name==='AbortError')throw new Error('Address search timed out. Try again or choose the location on the map.');throw error;}
  finally{clearTimeout(timer);}
 };
}
