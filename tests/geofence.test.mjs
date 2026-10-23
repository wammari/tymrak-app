import test from "node:test";
import assert from "node:assert/strict";
import { distanceMetres, evaluateGeofence, isValidCoordinate } from "../lib/geofence.js";

const now = Date.parse("2026-10-20T16:00:00Z");
const base = {
  latitude: 43.3255, longitude: -79.7990,
  workplaceLatitude: 43.3255, workplaceLongitude: -79.7990,
  accuracyMetres: 10, radiusMetres: 150,
  capturedAt: now - 1000, now
};

test("validates coordinates including edges", () => {
  assert.equal(isValidCoordinate(90, 180), true);
  assert.equal(isValidCoordinate(-90, -180), true);
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(NaN, 0), false);
  assert.equal(isValidCoordinate(0, Infinity), false);
});
test("same location distance is zero", () => {
  assert.equal(distanceMetres(43, -79, 43, -79), 0);
});
test("distance is symmetric and antimeridian-safe", () => {
  const east = distanceMetres(0, 179.9, 0, -179.9);
  const west = distanceMetres(0, -179.9, 0, 179.9);
  assert.ok(east > 20000 && east < 23000);
  assert.equal(east, west);
});
test("rejects invalid coordinates", () => {
  assert.throws(() => distanceMetres(100, 0, 0, 0), TypeError);
});
test("accepts fresh accurate location inside fence", () => {
  assert.equal(evaluateGeofence(base).allowed, true);
});
test("rejects outside location", () => {
  assert.equal(evaluateGeofence({...base, latitude: 43.35}).reason, "outside_geofence");
});
test("rejects accuracy circle crossing boundary", () => {
  assert.equal(evaluateGeofence({...base, accuracyMetres: 100, radiusMetres: 50}).reason, "outside_geofence");
});
test("rejects insufficient accuracy", () => {
  assert.equal(evaluateGeofence({...base, accuracyMetres: 101}).reason, "inaccurate_location");
});
test("rejects stale and future locations", () => {
  assert.equal(evaluateGeofence({...base, capturedAt: now - 30001}).reason, "stale_location");
  assert.equal(evaluateGeofence({...base, capturedAt: now + 5001}).reason, "stale_location");
});
test("rejects absent location and invalid radius", () => {
  assert.equal(evaluateGeofence({...base, latitude: undefined}).reason, "invalid_location");
  assert.equal(evaluateGeofence({...base, radiusMetres: 0}).reason, "invalid_location");
});
