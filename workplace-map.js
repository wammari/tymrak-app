let leafletPromise;
export function loadLeaflet(documentObject=document) {
 if(globalThis.L)return Promise.resolve(globalThis.L);
 if(!leafletPromise)leafletPromise=new Promise((resolve,reject)=>{
  const css=documentObject.createElement('link'),script=documentObject.createElement('script');
  css.rel='stylesheet';css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';css.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';css.crossOrigin='anonymous';
  script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';script.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';script.crossOrigin='anonymous';script.async=true;
  let loaded=0,finished=false;
  const fail=()=>{if(finished)return;finished=true;clearTimeout(timer);css.remove();script.remove();leafletPromise=null;reject(new Error('The map could not load. Try again or enter coordinates manually.'));};
  const ready=()=>{if(finished||++loaded!==2)return;if(!globalThis.L)return fail();finished=true;clearTimeout(timer);resolve(globalThis.L);};
  const timer=setTimeout(fail,20000);css.onload=ready;script.onload=ready;css.onerror=fail;script.onerror=fail;
  documentObject.head.append(css,script);
 });
 return leafletPromise;
}
export function validPosition(latitude,longitude){return Number.isFinite(latitude)&&Math.abs(latitude)<=90&&Number.isFinite(longitude)&&Math.abs(longitude)<=180;}
export function createWorkplaceMap({leaflet,config,mapContainer,onSelect,onError,getRadius}) {
 const map=leaflet.map(mapContainer,{worldCopyJump:true}).setView([43.65,-79.38],12);
 const tiles=leaflet.tileLayer(config.tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',referrerPolicy:'strict-origin-when-cross-origin'}).addTo(map);
 tiles.on('tileerror',()=>onError('Some map tiles could not load. You can still use the pin or enter coordinates manually.'));
 const marker=leaflet.marker([43.65,-79.38],{draggable:true,title:'Workplace centre: drag to adjust',icon:leaflet.divIcon({className:'workplace-pin',html:'<span aria-hidden="true">●</span>',iconSize:[26,26],iconAnchor:[13,13]})});
 const circle=leaflet.circle([43.65,-79.38],{radius:getRadius(),color:'#198660',fillOpacity:.15,interactive:false});
 let selected=false;
 function setPosition(latitude,longitude,pan=true){if(!validPosition(latitude,longitude))return false;
  const position=[latitude,longitude];marker.setLatLng(position);circle.setLatLng(position);circle.setRadius(getRadius());
  if(!selected){marker.addTo(map);circle.addTo(map);selected=true;}if(pan)map.setView(position,18);return true;
 }
 function select(latitude,longitude){if(setPosition(latitude,longitude,false))onSelect({latitude,longitude});}
 map.on('click',event=>select(event.latlng.lat,event.latlng.wrap().lng));
 marker.on('dragend',()=>{const p=marker.getLatLng().wrap();select(p.lat,p.lng);});
 return {setPosition,updateRadius(){circle.setRadius(getRadius());},clearSelection(){if(selected){map.removeLayer(marker);map.removeLayer(circle);selected=false;}},destroy(){map.remove();}};
}
