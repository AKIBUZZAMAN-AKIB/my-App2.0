# TitanChartPro: Capacitor 8 গভীর অডিট ও বাস্তবায়ন পরিকল্পনা

**গবেষণা/অডিটের তারিখ:** ১৬ আগস্ট ২০২৬  
**পর্যালোচিত ফাইল:** `package.json`, `capacitor.config.json`, `build.txt`, `cors-proxy.js`  
**লক্ষ্য:** browser/web UI বজায় রেখে Android/iOS native alarm, vibration, local/push notification, lifecycle, storage, GPS, camera, download এবং CORS/API proxy সুবিধা যোগ করা।

---

## ১. এক বাক্যে সিদ্ধান্ত

Capacitor এই কাজের জন্য উপযুক্ত: UI HTML/CSS/JavaScript-ই থাকবে, কিন্তু install করা Android/iOS app-এ JavaScript থেকে native plugin ডাকা যাবে। তবে Capacitor কোনো “সবসময় চলমান browser tab” বানায় না—exact alarm, দীর্ঘ background service, background GPS এবং foreground-এ জোর করে app খোলার ক্ষেত্রে OS ও app-store policy মেনে আলাদা native নকশা প্রয়োজন।

### সবচেয়ে জরুরি সিদ্ধান্ত

1. **Capacitor 5 → 8 migrate করুন**, কিন্তু major-by-major এবং test করে।
2. **`cordova-plugin-background-mode` বাদ দিন**; আধুনিক Android/iOS-এ এটি unrestricted permanent background execution দিতে পারবে না।
3. **Reminder-এর জন্য Local Notifications**, সত্যিকারের alarm-clock আচরণের জন্য Android custom native alarm plugin/clock intent এবং iOS 26+ AlarmKit bridge ব্যবহার করুন।
4. **`server.allowNavigation: ["https://*"]` সরান**; এটি CORS সমাধান করে না এবং untrusted remote page-কে privileged WebView-তে ঢোকাতে পারে।
5. **`cors-proxy.js` Capacitor-এর ভেতরে সরাসরি চলবে না**—এটি Node server। Native non-streaming API call-এ `CapacitorHttp`, আর web/PWA ও SSE streaming-এ hardened backend proxy ব্যবহার করুন।
6. **প্রতি CI run-এ নতুন keystore তৈরি করা অবিলম্বে বন্ধ করুন**; একই app update করতে একই signing identity লাগবে।

---

## ২. তিনটি runtime আলাদা করে বুঝতে হবে

| Runtime | UI | Native plugin | Browser CORS | Background ক্ষমতা |
|---|---|---:|---:|---|
| Install করা Capacitor Android/iOS app | WebView-এ web UI | হ্যাঁ | `CapacitorHttp` native call-এ bypass হতে পারে | OS policy অনুযায়ী native task/plugin |
| সাধারণ website/PWA | Chrome/Safari | না | পুরোপুরি প্রযোজ্য | Service Worker/web platform-এর সীমা |
| Capacitor-এর bundled runner | Headless সীমিত JS | সীমিত custom API | runner-এর `fetch` আছে | ছোট, stateless, OS-scheduled burst |

**গুরুত্বপূর্ণ:** একই website Chrome-এ খুললেই Capacitor native plugin পাওয়া যাবে না। `Capacitor.isNativePlatform()` ব্যবহার করে native implementation ও web fallback আলাদা করতে হবে।

প্রোডাকশনে UI `www`-এর মধ্যে bundle করা ভালো। `server.url` বা broad `allowNavigation` দিয়ে পুরো remote website-কে main WebView-তে চালানো native bridge-এর attack surface বাড়ায়। External/untrusted page system browser, `Browser`, অথবা isolated `InAppBrowser`-এ খুলুন।

---

## ৩. সংযুক্ত ফাইলগুলোর অডিট

### ৩.১ `package.json`

বর্তমান সমস্যা:

- সব Capacitor dependency `^5.0.0`; v5 এখন পুরোনো major।
- `@capacitor/cli` runtime dependency-তে; সাধারণত এটি `devDependencies`-এ থাকা উচিত।
- Camera, Geolocation, App, Filesystem, File Transfer, Push Notifications ইত্যাদি অনুপস্থিত।
- `cordova-plugin-background-mode@0.7.3` বহু বছরের পুরোনো এবং আধুনিক foreground-service/background policy-এর নিরাপদ ভিত্তি নয়।
- caret range থাকলেও lockfile ছাড়া build deterministic নয়।

**সমাধান:** official/plugin-compatible v8 packages, exact lockfile, `npm ci`, এবং obsolete Cordova background plugin অপসারণ।

### ৩.২ `capacitor.config.json`

বর্তমান সমস্যা:

- `bundledWebRuntime` পুরোনো config; v8 baseline থেকে সরান।
- `allowNavigation: ["https://*"]` API CORS খুলে দেয় না। `allowNavigation` remote **page navigation**-কে main privileged WebView-তে অনুমতি দেয় এবং production-এর জন্য broad wildcard বিপজ্জনক।
- Splash settings বৈধ হলেও Android 12+ launch splash-এ `splashFullScreen`/`splashImmersive` প্রত্যাশামতো প্রভাব নাও ফেলতে পারে; Android 12 Splash API নিজস্ব নিয়ম ব্যবহার করে।
- release hardening (`allowMixedContent: false`, production web debugging off, logging policy) স্পষ্ট নয়।

### ৩.৩ `build.txt`

| সমস্যা | ফলাফল | করণীয় |
|---|---|---|
| Node 18 | Capacitor 8-এর জন্য অসমর্থিত | Node 22+ |
| `npm install` | lockfile drift হতে পারে | `npm ci` |
| প্রতি run-এ `npx cap add android` | native project পুনর্গঠন/পরিবর্তন হারানোর ঝুঁকি | Android project একবার তৈরি করে commit; CI-তে `cap sync android` |
| Manifest-এ `sed` | brittle, duplicate permission হতে পারে | source-controlled Manifest |
| global cleartext `true` | HTTP/MITM ঝুঁকি | production-এ false; দরকারে debug-only network config |
| অকারণে `WAKE_LOCK`/`FOREGROUND_SERVICE` | permission ≠ capability; policy ঝুঁকি | কেবল implementation থাকা feature-এর permission |
| প্রতি run-এ নতুন keystore | পরের release দিয়ে app update অসম্ভব হতে পারে | একই long-lived key restore |
| keystore artifact upload | signing key ছড়িয়ে পড়ে/retention শেষ হয় | artifact হিসেবে দেবেন না; protected secret + offline backup |
| Gradle file append | duplicate `android {}`/signing block হতে পারে | signing config source-controlled, secrets environment/property থেকে |

