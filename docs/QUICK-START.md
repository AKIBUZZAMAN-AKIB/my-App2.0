# NativeKit Quick-Start Checklist

A compact, ordered checklist to go from a repository clone to a working web component / mini-app in the shell.
Use the [Web Developer Guide](./WEB-DEV-GUIDE.md) for the hero flow and the
[Mini-App Creator Guide](./MINI-APP-CREATOR-GUIDE.md) for the deep reference.

## Prerequisites
- [ ] Node.js **22+** (`node -v`)
- [ ] Android build: JDK **21** + Android SDK / API 36
- [ ] iOS local build: macOS, Xcode 26+, Apple signing credentials

## Build & run the shell
- [ ] `npm ci`
- [ ] `npm run check` — validates config, strict typecheck, runs the test suite (`npm test`), and stages the web content
- [ ] `npm run native:sync` — syncs Capacitor + rewrites Android/iOS permissions/identity/version
- [ ] Android debug APK: `npm run android:debug` (or `npx cap open android` / `open:ios`)

## Replace the trusted web UI (optional)
- [ ] Put your static app in `www/` (relative asset URLs; no Capacitor/nativekit import needed)
- [ ] Update identity/version/features/permission text in `app.config.json`
- [ ] `npm run check && npm run native:sync`

## Ship a web component (the 1-minute path)
- [ ] Confirm `features.appBrowser` and `appBrowser.enabled` are `true` in `app.config.json`
- [ ] Open the shell → **Sandboxed App Browser → ⚡ Quick Add**
- [ ] Pick one `.js`/`.mjs` that calls `customElements.define('my-widget', …)`
- [ ] Verify the auto-detected **tag**; add a display name if you like; press **Install & run**
- [ ] First native call → allow it (or open **API policy** and set it to Always allow)

## Deep mini-app (optional)
- [ ] Add a `nativekit.manifest.json` at the package root (see Creator Guide §3)
- [ ] Declare `requestedCapabilities` and (if you need network) `allowedHosts` / `networkMode`
- [ ] Test as ZIP, multi-file, and folder upload
- [ ] Check **Usage Audit** for what the app actually called

## Before a release
- [ ] Review **Security Policy** "golden rules"
- [ ] Verify push only if Firebase/APNs credentials are configured (not configurable yet)
- [ ] Build/verify both platforms; run a device smoke test (widgets, web component, native calls)
- [ ] Sign & export (see [Build, Signing & CI](./BUILD-SIGNING-CI.bn.md))

## Health-check commands
```bash
npm run check                 # config + typecheck + tests + staging
npm run validate:config       # config/schema cross-field validation
npm run typecheck             # tsc --noEmit
npm test                      # vitest run
npm run prepare:web           # separate HTTPS/localhost web target
```
