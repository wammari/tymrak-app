// Location is requested only after a punch click, never continuously.
export function capturePunchLocation(geolocation=globalThis.navigator?.geolocation) {
 return new Promise((resolve,reject)=>{
  if(!geolocation)return reject(new Error('Location is unavailable. Use a location-enabled device to clock.'));
  geolocation.getCurrentPosition(position=>resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMetres:position.coords.accuracy,capturedAt:position.timestamp}),error=>reject(new Error(error.code===1?'Allow location access in your browser settings to clock at your workplace.':error.code===3?'Location timed out. Move near a window or outside and try again.':'Unable to get an accurate location. Move near a window or outside and try again.')),{enableHighAccuracy:true,maximumAge:0,timeout:15000});
 });
}
