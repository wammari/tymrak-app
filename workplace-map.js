let sdkPromise;
export function loadGoogleMaps(apiKey,documentObject=document) {
 if(!sdkPromise)sdkPromise=new Promise((resolve,reject)=>{
  const script=documentObject.createElement('script');
  const params=new URLSearchParams({key:apiKey,v:'quarterly',libraries:'maps,places,marker',loading:'async',callback:'tymrakMapsReady'});
  globalThis.tymrakMapsReady=()=>{delete globalThis.tymrakMapsReady;resolve(globalThis.google.maps);};
  script.src=`https://maps.googleapis.com/maps/api/js?${params}`;script.async=true;
  script.onerror=()=>{delete globalThis.tymrakMapsReady;sdkPromise=null;reject(new Error('Map search could not load. Use manual coordinates or try again.'));};
  documentObject.head.append(script);
 });
 return sdkPromise;
}
export function placeValues(place) {
 const latitude=place.location?.lat(),longitude=place.location?.lng();
 if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180)throw new Error('This place has no usable map position. Choose another result.');
 return {latitude,longitude,address:place.formattedAddress||'',name:place.displayName||''};
}
export async function createWorkplaceMap({maps,config,searchContainer,mapContainer,onSelect,onError,getRadius}) {
 const [{Map,Circle},{AdvancedMarkerElement},{PlaceAutocompleteElement}]=await Promise.all([maps.importLibrary('maps'),maps.importLibrary('marker'),maps.importLibrary('places')]);
 const map=new Map(mapContainer,{center:{lat:43.65,lng:-79.38},zoom:13,mapId:config.mapId,streetViewControl:false,mapTypeControl:false});
 const circle=new Circle({map,center:map.getCenter(),radius:getRadius(),strokeColor:'#198660',fillColor:'#198660',fillOpacity:.15,clickable:false});
 const marker=new AdvancedMarkerElement({map,title:'Workplace centre'});
 const autocomplete=new PlaceAutocompleteElement();autocomplete.setAttribute('aria-label','Search workplace name or address');searchContainer.append(autocomplete);
 let selectionVersion=0;
 function setPosition(latitude,longitude){const position={lat:latitude,lng:longitude};marker.position=position;circle.setCenter(position);circle.setRadius(getRadius());map.setCenter(position);map.setZoom(18);}
 autocomplete.addEventListener('gmp-select',async({placePrediction})=>{
  const version=++selectionVersion;
  try {const place=placePrediction.toPlace();await place.fetchFields({fields:['displayName','formattedAddress','location']});if(version!==selectionVersion)return;
   const value=placeValues(place);setPosition(value.latitude,value.longitude);onSelect(value);
  }catch(error){if(version===selectionVersion)onError(error.message);}
 });
 autocomplete.addEventListener('gmp-error',()=>onError('Google location search is unavailable. You can still enter coordinates manually.'));
 map.addListener('click',event=>{if(!event.latLng)return;selectionVersion++;const latitude=event.latLng.lat(),longitude=event.latLng.lng();setPosition(latitude,longitude);onSelect({latitude,longitude});});
 return {setPosition,updateRadius(){circle.setRadius(getRadius());},cancelSelection(){selectionVersion++;}};
}