JDK 17 বর্তমান AGP 8.13 baseline-এর সঙ্গে ব্যবহারযোগ্য; মূল blocker এখানে Node 18। Android Studio-এর bundled JDK দিয়ে local build করাও গ্রহণযোগ্য।

### ৩.৪ `cors-proxy.js`

বর্তমান ভালো দিক:

- hostname allowlist আছে;
- upstream status pass করে;
- SSE response pipe এবং `X-Accel-Buffering: no` দেয়;
- timeout আছে।

কিন্তু production blocker:

1. **Runtime bug:** `proxyReq` `req.on("end")`-এর block-এর ভিতরে `const`, কিন্তু বাইরের `req.on("aborted")` callback সেটি reference করে। Abort হলে `ReferenceError` হতে পারে।
2. `http://` upstream অনুমোদিত—token/API key plaintext MITM-এ যেতে পারে।
3. `localhost` ও `127.0.0.1` allowlist-এ; public deployment হলে সরাসরি SSRF/internal-service access।
4. DNS resolve করা address private/link-local/metadata কিনা যাচাই নেই; allowed hostname/CNAME DNS-rebinding করে private IP-তে যেতে পারে।
5. allowed hostname-এর **যেকোনো port** ব্যবহার করা যায়।
6. client authentication নেই; internet-এর সবাই আপনার proxy/billing key/egress ব্যবহার করতে পারে।
7. rate limit, concurrent stream limit, request-body limit, response-size limit নেই।
8. wildcard CORS origin/header/method/expose—trusted app origin-এর বদলে যেকোনো website ব্যবহার করতে পারে।
9. প্রায় সব client header upstream-এ forward হয়; `cookie`, `authorization`, forwarding headers ইত্যাদির leakage/confusion হতে পারে।
10. generic `/<arbitrary-url>` design provider-specific validation কঠিন করে।
11. upstream error message client-কে raw ফেরত দেয়; internal detail leak হতে পারে।
12. client `close` হলে upstream নিশ্চিতভাবে abort করার robust handling নেই।
13. reverse proxy/CDN buffering ও idle timeout config না মিললে SSE ভেঙে যাবে।
14. server `0.0.0.0`-এ bind করে; local helper হিসেবে চালালেও LAN-এর অন্য host access করতে পারে।

---

## ৪. প্রস্তাবিত architecture

```text
Web UI (React/Vue/vanilla/যে কোনো framework)
        │
        ├── PlatformService interface
        │     ├── NativeAdapter (Capacitor plugins)
        │     └── WebAdapter (browser/PWA fallbacks)
        │
        ├── Device data layer
        │     ├── Preferences: ছোট non-secret setting
        │     ├── SQLite: structured/offline data
        │     ├── Filesystem: app-private files
        │     └── Secure store: token/secret only
        │
        ├── Scheduling layer
        │     ├── Local Notifications: reminders
        │     ├── Native alarm adapter: real alarms
        │     └── Background Runner/WorkManager: best-effort sync
        │
        └── Network layer
              ├── CapacitorHttp: installed app, ordinary non-streaming requests
              ├── File Transfer: large upload/download
              └── Authenticated fixed-route backend proxy: PWA/SSE/server-held secrets
```

একটি generic `PlatformService` রাখলে web UI একই থাকবে:

```ts
export interface PlatformService {
  notifyAt(input: { id: number; at: Date; title: string; body: string }): Promise<void>;
  vibrate(ms?: number): Promise<void>;
  getLocation(): Promise<{ lat: number; lng: number; accuracy: number }>;
  takePhoto(): Promise<{ uri?: string; webPath?: string }>;
  download(input: { url: string; filename: string }): Promise<string>;
}
```

Native/web implementation runtime-এ বাছুন; UI component সরাসরি plugin import না করাই testability-এর জন্য ভালো।

---

## ৫. feature/capability matrix

| Feature | প্রস্তাবিত API/plugin | Android app | iOS app | সাধারণ web/PWA | প্রধান সীমা |
|---|---|---|---|---|---|
| ছোট reminder | `@capacitor/local-notifications` | ভালো | ভালো | আলাদা Web Notifications দরকার | alarm-clock equivalent নয় |
| exact reminder | Local Notifications + exact setting | special access দরকার | OS notification schedule | browser-এ নয় | user revoke করতে পারে |
| পূর্ণ ringing alarm | custom native/Capgo alarm option | alarm/clock use case ও policy | iOS 26+ AlarmKit native bridge | নয় | platform-specific |
| vibration/haptic | `@capacitor/haptics` | foreground call | foreground call | device/browser-dependent | suspend অবস্থায় JS vibrate করবে না |
| local notification | Local Notifications | Android 13 permission | user permission | official native plugin fallback নয় | channel config গুরুত্বপূর্ণ |
| push | `@capacitor/push-notifications` + backend | FCM | APNs/FCM setup | Web Push আলাদা | exact execution guarantee নয় |
| foreground/background state | `@capacitor/app` | হ্যাঁ | হ্যাঁ | visibility event | app foreground-এ জোর করে আনে না |
| ছোট deferred background sync | Background Runner | ≤10 মিনিট; repeat ≥15 মিনিট | আনুমানিক ≤30 sec, schedule অনিশ্চিত | Service Worker সীমা | permanent service নয় |
| screen awake while visible | maintained keep-awake plugin | হ্যাঁ | হ্যাঁ | Wake Lock সীমিত | background execution নয় |
| setting | `@capacitor/preferences` | SharedPreferences | UserDefaults | localStorage | secret রাখবেন না |
| structured data | community SQLite | হ্যাঁ | হ্যাঁ | extra WASM/jeep-sqlite setup | migration/backup design দরকার |
| secret/token | Keychain/Keystore plugin | Keystore | Keychain | secure equivalent নেই | web fallback encrypted নয় |
| current GPS | `@capacitor/geolocation` | হ্যাঁ | হ্যাঁ | browser permission | active/foreground use |
| continuous background GPS | specialized plugin/native FGS | policy + persistent notice | Background Location mode | নয় | official Geolocation সরাসরি দেয় না |
| camera/gallery | `@capacitor/camera` | system activity/photo picker | camera/photo library | file picker/PWA element | Android restored result handle করতে হবে |
| app-private file | `@capacitor/filesystem` | হ্যাঁ | হ্যাঁ | IndexedDB-style fallback | public Downloads নয় |
| large transfer | `@capacitor/file-transfer` | native | native | fetch/blob | bridge-এ বড় payload আনবেন না |
| resilient hours-long download | Android DownloadManager/custom worker | শক্তিশালী | URLSession background custom plugin | browser সীমা | official generic JS call নয় |
| CORS-free ordinary API | `CapacitorHttp` | native bypass | native bypass | browser CORS থাকে | native helper streaming API নয় |
| SSE streaming | own hardened proxy + normal WebView fetch | হ্যাঁ | হ্যাঁ | হ্যাঁ | proxy/CORS/buffering ঠিক করতে হবে |
| external page | Browser/InAppBrowser | isolated | isolated | normal browser | main bridge WebView-তে নয় |

