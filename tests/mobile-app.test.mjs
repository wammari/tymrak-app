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

import { planReminders, syncReminders, REMINDER_IDS, mountReminderSetting } from "../native-reminders.js";

const H = 3600000;
const NOW = Date.parse("2026-11-28T15:00:00Z"); // 10:00 a.m. Toronto
const punches = [{ punch_type: "clock_in", punched_at: "2026-11-28T14:00:00Z" }];

test("reminders: clock-out 10 hours after clocking in, break after 60 minutes, nothing when off the clock", () => {
  const [work] = planReminders({ status: "working", punches, timeZone: "America/Toronto", now: NOW });
  assert.equal(work.id, REMINDER_IDS.clockOut);
  assert.equal(work.at, Date.parse("2026-11-28T14:00:00Z") + 10 * H);
  assert.equal(work.title, "Still clocked in?");
  assert.equal(work.body, "You clocked in at 9:00 a.m. and haven't clocked out. Open TYMRAK if you've finished work.");
  assert.doesNotMatch(work.body, /\.\./, "no double period after a.m.");
  const breakStart = { punch_type: "break_start", punched_at: "2026-11-28T14:45:00Z" };
  const [rest] = planReminders({ status: "on_break", punches, lastPunch: breakStart, timeZone: "America/Toronto", now: NOW });
  assert.equal(rest.id, REMINDER_IDS.longBreak);
  assert.equal(rest.at, Date.parse("2026-11-28T15:45:00Z"));
  assert.equal(rest.body, "Your break started at 9:45 a.m. and hasn't ended. Open TYMRAK when you're back.");
  assert.deepEqual(planReminders({ status: "not_clocked_in", punches, now: NOW }), []);
  assert.deepEqual(planReminders({ status: "working", punches, now: NOW + 11 * H }), [], "never schedules in the past");
  const later = [...punches, { punch_type: "clock_out", punched_at: "2026-11-28T16:00:00Z" }, { punch_type: "clock_in", punched_at: "2026-11-28T17:00:00Z" }];
  assert.equal(planReminders({ status: "working", punches: later, now: NOW }).at(0).at, Date.parse("2026-11-28T17:00:00Z") + 10 * H, "uses the latest clock-in");
});

function fakePhone({ permission = "prompt", answer = "granted", off = false } = {}) {
  const calls = [];
  const store = new Map(off ? [["tymrak-reminders-off", "1"]] : []);
  const plugin = {
    cancel: async a => { calls.push(["cancel", a.notifications.map(n => n.id)]); },
    checkPermissions: async () => ({ display: permission }),
    requestPermissions: async () => { calls.push(["ask"]); return { display: answer }; },
    schedule: async a => { calls.push(["schedule", a.notifications]); }
  };
  const scope = { Capacitor: { isNativePlatform: () => true, Plugins: { LocalNotifications: plugin } },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) } };
  return { calls, scope, store };
}

test("reminders are replaced on every sync, ask permission once needed, and respect 'off'", async () => {
  let phone = fakePhone();
  assert.equal(await syncReminders({ status: "working", punches, now: NOW }, phone.scope), "scheduled");
  assert.deepEqual(phone.calls.map(c => c[0]), ["cancel", "ask", "schedule"]);
  assert.deepEqual(phone.calls[0][1], [7101, 7102]);
  assert.equal(phone.calls[2][1][0].schedule.at.getTime(), Date.parse("2026-11-28T14:00:00Z") + 10 * H);
  phone = fakePhone();
  assert.equal(await syncReminders({ status: "not_clocked_in", punches, now: NOW }, phone.scope), "none");
  assert.deepEqual(phone.calls.map(c => c[0]), ["cancel"], "clocking out just cancels");
  phone = fakePhone({ answer: "denied" });
  assert.equal(await syncReminders({ status: "working", punches, now: NOW }, phone.scope), "denied");
  assert.ok(!phone.calls.some(c => c[0] === "schedule"));
  phone = fakePhone({ off: true });
  assert.equal(await syncReminders({ status: "working", punches, now: NOW }, phone.scope), "off");
  assert.deepEqual(phone.calls.map(c => c[0]), ["cancel"]);
  assert.equal(await syncReminders({ status: "working", punches, now: NOW }, { Capacitor: { isNativePlatform: () => false } }), "unsupported", "website: nothing");
  const broken = fakePhone(); broken.scope.Capacitor.Plugins.LocalNotifications.schedule = async () => { throw new Error("boom"); };
  assert.equal(await syncReminders({ status: "working", punches, now: NOW }, broken.scope), "error", "never throws");
});

test("the reminder switch only appears in the app and saves the choice", () => {
  const made = [];
  const doc = { createElement: tag => { const el = { tag, children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(t, f) { this.listeners[t] = f; } }; made.push(el); return el; } };
  const container = { ownerDocument: doc, hidden: true, replaceChildren(...c) { this.children = c; } };
  assert.equal(mountReminderSetting(container, null, { Capacitor: { isNativePlatform: () => false } }), null);
  assert.equal(container.hidden, true);
  const phone = fakePhone();
  const seen = [];
  const box = mountReminderSetting(container, on => seen.push(on), phone.scope);
  assert.equal(container.hidden, false);
  assert.equal(box.checked, true);
  box.checked = false; box.listeners.change();
  assert.equal(phone.store.get("tymrak-reminders-off"), "1");
  assert.deepEqual(seen, [false]);
});

test("app polish: readable status bar, content below the notch, no stray splash files, no exact alarms", () => {
  const config = JSON.parse(read("mobile/capacitor.config.json"));
  assert.equal(config.plugins.StatusBar.style, "LIGHT", "dark text on the light TYMRAK background");
  assert.equal(config.ios.contentInset, "always");
  assert.equal(config.plugins.LocalNotifications.smallIcon, "ic_stat_tymrak");
  const splash = new URL("../mobile/ios/App/App/Assets.xcassets/Splash.imageset/", import.meta.url);
  const listed = JSON.parse(fs.readFileSync(new URL("Contents.json", splash), "utf8")).images.map(i => i.filename);
  assert.deepEqual(fs.readdirSync(splash).filter(f => f.endsWith(".png")).sort(), [...listed].sort());
  const manifest = read("mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /SCHEDULE_EXACT_ALARM" tools:node="remove"/);
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    assert.ok(fs.existsSync(new URL(`../mobile/android/app/src/main/res/drawable-${density}/ic_stat_tymrak.png`, import.meta.url)), density);
  }
  assert.ok(FILES.includes("native-reminders.js"));
});
