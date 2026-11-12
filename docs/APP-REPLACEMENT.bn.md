# App setup ও web code replacement workflow

> এই workflow-এর output parent host-এর পূর্ণ `window.NativeKit` পায়; তাই শুধু নিজের/audited trusted code দিন। User/third-party HTML, CSS, JavaScript, ZIP বা Web Component-এর জন্য [`API-REFERENCE.bn.md`](./API-REFERENCE.bn.md)-এর sandboxed App Browser manager ব্যবহার করুন।

## ১. Repository প্রস্তুত করা

```bash
npm ci
npm run validate:config
npm run check
```

`npm ci` অবশ্যই committed `package-lock.json` অনুসরণ করে। Capacitor 8-এর জন্য Node 22+ ব্যবহার করুন। প্রথমবার native folders না থাকলে:

```bash
npm run native:init
```

এই repository-তে `android/` ও `ios/` আগে থেকেই আছে; সাধারণত `npm run native:sync`-ই যথেষ্ট।

## ২. Static app replacement

Default `web.mode` হলো `static`; source directory `www/`।

### আবশ্যিক নিয়ম

- `www/index.html` থাকতে হবে এবং তাতে `<html>` element থাকতে হবে।
- HTML/CSS/JS/assets নিজে চলার উপযোগী static output হতে হবে। React/Vue/Angular source সরাসরি এখানে দিলে build হবে না।
- asset URL relative করুন। ভালো: `./assets/app.js`; ঝুঁকিপূর্ণ: filesystem absolute URL বা dev-server URL।
- `nativekit.js` include করবেন না; staging script নিজে generated bridge inject করে।
- production `server.url`, localhost dev server, `file://`, বা hosted UI-এর ওপর নির্ভর করবেন না।
- symlink নিষিদ্ধ; staging symlink পেলে fail করে।
- `.git`, `.nativekit`, `node_modules` source-এর মধ্যে থাকলেও copy হয় না।
- trusted/audited code ছাড়া কিছু দেবেন না।

### Replacement command sequence

```bash
# www/ contents বদলানোর পরে
npm run check
npm run native:sync
```

Pipeline:

1. `app.config.json` schema ও cross-field policy check
2. `www/` থেকে clean copy → `.nativekit/staged-www/`
3. `bridge/nativekit.ts` bundle → generated `nativekit.js`
4. CSP ও bridge script `index.html`-এ inject
5. native target থেকে generated Service Worker files বাদ/unregister
6. local bundle Android/iOS project-এ Capacitor sync
7. manifest/plist/AppDelegate/build settings config থেকে regenerate

`.nativekit/staged-www/` build product; হাতে edit করলে পরের run-এ হারাবে।

## ৩. Framework source workflow

Framework project root ধরা যাক `web-source/`:

```json
{
  "web": {
    "mode": "framework",
    "framework": {
      "workDir": "web-source",
      "buildCommand": "npm ci && npm run build",
      "outputDir": "dist"
    }
  }
}
```

`outputDir` `workDir`-এর relative। এখানে উদাহরণে final file হতে হবে `web-source/dist/index.html`। command project root-এর shell-এ চলে, তাই configuration ও source trusted হতে হবে।

Framework checklist:

- client-side/static build output; SSR server dependency নয়
- relative asset base
- client-side routing হলে unknown route/reload behavior native WebView-এ পরীক্ষা করুন
- runtime environment variables build-এর সময় embed হবে; secret কখনো browser bundle-এ দেবেন না
- source map production artifact-এ চাই কিনা সিদ্ধান্ত নিন
- framework-generated Service Worker native target-এর জন্য disable করা উত্তম

## ৪. NativeKit startup

Injected script app script-এর আগে রাখা হয়। তবু module/defer/loading order-independent code লিখতে:

```js
async function start() {
  await window.NativeKit.ready();
  console.log(window.NativeKit.platform, window.NativeKit.capabilities());
}

if (window.NativeKit) start();
else addEventListener('nativekitready', start, { once: true });
```

Browser preview-তে একই bridge web fallback ব্যবহার করে, কিন্তু native-only API (যেমন bundled SQLite adapter বা secure native store) native platform ছাড়া কাজ নাও করতে পারে। capability/error handle করুন।

## ৫. পৃথক web/PWA target

```bash
npm run prepare:web
```

ফল `web-dist/`। `web.serviceWorker.enabledForWebTarget=true` হলে:

- `nativekit-sw.js` ও registration script generate হয়
- file content hash বদলালে cache revision বদলায়
- same-origin static assets pre-cache হয়
- navigation network-first, offline-এ configured fallback
- registration কেবল HTTPS, `localhost`, বা `127.0.0.1`-এ

এটি আলাদা hosted web target-এর জন্য। Native app local bundle-এ Service Worker নির্ভর করবেন না। Service Worker third-party CORS bypass করতে পারে না।

## ৬. Version ও identity বদলানো

প্রতি release-এ অন্তত:

- `app.versionName`: user-visible semantic version
- `app.versionCode`: Android-এর strictly increasing integer
- `app.buildNumber`: iOS-এর increasing build number

App identity বদলাতে `app.id`, `app.name`, `app.urlScheme`, background task identifier এবং signing profiles সামঞ্জস্য করুন। `backgroundRunner.label` ও `backgroundRunner.taskIdentifier` একই রাখতে validator বাধ্য করে। App ID বদলালে পুরোনো installed app-এর update continuity, Keychain/Keystore data, associated signing, provisioning এবং store listing প্রভাবিত হবে।

## ৭. Local build

Android:

```bash
npm run native:sync
cd android
./gradlew assembleDebug
./gradlew assembleRelease
./gradlew bundleRelease
```

Local release signing environment variables ও iOS build-এর জন্য [BUILD-SIGNING-CI.bn.md](./BUILD-SIGNING-CI.bn.md) দেখুন।

## ৮. CI workflow

- push/PR → Android check + debug APK + release APK/AAB; signing secrets না থাকলে release files unsigned
- push/PR → iOS check + unsigned simulator compile
- manual iOS workflow with `create_ipa=true`, অথবা `v*` tag → signed archive/IPA; secrets আবশ্যক
- artifact-এর সঙ্গে `SHA256SUMS.txt` দেওয়া হয়

## ৯. Release preflight

- [ ] শুধুই trusted local app code
- [ ] `npm ci` ও `npm run check` pass
- [ ] app ID/name/version/build numbers ঠিক
- [ ] production hostname allowlist/CSP ঠিক
- [ ] cleartext HTTP off
- [ ] permission purpose text সত্য ও feature-specific
- [ ] policy-sensitive feature justification/privacy disclosure প্রস্তুত
- [ ] real Android/iPhone-এ permission denial, offline, background, alarm, file transfer পরীক্ষা
- [ ] signing secrets ও profiles বর্তমান app ID/team-এর
- [ ] push ব্যবহার করলে Firebase/APNs capability/config আলাদাভাবে সম্পন্ন