---

## ৬. Alarm: তিন স্তরের implementation

### স্তর A — সাধারণ reminder

`@capacitor/local-notifications` যথেষ্ট। Android 13+ notification permission চাইতে হবে। Android 12+ exact scheduling-এর জন্য exact-alarm special access প্রয়োজন হতে পারে।

```ts
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export async function scheduleReminder(id: number, at: Date) {
  let p = await LocalNotifications.checkPermissions();
  if (p.display === 'prompt' || p.display === 'prompt-with-rationale') {
    p = await LocalNotifications.requestPermissions();
  }
  if (p.display !== 'granted') throw new Error('Notification permission denied');

  if (Capacitor.getPlatform() === 'android') {
    const exact = await LocalNotifications.checkExactNotificationSetting();
    // exact.exact_alarm granted না হলে UI-তে fallback/Settings action দেখান।
    // user rationale-এর পরে changeExactNotificationSetting() দিয়ে Settings খুলতে পারেন।
  }

  await LocalNotifications.schedule({
    notifications: [{
      id,
      title: 'TitanChart reminder',
      body: 'নির্ধারিত কাজের সময় হয়েছে',
      schedule: { at, allowWhileIdle: true },
      channelId: 'reminders',
      extra: { screen: '/reminders', reminderId: id },
    }],
  });
}
```

`allowWhileIdle` অপব্যবহার করবেন না; Doze quota/OS throttling থাকে। Exact access revoke হলে exact schedule মুছে যেতে পারে—app launch/resume-এ setting re-check করে persisted reminder থেকে reschedule/fallback করুন।

### স্তর B — সত্যিকারের Android alarm clock

শুধু Local Notification যথেষ্ট নয় যদি দরকার হয়:

- locked screen-এ prominent/full-screen ringing UI;
- snooze/stop action;
- app process/WebView না থাকলেও দীর্ঘ alarm audio/vibration;
- reboot-এর পরে reschedule;
- timezone/time-change handle;
- alarm state native database-এ স্থায়ী রাখা।

এ ক্ষেত্রে custom Capacitor plugin বা খুব ভালোভাবে audit করা v8-compatible alarm plugin দরকার। Android implementation-এর সম্ভাব্য অংশ:

1. `AlarmManager.setAlarmClock()` বা বৈধ exact alarm;
2. `BroadcastReceiver`;
3. alarm চলার সময় policy-compliant foreground service + persistent notification;
4. alarm category/audio usage;
5. `USE_FULL_SCREEN_INTENT`, কেবল alarm/call use case হলে; Android 14+ `canUseFullScreenIntent()` check;
6. Android 12+ exact-alarm access check;
7. Boot/Time/Timezone change receiver ও reschedule;
8. immutable/update-current `PendingIntent` flags;
9. native `cancel`, `snooze`, `list`, `permissionStatus` API;
10. Play Console-এ FGS/full-screen intent declaration ও সত্যিকারের core alarm justification।

Android 14+ newly installed অধিকাংশ app exact access default-এ পায় না। `USE_EXACT_ALARM` কেবল core alarm/calendar ধরনের সীমিত use case ও Play policy অনুযায়ী; সাধারণ chart/chat app-এ শুধু সুবিধার জন্য ব্যবহার করা উচিত নয়। Full-screen intent-ও alarm/call app-এর জন্য সীমাবদ্ধ। Permission যোগ করলেই policy eligibility তৈরি হয় না।

`@capgo/capacitor-alarm`-এর v8 line একটি সম্ভাব্য maintained option: iOS-এ AlarmKit এবং Android-এ system Alarm Clock intents ব্যবহার করে। কিন্তু Android Clock intent আপনার app-এর custom ringing engine নয়; OEM clock app-এর ওপর নির্ভরশীল, এবং Android-এ list/cancel ক্ষমতা সীমিত। Requirement-এর সঙ্গে মিলিয়ে source/security review করুন।

### স্তর C — iOS alarm

- iOS 26+ এ Apple **AlarmKit** schedule/countdown alarm, Lock Screen/Dynamic Island/StandBy presentation, stop/snooze/custom intent এবং alarm-specific authorization দেয়। Capacitor official alarm plugin নেই; Swift Capacitor bridge বা audited third-party plugin দরকার। `NSAlarmKitUsageDescription` দিতে হবে।
- iOS 15–25 fallback: Local Notifications। এটি AlarmKit-এর সমতুল্য persistent system alarm নয়।
- arbitrary background audio loop, silent-audio hack, বা app-কে নিজে foreground করা গ্রহণযোগ্য architecture নয়।
- device off, battery empty, permission revoked ইত্যাদিতে কোনো app guarantee দিতে পারবে না।

---

## ৭. Vibration ও haptics

```ts
import { Haptics, ImpactStyle } from '@capacitor/haptics';

await Haptics.impact({ style: ImpactStyle.Heavy });
await Haptics.vibrate({ duration: 700 });
```

এটি **বর্তমানে চলমান code** থেকে feedback দেয়। WebView suspend/kill হয়ে গেলে ভবিষ্যতের সময়ে JS timer দিয়ে vibration চালানো যাবে না। Scheduled alert-এ notification channel vibration অথবা native alarm service ব্যবহার করুন। User-এর system haptic setting এবং hardware ফলাফল বদলাতে পারে।

---

## ৮. Local ও Push Notifications

### Local notification checklist

- Android 8+ channel **প্রথমবার** create করার সময় sound/importance ঠিক করুন; পরে একই channel ID-এর sound code দিয়ে বদলালেও user/system পুরোনো channel setting রাখতে পারে। নতুন semantics হলে নতুন channel ID/version ব্যবহার করুন।
- Android 13+ runtime notification permission।
- Android 12+ exact alarm setting শুধু সত্যিই exact হলে।
- iOS presentation options ও user permission।
- notification action click থেকে route/deep link যাচাই; `extra`-কে trusted command হিসেবে অন্ধভাবে ব্যবহার নয়।
- persisted schedule রাখুন, যাতে permission/timezone/reboot event-এ reconcile করা যায়।

### Push notification

`@capacitor/push-notifications` ব্যবহার করুন, কিন্তু backend লাগবে:

- Android: Firebase project, `google-services.json`, FCM token lifecycle।
- iOS: Push Notifications capability, APNs credentials, provisioning, token/backend mapping।
- token refresh হলে server update; logout হলে token association revoke।
- Android 13+ display permission।
- push payload-এ secret নয়; notification data input validate করুন।

