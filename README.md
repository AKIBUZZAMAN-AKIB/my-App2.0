# My App

One Android app that hosts every mini app on this device: **Home**, **Academic**,
**Agent**, **Calendar** and a **More** screen with the rest of the apps. Built on
Capacitor 8 with the pinned **NativeKit** bridge, packaged as a signed APK and AAB
by GitHub Actions on every push.

| | |
|---|---|
| App name | My App |
| Application ID | `com.myapp.suite` |
| Version | 1.0.0 (version code grows with each published build) |
| URL scheme | `myapp` |
| Min SDK | 24 · Target SDK 36 |
| Theme | System only — light/dark/contrast/reduced-motion come from the OS |

---

## 1. Screens

### Bottom tab bar (5 destinations)

| Tab | Page | What it is |
|---|---|---|
| Home | `www/home.html` | Widget home screen: glance cards (Watch · Weather · Network · Next up) above a resizable widget grid. Long-press a widget for its own store panel. |
| Academic | `www/academic.html` | VU Academic Hub. |
| Agent | `www/agent.html` | AI agent chat with the native agent engine. |
| Calendar | `www/calendar.html` | Full Calendar. |
| More | `www/more.html` | Real main page listing the remaining apps **with their own icons**, plus honest device/app facts. |

### The other main apps (reachable from More)

Each is its own top-level page with its own icon, colour, storage and native bridge:

| Mini app | File | Icon |
|---|---|---|
| Nearby Chat | `www/Bluetooth.html` | `bluetooth` |
| My Notebook | `www/my-note.html` | `note` |
| OpenShelf | `www/openshelf.html` | `shelf` |
| Reminders | `www/reminder.html` | `alarm` |
| Store | `www/store.html` | `store` |
| Habit Tracker | `www/habit-tracker.html` | `habit` |

---

## 2. How the app is wired

**Every `.html` in `www/` is a main app and runs as its own top-level page.**
Nothing is mounted inside an iframe: Capacitor injects `window.Capacitor`, the
`NativeKit` bridge and the `--safe-area-inset-*` variables into the **top frame only**
(`MainActivity` publishes the insets with `webView.evaluateJavascript`), so a page in a
frame would silently fall back to the web stubs — no native agent staging, no native
APIs. Navigation is therefore full-document:

```
index.html ── location.replace('./home.html')      (launcher only)
home.html ──── academic.html ──── agent.html ──── calendar.html ──── more.html
                                                          │
                        Bluetooth.html · my-note.html · openshelf.html
                        reminder.html · store.html · habit-tracker.html
```

* **The 5-button bar is shared, not duplicated.** `www/shell/nav.js` + `nav.css` are
  injected into **every main page at build time** by `scripts/prepare-web.mjs`, so the
  shipped app files stay byte-identical while each page shows the same bar.
* The bar is a floating, auto-hiding pill: it slides away while you scroll down, when a
  field is focused and when the keyboard opens, so it never covers an app's own composer
  or action bar. Re-tapping the active tab scrolls that app to the top.
* Bars for the six extra apps stay lit on **More**; `more.html` is a real main page
  listing them with their own icons, plus live device rows and About actions.
* Each app is free to use the whole page and the whole native surface.

### NativeKit

`scripts/prepare-web.mjs` builds `nativekit.js` from `bridge/nativekit.ts` and injects it
— together with the CSP from `app.config.json` — into **every root page** of the staged
build (bridge first, always). Source files carry no hand-written bridge tag.

`more.html` and the shell call only documented façade members:
`app.info()`, `network.status()`, `permissions.check()`, `permissions.openAppSettings()`,
`share.show()`. Everything is guarded: when a feature is disabled in `app.config.json`,
or the page runs in a browser, the UI says so instead of faking data.

## 3. Build

```bash
npm ci                      # Node 22
npm run check               # config schema + typecheck + 325 unit tests + web staging
npm run ci:android          # stage www, cap sync, regenerate android config
cd android && ./gradlew assembleRelease bundleRelease
```

Requires JDK 21 and the Android SDK. `plugins/native-agent/dist` is committed so the
bridge bundles without a separate plugin build; rebuild it with
`npm --prefix plugins/native-agent run build` after changing the plugin's TypeScript.

### Signing

Release builds are signed with the project keystore. Locally, export:

```bash
export ANDROID_KEYSTORE_PATH=/path/to/myapp-release.jks
export ANDROID_KEYSTORE_PASSWORD=…
export ANDROID_KEY_ALIAS=myapp
export ANDROID_KEY_PASSWORD=…
```

`android/app/build.gradle` picks the values up; without them the release build is
unsigned (Gradle refuses to install it).

In CI the same four values come from repository secrets:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. If the secrets are missing the workflow generates a throwaway
keystore so the release APK is still signed and installable for testing — it then says
so in the release notes.

> Keep the `.jks` and its passwords safe and backed up. Losing the identity means you
> can never publish an update for `com.myapp.suite` on Google Play.

---

## 4. Continuous delivery

`.github/workflows/android.yml` runs on every push to `main` (and on tags / manual runs):

1. `npm ci` → `npm run check` (schema, types, tests, staging).
2. Prepares the signing key (secrets, else ephemeral).
3. `npm run ci:android`, then stamps a monotonic `versionCode` (`100 + run number`).
4. Builds `assembleDebug`, `assembleRelease`, `bundleRelease`.
5. Verifies the release APK signature with `apksigner verify --print-certs`.
6. Publishes a **GitHub Release** (`build-<run-number>`) with
   `MyApp-1.0.0-release.apk`, `MyApp-1.0.0-release.aab`, `MyApp-1.0.0-debug.apk` and
   `SHA256SUMS.txt`.

Install `MyApp-1.0.0-release.apk` on a device; upload the `.aab` to Play.

---

## 5. Repository layout

```
www/                     the app surface
  index.html             launcher redirect to home.html
  home.html …            the main apps, shipped byte-identical
  more.html              the fifth destination: the other apps + device rows
  shell/nav.js           the shared 5-button bar (injected at build time)
  shell/nav.css          bar styles (system UI tokens, safe areas, auto-hide)
  nativekit.js           generated at build time (not in git)
bridge/, plugins/        NativeKit bridge + native plugins (agent, widget, browser…)
android/                 Capacitor Android project (app id, icons, manifest, gradle)
scripts/                 config validation, web staging, native configure
tests/                   vitest suites for the bridge, plugins and staging contract
app.config.json          the single source of truth for native configuration
```

## 6. Notes

* The previous demo launcher (`www/app.js`, `styles.css`, app-browser demo pages) was
  replaced by the tab shell; the unit tests that asserted that demo UI were removed with
  it. The plugin/bridge suites (325 tests) all still pass.
* Icons: adaptive launcher icon (gradient + the M mark) generated for every density,
  with matching splash screens; the Play listing icon lives in `store/icon-512.png`.
