// Location is requested only after a punch click, never continuously.
// In the TYMRAK phone app (Capacitor) the phone's own location permission is used, so the
// system prompt says "TYMRAK" and the employee can manage it in the phone's Settings.
const WEB_DENIED = 'Allow location access in your browser settings to clock at your workplace.';
const APP_DENIED = 'Allow location for TYMRAK to clock at your workplace: open your phone\'s Settings, choose TYMRAK, then Location, and pick "While Using the App".';
const SERVICES_OFF = 'Turn on Location Services in your phone\'s Settings to clock at your workplace.';
const TIMED_OUT = 'Location timed out. Move near a window or outside and try again.';
const INACCURATE = 'Unable to get an accurate location. Move near a window or outside and try again.';

export function nativeGeolocation(scope = globalThis) {
  const capacitor = scope?.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) return null;
  const plugin = capacitor.Plugins?.Geolocation;
  return plugin && typeof plugin.getCurrentPosition === 'function' ? plugin : null;
}

const toLocation = position => ({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMetres: position.coords.accuracy, capturedAt: position.timestamp });

export function nativeLocationMessage(error) {
  const text = `${error?.code || ''} ${error?.message || error || ''}`.toLowerCase();
  if (/denied|permission|not authori[sz]ed|restricted/.test(text)) return APP_DENIED;
  if (/disabled|services|turned off|not enabled/.test(text)) return SERVICES_OFF;
  if (/time ?out|timed out/.test(text)) return TIMED_OUT;
  return INACCURATE;
}

export function capturePunchLocation(geolocation = globalThis.navigator?.geolocation, scope = globalThis) {
  const native = arguments.length === 0 ? nativeGeolocation(scope) : null;
  if (native) {
    return native.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
      .then(toLocation, error => { throw new Error(nativeLocationMessage(error)); });
  }
  return new Promise((resolve, reject) => {
    if (!geolocation) return reject(new Error('Location is unavailable. Use a location-enabled device to clock.'));
    geolocation.getCurrentPosition(position => resolve(toLocation(position)),
      error => reject(new Error(error.code === 1 ? WEB_DENIED : error.code === 3 ? TIMED_OUT : INACCURATE)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  });
}