Push notification **exact alarm বা guaranteed background job নয়**। Android app killed অবস্থায় data-only custom handling চাইলে native Firebase messaging service লাগতে পারে। iOS silent push delivery discretionary; official Capacitor Push plugin arbitrary silent background execution-এর নিশ্চয়তা দেয় না।

---

## ৯. Foreground/background lifecycle

```ts
import { App } from '@capacitor/app';

App.addListener('appStateChange', async ({ isActive }) => {
  if (isActive) {
    await reconcilePermissionsAndSchedules();
    await refreshVisibleData();
  } else {
    await persistDraftState();
  }
});

App.addListener('appRestoredResult', (result) => {
  if (result.pluginId === 'Camera' && result.success) {
    restorePendingCameraResult(result.data);
  }
});
```

`appStateChange` state জানায়; app-কে background থেকে জোর করে foreground করে না। Android সাধারণত notification → user tap flow চায়। Background activity launch restriction আছে। Qualifying alarm/call ছাড়া full-screen launch ব্যবহার করা যাবে না। iOS-এ arbitrary foregrounding নেই।

### Background Runner কখন ব্যবহার করবেন

ভালো use case:

- ছোট best-effort sync;
- queued metadata flush;
- stale cache refresh;
- short server check এবং প্রয়োজন হলে local notification।

খারাপ use case:

- permanent CORS proxy/server;
- প্রতি ১ মিনিট polling;
- continuous WebSocket/SSE;
- exact alarm;
- continuous background GPS;
- বড়/দীর্ঘ download;
- DOM/UI manipulation।

Config উদাহরণ:

```ts
plugins: {
  BackgroundRunner: {
    label: 'com.titanchart.pro.background.sync',
    src: 'runners/background.js',
    event: 'sync',
    repeat: true,
    interval: 15,
    autoStart: false,
  },
}
```

```js
// www/runners/background.js
addEventListener('sync', async (resolve, reject) => {
  try {
    const response = await fetch('https://api.example.com/v1/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'background' }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    resolve(); // প্রতিটি handler-এ resolve/reject বাধ্যতামূলক
  } catch (error) {
    reject(String(error));
  }
});
```

সীমা: iOS invocation আনুমানিক ৩০ সেকেন্ড এবং সময় নিশ্চিত নয়; Android সর্বোচ্চ প্রায় ১০ মিনিট, repeated work-এর minimum interval ১৫ মিনিট এবং exact নয়। Runner stateless, DOM নেই। Cross-platform কাজ ৩০ সেকেন্ডের মধ্যে শেষ করার লক্ষ্য রাখুন।

### Foreground service

Android 14+ এ service type, matching manifest permission, runtime prerequisite, persistent visible notification এবং Play Console declaration দরকার। Android 12+ background থেকে foreground service শুরু করাও সাধারণত blocked, কিছু documented exemption ছাড়া। শুধু `FOREGROUND_SERVICE` permission inject করলে service তৈরি বা বৈধ হয় না।

---

## ১০. Storage design

| Data | Store | কারণ |
|---|---|---|
| theme, last tab, non-secret flags | Preferences | ছোট key/value |
| chart history, message index, alarm definitions | SQLite | query/transaction/migration |
| image/PDF/model file | Filesystem `Data`/`Cache` | binary/app-private file |
| short-lived cache | Cache | OS মুছতে পারে |
| API access token/device secret | Keychain/Android Keystore plugin | encrypted OS-backed secret |
| server provider master API key | backend secret manager | client app-এ রাখা উচিত নয় |

`Preferences` encryption দেয় না। Community SQLite encryption ব্যবহার করতে চাইলে SQLCipher/native configuration, key storage, export/backup এবং migration আলাদাভাবে design/test করুন; package install করলেই সব database স্বয়ংক্রিয়ভাবে encrypted ধরে নেবেন না।

App-private storage-এর জন্য broad storage permission লাগে না। User-visible export চাইলে Share/Android Storage Access Framework/document picker ব্যবহার করুন। Uninstall-এ app-private data সাধারণত চলে যাবে; backup/sync requirement আলাদা করে ঠিক করুন।

---

## ১১. GPS

Foreground/current location:

```ts
import { Geolocation } from '@capacitor/geolocation';

const permission = await Geolocation.requestPermissions({ permissions: ['location'] });
if (permission.location !== 'granted') throw new Error('Location denied');

const p = await Geolocation.getCurrentPosition({
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 10_000,
});

const result = {
  lat: p.coords.latitude,
  lng: p.coords.longitude,
  accuracy: p.coords.accuracy,
};
```

`watchPosition()` চালু করলে view leave/logout/background policy অনুযায়ী `clearWatch()` করুন; battery cost বেশি। Android 12+ user approximate location দিতে পারে, তাই high accuracy request মানেই fine location guaranteed নয়।

**Official Geolocation plugin সরাসরি background geolocation দেয় না।** Continuous route/tracking দরকার হলে:

- audited specialized plugin বা custom native implementation;
- Android foreground location service, `ACCESS_BACKGROUND_LOCATION` যেখানে প্রযোজ্য, persistent disclosure/notification;
- iOS Background Modes → Location updates এবং Always permission rationale;
- onboarding-এ পরিষ্কার consent, privacy policy, retention/delete control;
- Play/App Store policy-তে core functionality justification।

Chart/app-এর incidental feature হলে continuous background location চাওয়া approval ও user-trust দুটোর জন্য খারাপ।

---

## ১২. Camera

Capacitor 8 representative API:

```ts
import { Camera } from '@capacitor/camera';

const photo = await Camera.takePhoto({
  quality: 85,
  includeMetadata: false,
});

// UI preview-তে photo.webPath; native file operation-এ photo.uri ব্যবহার করুন।
```

Android-এ system camera/photo picker ব্যবহার করলে সাধারণত Camera permission লাগে না; `saveToGallery: true` হলে docs অনুযায়ী পুরোনো Android version-এর scoped `READ/WRITE_EXTERNAL_STORAGE` entries লাগতে পারে (`maxSdkVersion` সহ)। অকারণে broad modern media permission নেবেন না।

iOS `Info.plist`-এ feature অনুযায়ী:

- `NSCameraUsageDescription`
- `NSPhotoLibraryUsageDescription`
- `NSPhotoLibraryAddUsageDescription`

Android external camera Activity চলার সময় low-memory kill হলে `appRestoredResult` থেকে result recover করুন। বড় image base64 করে JS bridge-এ নেওয়ার বদলে URI/file path ব্যবহার করুন; resize/compress এবং EXIF privacy বিবেচনা করুন।

---

## ১৩. Download/upload

