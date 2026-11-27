import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { capturePunchLocation, nativeLocationMessage } from "../geolocation.js";
import { PAGES, FILES, START_PAGE, addNativeConfig, nativeConfig, webOnlyLinks } from "../mobile/scripts/build-www.mjs";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("in the phone app, clock-in uses the phone's own location permission", async () => {
  const calls = [];
  const plugin = { getCurrentPosition: async options => { calls.push(options); return { coords: { latitude: 43.6, longitude: -79.4, accuracy: 8 }, timestamp: 1234 }; } };
  const original = globalThis.Capacitor;
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { Geolocation: plugin } };
  try {
    assert.deepEqual(await capturePunchLocation(), { latitude: 43.6, longitude: -79.4, accuracyMetres: 8, capturedAt: 1234 });
    assert.deepEqual(calls, [{ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }]);
    plugin.getCurrentPosition = async () => { throw new Error("Location permission was denied"); };
    await assert.rejects(capturePunchLocation(), /Settings, choose TYMRAK, then Location/);
  } finally { if (original === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = original; }
});

test("on the website nothing changes", async () => {
  const original = globalThis.Capacitor;
  globalThis.Capacitor = { isNativePlatform: () => false, Plugins: { Geolocation: { getCurrentPosition() { throw new Error("must not be used"); } } } };
  try {
    const browser = { getCurrentPosition(ok) { ok({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 4 }); } };
    assert.deepEqual(await capturePunchLocation(browser), { latitude: 1, longitude: 2, accuracyMetres: 3, capturedAt: 4 });
    await assert.rejects(capturePunchLocation({ getCurrentPosition(ok, fail) { fail({ code: 1 }); } }), /browser settings/);
  } finally { if (original === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = original; }
});

test("phone location errors become clear instructions", () => {
  assert.match(nativeLocationMessage({ message: "User denied location permission" }), /choose TYMRAK/);
  assert.match(nativeLocationMessage({ code: "OS-PLUG-GLOC-0007", message: "Location services are not enabled" }), /Turn on Location Services/);
  assert.match(nativeLocationMessage({ message: "Timeout expired" }), /timed out/);
  assert.match(nativeLocationMessage({}), /accurate location/);
});

test("the app bundle has every employee page, and each one points at the live server", () => {
  for (const page of PAGES) {
    const html = addNativeConfig(read(page), page);
    assert.match(html, /<script src="\/native-config\.js"><\/script>\n<script src="\/api-base\.js"><\/script>/, page);
    for (const ref of html.matchAll(/(?:src|href)="\/([^"#?]+)"/g)) {
      assert.ok(PAGES.includes(ref[1]) || FILES.includes(ref[1]) || ref[1] === "native-config.js" || ref[1] === "manager-login.html", `${page} needs ${ref[1]}`);
    }
    for (const ref of html.matchAll(/from "\.\/([^"]+)"/g)) assert.ok(FILES.includes(ref[1]), `${page} imports ${ref[1]}`);
  }
  for (const file of FILES) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
  assert.match(nativeConfig(), /window\.TYMRAK_API_BASE = "https:\/\/app\.tymrak\.com";/);
  assert.throws(() => nativeConfig("http://example.com"), /https origin/);
  assert.throws(() => nativeConfig('https://x.com";alert(1)//'), /https origin/);
  assert.equal(webOnlyLinks('["Privacy Policy", "/privacy"], ["Terms of Use", "/terms"], "/support"'),
    '["Privacy Policy", "https://app.tymrak.com/privacy"], ["Terms of Use", "https://app.tymrak.com/terms"], "/support"');
  assert.match(START_PAGE, /location\.replace\(signedIn\?"\/employee\.html":"\/login\.html"\)/);
});

test("the app's identity and permission texts are set", () => {
  const config = JSON.parse(read("mobile/capacitor.config.json"));
  assert.equal(config.appId, "com.tymrak.app");
  assert.equal(config.appName, "TYMRAK");
  assert.equal(config.plugins.CapacitorHttp.enabled, true, "API calls go through the phone, not the web view");
  const plist = read("mobile/ios/App/App/Info.plist");
  assert.match(plist, /<key>NSLocationWhenInUseUsageDescription<\/key>\s*<string>TYMRAK checks your location only when you clock in or out/);
  assert.doesNotMatch(plist, /NSLocationAlways/, "never asks for background location");
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.doesNotMatch(manifest, /ACCESS_BACKGROUND_LOCATION/);
});
