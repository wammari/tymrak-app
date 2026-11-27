# TYMRAK mobile app (employees)

The iPhone and Android app for employees. It packages the employee pages of the web app
(sign in, password help, clock in/out, timecard, time off, business switcher, account
deletion) with [Capacitor](https://capacitorjs.com), and talks to the live server at
`https://app.tymrak.com`. Managers keep using the web portal for now.

| | |
|---|---|
| App name | TYMRAK |
| App ID (bundle / package) | `com.tymrak.app` |
| Location | Only when the employee taps clock in/out (never in the background) |
| Server | `https://app.tymrak.com` (set in `scripts/build-www.mjs`) |

## How it fits together

- `scripts/build-www.mjs` copies the employee pages into `www/` and adds `native-config.js`
  so their `/api/...` calls go to app.tymrak.com. The pages themselves are the same files as
  the website, so a fix on the website is a fix in the app after the next build.
- `npx cap sync` copies `www/` into the iPhone project (`ios/`) and Android project (`android/`).
- API calls go through the phone's own networking (`CapacitorHttp`), not the web view.
- Clock-in uses the phone's location permission (`@capacitor/geolocation`). In the browser,
  `geolocation.js` keeps using the browser's location as before.
- Icons and splash screens come from `resources/` (`npm run assets` regenerates every size).

## Android: test on a phone

**Easiest: download the test app GitHub builds.**
1. Open the repository on GitHub → **Actions** → **TYMRAK Android test app** → the latest run.
2. Under **Artifacts**, download **tymrak-android-test-app** and unzip it: `app-debug.apk`.
3. Send the file to the Android phone (email, Google Drive), open it, and allow installing
   from that source when Android asks.

**Or build it yourself:** install [Android Studio](https://developer.android.com/studio), then:
```
cd mobile
npm install
npm run android        # builds, syncs and opens the project in Android Studio
```
Connect the phone with USB debugging on, and press ▶ Run.

## iPhone: test on your phone (needs a Mac)

1. Install **Xcode** from the Mac App Store and open it once to finish setup.
2. In Terminal:
   ```
   cd tymrak-app/mobile
   npm install
   npm run ios           # builds, syncs and opens the project in Xcode
   ```
3. In Xcode: select the **App** target → **Signing & Capabilities** → **Team**: sign in with
   your Apple ID ("Personal Team" is fine for testing).
4. Plug in the iPhone, pick it at the top of Xcode, and press ▶ Run.
   On the iPhone: Settings → General → VPN & Device Management → trust your developer profile.
   With a free Apple ID the test app stops opening after 7 days. Run it again from Xcode to renew it.

## After a change to the employee pages
```
cd mobile
npm run sync
```
Then build again in Xcode or Android Studio (or let GitHub build the Android test app).

## Before submitting to the stores (later)
- [ ] Corporation name final; **D-U-N-S number** for it (Apple and Google both require one for an organization account).
- [ ] **Apple Developer Program** (organization) and **Google Play Console** (organization) accounts.
- [ ] Final, high-resolution logo for the icon (SVG or 1024×1024 PNG) → `resources/`, then `npm run assets`.
- [ ] Privacy policy URL live (`https://app.tymrak.com/privacy`), plus the store privacy forms (location used only at clock-in/out, not for tracking).
- [ ] Store screenshots, description, support URL (`info@tymrak.com`), and a **test login** for the reviewers.
- [ ] Release signing: an Android upload key and an iOS distribution certificate (kept out of this repository).