App-private controlled download:

```ts
import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem, Directory } from '@capacitor/filesystem';

await Filesystem.mkdir({
  directory: Directory.Data,
  path: 'downloads',
  recursive: true,
});

const file = await Filesystem.getUri({
  directory: Directory.Data,
  path: 'downloads/report.pdf',
});

const progressHandle = await FileTransfer.addListener('progress', p => {
  console.log(p.bytes, p.contentLength);
});

try {
  const result = await FileTransfer.downloadFile({
    url: 'https://api.example.com/report.pdf',
    path: file.uri,
    progress: true,
  });
  console.log(result.path);
} finally {
  await progressHandle.remove();
}
```

নীতি:

- বড় file `CapacitorHttp` response হিসেবে JS bridge-এ আনবেন না; File Transfer ব্যবহার করুন।
- download URL allowlist, HTTPS, filename/path traversal protection, expected MIME/size/checksum যাচাই করুন।
- credentials query string-এ নয়; short-lived signed URL ভালো।
- app visible থাকার সঙ্গে বাঁধা সাধারণ transfer আর reboot/network change সহ hours-long resilient transfer এক নয়। Android-এ পরেরটির জন্য `DownloadManager` বা policy-compliant long-running WorkManager/native plugin ভালো। iOS-এ background `URLSession` custom native bridge লাগতে পারে।
- user-visible Downloads folder-এ সরাসরি broad permission না নিয়ে document picker/SAF/Share flow দিন।

---

## ১৪. HTTP, CORS এবং proxy

### ১৪.১ Installed Capacitor app

`CapacitorHttp` `@capacitor/core`-এর মধ্যেই আছে; আলাদা `@capacitor/http` install করবেন না। Explicit call:

```ts
import { CapacitorHttp } from '@capacitor/core';

const response = await CapacitorHttp.post({
  url: 'https://api.example.com/v1/query',
  headers: { 'content-type': 'application/json' },
  data: { prompt: 'hello' },
  connectTimeout: 15_000,
  readTimeout: 120_000,
  disableRedirects: true,
});
```

Native implementation WebView CORS-এর অধীন নয়। কিন্তু web/PWA fallback browser `fetch` ব্যবহার করে, তাই সেখানে CORS থাকবে। Global `fetch`/XHR patch default-এ off; সব third-party library আচরণ না জেনে এটি globalভাবে on করবেন না। Explicit calls audit করা সহজ।

### ১৪.২ SSE/streaming

Official helper `Promise<HttpResponse>` দেয়; chunk-by-chunk event API প্রকাশ করে না, এবং `EventSource` native patch-এর অংশ নয়। তাই chat/token streaming-এর recommended path:

```text
WebView/PWA normal fetch or EventSource
       → আপনার HTTPS backend (strict CORS + authentication)
       → fixed upstream provider
       → SSE bytes সরাসরি pipe
```

Proxy-তে response compression/buffering বন্ধ, periodic heartbeat, client disconnect propagation, এবং reverse proxy idle timeout ঠিক করতে হবে। Real Android/iOS device-এ screen lock/network switch সহ test করুন।

### ১৪.৩ Generic URL proxy-এর বদলে fixed provider routes

বর্তমান:

```text
POST /https://openrouter.ai/api/v1/chat/completions
```

প্রস্তাবিত:

```text
POST /v1/providers/openrouter/chat/completions
POST /v1/providers/deepinfra/chat/completions
```

Server নিজে fixed base URL/path map করবে। Client arbitrary scheme/host/port দিতে পারবে না। Provider secret server-side inject করুন; client-এর arbitrary `Authorization` সব upstream-এ forward করবেন না।

### ১৪.৪ Hardened proxy বাধ্যতামূলক control

1. কেবল HTTPS upstream এবং port 443; ব্যতিক্রম code-configured।
2. exact host + allowed path prefix + method allowlist।
3. URL username/password এবং malformed encoding reject।
4. DNS resolve করে **সব** A/AAAA address private, loopback, link-local, multicast, reserved, documentation range বা cloud metadata হলে reject।
5. vetted resolved IP request lookup-এ pin করুন; TLS SNI/hostname verification মূল hostname দিয়েই রাখুন।
6. redirect default-এ follow নয়; দরকার হলে প্রতিটি hop পুনরায় validate, hop limit 0–3।
7. authenticated app session/JWT বা deployment অনুযায়ী mTLS; static key app bundle-এ hardcode করে security ধরে নেবেন না।
8. per-user/IP/provider rate limit, concurrency cap, daily quota ও cost guard। Distributed deployment-এ Redis/API gateway।
9. trusted origin allowlist; matched origin echo + `Vary: Origin`; credentialed CORS-এ `*` নয়। Capacitor origins (`https://localhost`, iOS scheme/origin) real-device request দেখে exact configure করুন।
10. request header allowlist: `content-type`, `accept`, provider-specific idempotency header; hop-by-hop, `cookie`, `host`, `forwarded`, `x-forwarded-*`, `proxy-*` strip।
11. response header allowlist: content type, request/rate-limit IDs ইত্যাদি; `set-cookie` forward নয়।
12. request body max (যেমন 1 MiB), JSON schema validation; non-stream response max; stream duration/concurrency cap।
13. connect/header/idle/total timeout আলাদা; client `close`/`aborted` হলে upstream destroy।
14. TLS verification কখনো disable নয়; HTTP cleartext নয়।
15. logs-এ token/body/PII নয়; correlation ID, provider, status, latency, bytes। Generic sanitized error client-কে।
16. host allowlist environment variable দিয়ে production-এ অনিয়ন্ত্রিতভাবে বাড়ানোর বদলে reviewed deployment config।
17. local-only helper হলে `127.0.0.1`-এ bind, random session token, এবং LAN exposure নয়। Public server-এ `localhost`/`127.0.0.1` কখনো allow নয়।
18. `cors-proxy.js`-এর `proxyReq` outer scope-এ declare করলেও শুধু bug ঠিক হবে; উপরের security design ছাড়া public deployment নিরাপদ হবে না।

OWASP SSRF guidance অনুযায়ী “hostname allowlist আছে” একা যথেষ্ট নয়—redirect, DNS এবং resolved IP-ও validate করতে হবে।

---

## ১৫. Capacitor 8 dependency baseline

১৬ আগস্ট ২০২৬-এ npm `latest` থেকে যাচাই করা version:

