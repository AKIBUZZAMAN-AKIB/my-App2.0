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
| More | `www/shell/app.js` | Real screen listing the remaining mini apps **with their own icons**, plus honest device/app facts. |

### Mini apps inside More

Each has its own icon, its own colour and its own storage, and opens full-screen in
the app viewer (back bar + reload) so it never fights the tab bar:

| Mini app | File | Icon |
|---|---|---|
| Nearby Chat | `www/Bluetooth.html` | `bluetooth` |
| My Notebook | `www/my-note.html` | `note` |
| OpenShelf | `www/openshelf.html` | `shelf` |
| Reminders | `www/reminder.html` | `alarm` |
| Store | `www/store.html` | `store` |
| Habit Tracker | `www/habit-tracker.html` | `habit` |

---

## 2. How the shell works

```
index.html ── tabbar (HTML/CSS from www/shell/app.css, icons from www/shell/app.js)
   │
   ├── Home      → <iframe src="home.html">       (lazily created, kept alive)
   ├── Academic  → <iframe src="academic.html">
   ├── Agent     → <iframe src="agent.html">
   ├── Calendar  → <iframe src="calendar.html">
   └── More      → in-shell screen (tiles + device rows)
                     └── any mini app → full-screen viewer <iframe>
```

* Every destination is a **same-origin page in its own frame**, so each mini app keeps
  its own DOM, its own history and its own `window.NativeKit` — the shipped apps run
  unmodified.
* Routing is hash based (`#/home`, `#/app/note`, …) so the Android hardware back
  button walks history instead of dropping the user out of the app.
* A page can ask the shell to open another mini app:
  ```js
  parent.postMessage({ type: 'open-app', id: 'note' }, '*');
  ```
* Splash, tab transitions and the viewer slide respect `prefers-reduced-motion`.
* No sidebar anywhere; the store panel of each widget is a per-widget overlay.

### NativeKit

`scripts/prepare-web.mjs` builds `nativekit.js` from `bridge/nativekit.ts` and injects it
— together with the CSP from `app.config.json` — into **every root page** of the staged
build. Mini apps therefore never carry a hand-written bridge tag, and a page opened
directly behaves exactly like the same page inside the shell.

The shell and the new screens call only documented façade members:
`app.info()`, `app.state()`, `network.status()`, `permissions.check()`,
`permissions.openAppSettings()`, `share.show()`, `haptics.impact()`,
`preferences.get/set`, `notifications.check/request/schedule/cancel`,
`location.current()`, `http.get()`. Everything is guarded: when a feature is disabled in
`app.config.json`, or the page runs in a browser, the UI says so instead of faking data.

---

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
  index.html             tab shell (bottom bar + More screen + app viewer)
  shell/app.css          shell styles (system UI tokens, safe areas)
  shell/app.js           shell runtime (registry, routing, frames, More, device rows)
  home.html …            the mini apps, shipped as-is
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
