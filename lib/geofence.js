// Pure geofence validation helpers. No production integration yet.
// All distances are metres; GPS accuracy is the browser-reported radius.
const EARTH_RADIUS_METRES = 6371008.8;

export function isValidCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function distanceMetres(lat1, lon1, lat2, lon2) {
  if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) {
    throw new TypeError("Invalid geofence coordinates");
  }
  const toRadians = value => value * Math.PI / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function evaluateGeofence({ latitude, longitude, accuracyMetres, capturedAt,
  workplaceLatitude, workplaceLongitude, radiusMetres, now = Date.now(),
  maxAccuracyMetres = 100, maxAgeMilliseconds = 30000 }) {
  if (!isValidCoordinate(latitude, longitude) ||
      !isValidCoordinate(workplaceLatitude, workplaceLongitude) ||
      !Number.isFinite(accuracyMetres) || accuracyMetres < 0 ||
      !Number.isFinite(radiusMetres) || radiusMetres <= 0 ||
      !Number.isFinite(maxAccuracyMetres) || maxAccuracyMetres <= 0 ||
      !Number.isFinite(maxAgeMilliseconds) || maxAgeMilliseconds <= 0) {
    return { allowed: false, reason: "invalid_location" };
  }
  const timestamp = typeof capturedAt === "number" ? capturedAt : Date.parse(capturedAt);
  if (!Number.isFinite(timestamp) || timestamp > now + 5000 ||
      now - timestamp > maxAgeMilliseconds) {
    return { allowed: false, reason: "stale_location" };
  }
  if (accuracyMetres > maxAccuracyMetres) {
    return { allowed: false, reason: "inaccurate_location" };
  }
  const distance = distanceMetres(latitude, longitude, workplaceLatitude, workplaceLongitude);
  // Conservative: the GPS uncertainty circle must fit inside the permitted radius.
  if (distance + accuracyMetres > radiusMetres) {
    return { allowed: false, reason: "outside_geofence", distanceMetres: distance };
  }
  return { allowed: true, reason: "inside_geofence", distanceMetres: distance };
}