```json
{
  "dependencies": {
    "@capacitor/core": "8.5.0",
    "@capacitor/android": "8.5.0",
    "@capacitor/ios": "8.5.0",
    "@capacitor/app": "8.1.1",
    "@capacitor/camera": "8.2.2",
    "@capacitor/geolocation": "8.2.2",
    "@capacitor/haptics": "8.0.2",
    "@capacitor/local-notifications": "8.3.0",
    "@capacitor/preferences": "8.0.1",
    "@capacitor/filesystem": "8.1.2",
    "@capacitor/file-transfer": "2.0.5",
    "@capacitor/push-notifications": "8.1.2",
    "@capacitor/splash-screen": "8.0.2",
    "@capacitor/share": "8.0.1",
    "@capacitor/browser": "8.0.4",
    "@capacitor/inappbrowser": "4.0.2",
    "@capacitor/background-runner": "3.0.0",
    "@capacitor-community/sqlite": "8.1.1"
  },
  "devDependencies": {
    "@capacitor/cli": "8.5.0"
  }
}
```

Plugin package-এর major সবসময় Capacitor core-এর major অনুসরণ করে না—যেমন File Transfer 2.x, InAppBrowser 4.x, Background Runner 3.x। তাই “সবকিছুকে 8.0.0” করবেন না; npm compatible release ও plugin changelog দেখুন। Exact install + committed `package-lock.json` ব্যবহার করুন। iOS target না থাকলে `@capacitor/ios` এখন বাদ রাখা যায়। Optional alarm/secure-store/keep-awake plugin source audit করে আলাদা যোগ করুন।

Suggested command pattern:

```bash
npm uninstall cordova-plugin-background-mode
npm install --save-exact @capacitor/core@8.5.0 @capacitor/android@8.5.0
npm install --save-dev --save-exact @capacitor/cli@8.5.0
# এরপর উপরের দরকারি official plugins exact compatible version-এ install
npm install
npx cap sync
```

---

## ১৬. নিরাপদ `capacitor.config.ts` baseline

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.titanchart.pro',
  appName: 'TitanChartPro',
  webDir: 'www',
  loggingBehavior: 'debug', // release-এ native logs suppress; sensitive console log করবেন না
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    webContentsDebuggingEnabled: false,
  },
  // Production-এ server.url/allowNavigation নেই।
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: true,
      backgroundColor: '#10141C',
      showSpinner: false,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_notification',
      iconColor: '#10141C',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
    CapacitorHttp: {
      enabled: false, // explicit CapacitorHttp calls; global fetch/XHR patch নয়
    },
  },
};

export default config;
```

`ios.webContentsDebuggingEnabled` আপনার exact v8 config typing-এ verify করুন; build error হলে শুধু ওই explicit line সরান—release scheme-এর native setting দিয়েও এটি off রাখা যায়। External links:

```ts
import { Browser } from '@capacitor/browser';
await Browser.open({ url: 'https://trusted.example/help' });
```

CSP উদাহরণটি app-এর বাস্তব endpoint অনুযায়ী সংকুচিত করুন:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; base-uri 'none'; object-src 'none';
           img-src 'self' data: blob: capacitor:;
           style-src 'self' 'unsafe-inline';
           script-src 'self';
           connect-src 'self' https://api.yourdomain.example;">
```

Framework inline/eval requirement থাকলে nonce/hash/build configuration দিয়ে সমাধান করুন; production-এ `unsafe-eval` এড়ান।

---

## ১৭. Permission/manifest পরিকল্পনা

### Android: feature অনুযায়ী কেবল দরকারি permission

| Permission/capability | কখন |
|---|---|
| `INTERNET` | remote API; সাধারণত template/plugin merge-এ থাকে |
| `POST_NOTIFICATIONS` | Android 13+ local/push display; runtime prompt |
| `VIBRATE` | notification/alarm vibration; plugin merge যাচাই |
| `ACCESS_COARSE_LOCATION` | approximate location |
| `ACCESS_FINE_LOCATION` | feature সত্যিই precise হলে |
| `SCHEDULE_EXACT_ALARM` | user-facing exact alarm/reminder; special settings |
| `USE_EXACT_ALARM` | কেবল qualifying core alarm/calendar app |
| `USE_FULL_SCREEN_INTENT` | কেবল qualifying alarm/call |
| `FOREGROUND_SERVICE` + type permission | বাস্তব declared native service থাকলে |
| `ACCESS_BACKGROUND_LOCATION` | continuous background location এবং policy justification হলে |
| `RECEIVE_BOOT_COMPLETED` | native alarm reschedule implementation হলে |
| old `READ/WRITE_EXTERNAL_STORAGE` with max SDK | Camera `saveToGallery`/legacy specific need হলে |

Permission prompt startup-এ একসঙ্গে নয়; user feature ব্যবহার করার ঠিক আগে rationale দিয়ে চাইুন। Denied ও “don’t ask again” state-এ Settings link/fallback দিন। App resume-এ exact alarm/full-screen/location/notification state reconcile করুন।

### iOS

Feature অনুযায়ী Info.plist/capability:

- Camera/photo usage strings;
- `NSLocationWhenInUseUsageDescription`;
- background location সত্যিই থাকলে Always-related descriptions + Background Modes;
- iOS 26+ AlarmKit হলে `NSAlarmKitUsageDescription`;
- Push Notifications capability + APNs provisioning;
- Background Runner হলে Background Fetch/Processing এবং permitted task identifier;
- countdown Live Activity/AlarmKit হলে সংশ্লিষ্ট target/capability।

Usage string generic “app needs permission” নয়; user benefit ও actual use পরিষ্কার বলুন।

---

## ১৮. স্থিতিশীল Android signing workflow

### Signing model

- প্রথম production release-এর আগে একটি key একবার তৈরি করুন।
- Google Play App Signing enable করলে Google app-signing key রক্ষা করবে; CI-তে আপনার long-lived **upload key** থাকবে।
- base64 keystore, alias, store password, key password protected GitHub Environment secrets-এ রাখুন।
- offline encrypted backup এবং recovery documentation রাখুন। GitHub artifact-ই একমাত্র backup নয়।
- CI logs/artifacts-এ keystore দেবেন না।

### GitHub Actions baseline

Native `android/` project এবং Gradle signing block repository-তে commit থাকবে। Release block environment/property না থাকলে fail করবে। Workflow:

```yaml
name: Android Release

on:
  workflow_dispatch:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
          cache: gradle

      - name: Install locked dependencies
        run: npm ci

      - name: Build web assets
        run: npm run build

      - name: Sync committed Android project
        run: npx cap sync android

      - name: Restore upload keystore
        shell: bash
        env:
          KEYSTORE_B64: ${{ secrets.ANDROID_KEYSTORE_B64 }}
        run: |
          test -n "$KEYSTORE_B64"
          printf '%s' "$KEYSTORE_B64" | base64 --decode > android/app/release.keystore

      - name: Build signed APK and AAB
        working-directory: android
        env:
          SIGNING_STORE_PASSWORD: ${{ secrets.SIGNING_STORE_PASSWORD }}
          SIGNING_KEY_ALIAS: ${{ secrets.SIGNING_KEY_ALIAS }}
          SIGNING_KEY_PASSWORD: ${{ secrets.SIGNING_KEY_PASSWORD }}
        run: ./gradlew --no-daemon assembleRelease bundleRelease

      - uses: actions/upload-artifact@v4
        with:
          name: titan-chart-release
          if-no-files-found: error
          path: |
            android/app/build/outputs/apk/release/app-release.apk
            android/app/build/outputs/bundle/release/app-release.aab

      - name: Remove temporary key
        if: always()
        run: rm -f android/app/release.keystore
```

