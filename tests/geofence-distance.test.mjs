import test from "node:test";
import assert from "node:assert/strict";
import { distanceMeters } from "../api/submit-punch.js";

test("distance is zero for identical coordinates", () => {
  assert.equal(distanceMeters(43.55, -80.25, 43.55, -80.25), 0);
});

test("distance function measures approximately 111 metres per 0.001 latitude", () => {
  const distance = distanceMeters(43.55, -80.25, 43.551, -80.25);
  assert.ok(distance > 110 && distance < 112);
});

test("50-metre boundary distinguishes nearby and outside points", () => {
  assert.ok(distanceMeters(43.55, -80.25, 43.5502, -80.25) < 50);
  assert.ok(distanceMeters(43.55, -80.25, 43.551, -80.25) > 50);
});
