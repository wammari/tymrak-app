import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression checks for the opt-in Guelph pilot code. These do not replace
// end-to-end or database authorization tests.
const portal = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');

test('pilot geofence remains disabled pending secure rollout', () => {
  assert.match(portal, /enabled:\s*false,\s*\/\/ Enable only after verified building coordinates/);
});

test('pilot distance threshold is 50 metres', () => {
  assert.match(portal, /radiusMeters:\s*50/);
});

test('location verification runs before punch insert', () => {
  const verification = portal.indexOf('const verifiedLocation = await verifyPunchLocation()');
  const insert = portal.indexOf('.from("punches")', verification);
  assert.ok(verification !== -1 && insert > verification);
});

test('GPS requires fresh high-accuracy position and refuses poor readings', () => {
  assert.match(portal, /enableHighAccuracy:\s*true/);
  assert.match(portal, /maximumAge:\s*0/);
  assert.match(portal, /accuracy > PILOT_GEOFENCE.maxAccuracyMeters/);
});

test('validated coordinates are included only when a location is verified', () => {
  assert.match(portal, /\.\.\.\(verifiedLocation \? \{/);
  assert.match(portal, /float8:\s*verifiedLocation.latitude/);
  assert.match(portal, /longitude:\s*verifiedLocation.longitude/);
});