Gradle signing config source-controlled হবে, secret নয়:

```groovy
android {
    signingConfigs {
        release {
            def storePass = System.getenv("SIGNING_STORE_PASSWORD")
            def keyAliasValue = System.getenv("SIGNING_KEY_ALIAS")
            def keyPass = System.getenv("SIGNING_KEY_PASSWORD")
            if (!storePass || !keyAliasValue || !keyPass) {
                throw new GradleException("Release signing secrets are missing")
            }
            storeFile file("release.keystore")
            storePassword storePass
            keyAlias keyAliasValue
            keyPassword keyPass
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

`build.gradle` যদি Kotlin DSL বা template-এ একই block আগে থেকেই থাকে, duplicate block যোগ না করে বর্তমান block edit করুন। Workflow-এর আগে `npm run build` সত্যিই `www/index.html` তৈরি করছে কি না fail-fast check দিন।

---

## ১৯. v5 → v8 migration plan

### Phase 0 — release identity ও rollback

1. বর্তমানে Play Store-এ app থাকলে ব্যবহৃত signing key/Play App Signing status **আগে** নিশ্চিত করুন।
2. repository tag/backup; current APK/AAB ও mapping file সংরক্ষণ।
3. real-device smoke test list লিখুন।
4. `package-lock.json` commit।

### Phase 1 — v5 cleanup

1. `cordova-plugin-background-mode`-নির্ভর logic inventory; feature flag দিয়ে বন্ধ করুন।
2. generic platform adapter তৈরি করুন।
3. current permissions source-controlled Manifest/Info.plist-এ আনুন।
4. broad `allowNavigation` ও cleartext dependency খুঁজুন।
5. CI-তে new keystore generation বন্ধ করুন।

### Phase 2 — major-by-major upgrade

একটি branch-এ v5→v6, test; তারপর v6→v7, test; তারপর Node 22/Xcode 26/Android Studio baseline-এ v7→v8। প্রতিটি major-এর official migration guide ও `npx cap migrate`/manual diff ব্যবহার করুন। Third-party plugin প্রতিটি ধাপে compatible কিনা যাচাই করুন।

যেহেতু বর্তমান CI প্রতি run-এ Android project generate করে, v8 project **একবার local/controlled environment-এ** তৈরি করে native customizations port করুন, তারপর `android/` commit করুন। পরবর্তী CI-তে `cap add` নয়।

Capacitor 8 baseline:

- Node 22+;
- Android Studio 2025.2.1+;
- min Android API 24;
- compile/target API 36;
- AGP 8.13 migration baseline;
- Xcode 26+;
- iOS minimum 15;
- নতুন iOS project default-এ Swift Package Manager।

### Phase 3 — feature delivery order

1. App lifecycle + Preferences + Haptics;
2. Local Notifications/channel/permission;
3. Camera + restored result;
4. foreground Geolocation;
5. Filesystem/File Transfer;
6. CapacitorHttp ordinary calls;
7. authenticated hardened proxy + SSE;
8. Push notifications;
9. Background Runner only measured short jobs;
10. real alarm native adapter;
11. background location কেবল approved business requirement থাকলে।

### Phase 4 — hardening ও store review

- CSP/navigation/network security audit;
- permission minimization;
- Play Data Safety/App Privacy disclosures;
- alarm/full-screen/FGS eligibility declaration;
- deletion/export/retention policy;
- dependency/SBOM/vulnerability scan;
- release signing verification: `apksigner verify --print-certs`;
- staged rollout এবং crash/ANR monitoring।

---

## ২০. Test matrix

কমপক্ষে পরীক্ষা করুন:

- Android 7/API 24 minimum, Android 13 notification permission, Android 14 exact/full-screen behavior, Android 15/16 recent devices;
- Pixel + Samsung/Xiaomi/Realme-এর battery-management variation;
- iOS 15 fallback, iOS 26+ AlarmKit path;
- app foreground/background/force-stop/reboot;
- timezone ও manual clock change;
- permission grant/deny/revoke while app open;
- exact alarm setting revoke এবং schedule reconciliation;
- notification channel created before/after upgrade;
- camera থেকে ফিরে low-memory process restoration;
- GPS disabled, approximate-only, no network/GPS timeout;
- download network loss/resume/disk full/path collision;
- SSE proxy client disconnect, upstream timeout, 429, 5xx, malformed chunk;
- SSRF: localhost, `169.254.169.254`, IPv6 loopback, CNAME→private IP, non-443 port, redirect→private host;
- proxy auth/rate limit/concurrent stream quota;
- release build-এ WebView debugging/cleartext/log secret disabled;
- same signing certificate across releases।

---

## ২১. বাস্তব platform limitation—যেগুলো UI copy-তেও সৎভাবে জানাতে হবে

- Mobile OS arbitrary permanent background JavaScript guarantee করে না।
- Background Runner exact interval নয়।
- app নিজে সাধারণভাবে foreground-এ উঠে আসতে পারে না।
- keep-awake plugin শুধু visible app-এ screen sleep আটকায়; background execution নয়।
- push ও ordinary local notification alarm-clock reliability-এর সমান নয়।
- background GPS battery-intensive এবং policy-controlled।
- browser/PWA CORS bypass করতে পারে না।
- Capacitor app Node.js server চালায় না; `cors-proxy.js` external service/companion process হতে হবে।
- permission denied, device powered off, battery empty, force-stop/OEM restrictions-এর মধ্যে absolute guarantee নেই।

---

## ২২. Prioritized action list

### P0 — release/security blocker

- stable existing signing identity উদ্ধার/নির্ধারণ;
- new keystore-per-build বন্ধ;
- public proxy as-is deploy না করা;
- `localhost`/HTTP/wildcard CORS/generic URL forwarding বাদ;
- broad `allowNavigation` এবং global cleartext বাদ;
- Node 22 + deterministic build।

### P1 — migration foundation

- v5→v8 staged migration;
- committed native projects;
- `cordova-plugin-background-mode` অপসারণ;
- PlatformService adapter ও permission service।

### P2 — standard features

- App, Haptics, Preferences/SQLite;
- Local/Push notifications;
- Camera/restoration;
- foreground GPS;
- Filesystem/File Transfer;
- CapacitorHttp।

### P3 — advanced/policy-sensitive

- hardened SSE proxy;
- Android real-alarm custom plugin/qualified third-party option;
- iOS 26+ AlarmKit bridge + fallback;
- background location/FGS শুধু business requirement ও store-policy approval থাকলে।

---

## ২৩. প্রধান গবেষণা উৎস

1. [Capacitor v8 environment/support requirements](https://capacitorjs.com/docs/getting-started/environment-setup)  
2. [Updating to Capacitor 8](https://capacitorjs.com/docs/updating/8-0)  
3. [Capacitor configuration](https://capacitorjs.com/docs/config)  
4. [App lifecycle/restored result](https://capacitorjs.com/docs/apis/app)  
5. [Camera](https://capacitorjs.com/docs/apis/camera)  
6. [Geolocation](https://capacitorjs.com/docs/apis/geolocation)  
7. [Local Notifications](https://capacitorjs.com/docs/apis/local-notifications)  
8. [Push Notifications](https://capacitorjs.com/docs/apis/push-notifications)  
9. [Background Runner](https://capacitorjs.com/docs/apis/background-runner)  
10. [CapacitorHttp](https://capacitorjs.com/docs/apis/http)  
11. [File Transfer](https://capacitorjs.com/docs/apis/file-transfer)  
12. [Preferences](https://capacitorjs.com/docs/apis/preferences)  
13. [Android exact alarms](https://developer.android.com/develop/background-work/services/alarms)  
14. [Android 14 foreground-service types](https://developer.android.com/about/versions/14/changes/fgs-types-required)  
15. [Android background activity-start restrictions](https://developer.android.com/guide/components/activities/background-starts)  
16. [Android 14 full-screen intent restriction](https://developer.android.com/about/versions/14/behavior-changes-14)  
17. [Android DownloadManager](https://developer.android.com/reference/android/app/DownloadManager)  
18. [Apple WWDC25 AlarmKit](https://developer.apple.com/videos/play/wwdc2025/230/)  
19. [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)  
20. [Capacitor security guide](https://capacitorjs.com/docs/guides/security)

---

## Final recommendation

প্রথম release-এ “সব feature একসঙ্গে” না করে **standard Capacitor features + secure network + stable signing** আগে শেষ করুন। Alarm-clock engine, continuous background GPS এবং long-running foreground service আলাদা native workstream হিসেবে নিন—কারণ এগুলো JavaScript plugin install-এর চেয়ে বেশি policy, lifecycle এবং reliability engineering চায়। এই architecture-এ web UI অপরিবর্তিত থাকবে, কিন্তু device-sensitive কাজগুলো স্পষ্ট native adapter-এর মাধ্যমে চলবে; ফলে browser/PWA fallback, testing এবং ভবিষ্যৎ Capacitor upgrade অনেক নিরাপদ হবে।

---

## ২৪. Requirement update — GitHub-only build, local bundle, no own backend

পরবর্তী স্পষ্টীকরণ অনুযায়ী target হলো Android + iOS, সম্পূর্ণ GitHub Actions build, bundled local web UI, এবং নিজস্ব backend/hosted `server.url` ছাড়া কাজ করা। এই mode-এ:

- `server.url`, `allowNavigation`, cleartext ও remote UI থাকবে না;
- `webDir`-এর compiled assets APK/IPA-র ভেতরে copy হবে;
- Android app-এর local origin হবে default `https://localhost` এবং iOS-এ default `capacitor://localhost`;
- normal REST/JSON request native-এ `CapacitorHttp` দিয়ে যাবে, তাই WebView CORS প্রযোজ্য হবে না;
- incremental SSE/token streaming দরকার হলে backend-এর বদলে Android OkHttp এবং iOS URLSession-ভিত্তিক custom Capacitor streaming plugin লাগবে;
- direct third-party request-এর API secret app binary থেকে গোপন রাখা যায় না—user-supplied token Keychain/Keystore-এ রাখা যেতে পারে, কিন্তু server-owned secret নিরাপদ রাখা সম্ভব নয়।

### Service Worker-এর বদলে native-equivalent design

একটি bundled Capacitor app `file://` থেকে সরাসরি page খোলে না; তাই raw local HTML-এর `Origin: null` সমস্যা Capacitor local origin দিয়ে দূর হয়। কিন্তু একই Service Worker-কে Android ও iOS installed app-এর architecture হিসেবে নির্ভরযোগ্যভাবে ব্যবহার করা যাবে না: iOS local assets `capacitor://` custom scheme-এ হওয়ায় HTTP/HTTPS-only Service Worker registration চলে না। Android WebView-তে সম্ভাব্য support থাকলেও background execution বা CORS bypass-এর guarantee হিসেবে এটি ব্যবহার করা ঠিক নয়।

Functional replacement:

| Service Worker উদ্দেশ্য | Native app implementation |
|---|---|
| app-shell offline cache | bundle-এর মধ্যেই UI/assets; অতিরিক্ত cache দরকার নেই |
| API/data cache | SQLite, Filesystem বা Preferences |
| CORS bypass | `CapacitorHttp`; streaming হলে custom native HTTP plugin |
| background sync | Background Runner/WorkManager/BGTask-এর best-effort native scheduling |
| push | Capacitor Push Notifications + FCM/APNs |
| scheduled reminder | Local Notifications/native alarm path |

Browser/PWA build-এর ক্ষেত্রে Service Worker চলতে HTTP `localhost` বা production HTTPS origin লাগবেই। `file://` থেকে খোলা static HTML-এ Service Worker চলে না, এবং Service Worker third-party server-এর CORS policy bypass করতে পারে না। সুতরাং “কোনো URL নয় + browser/PWA Service Worker + arbitrary CORS bypass”—এই তিনটি একসঙ্গে সম্ভব নয়। Service Worker code রাখা যেতে পারে, কিন্তু শুধু `Capacitor.getPlatform() === 'web'` হলে register করতে হবে; কোনো web URL deploy না করলে সেটি production-এ ব্যবহৃত হবে না।

### GitHub Actions build split

- Android: Ubuntu runner, Node 22, JDK 17, API 36, committed `android/`, stable signing keystore secrets, signed APK+AAB artifact।
- iOS: `macos-26`, Xcode 26, committed `ios/`, Apple certificate/provisioning/App Store Connect credentials, signed IPA artifact।
- Installable iOS IPA/Store build-এর জন্য Apple Developer signing বাধ্যতামূলক; GitHub Actions এটি bypass করতে পারে না।
- দুই job-এই `npm ci → npm run build → npx cap sync <platform> → native build` হবে।
