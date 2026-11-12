# Policy, security ও বাস্তব সীমাবদ্ধতা

এই shell native capability দেয়; এটি OS permission, store policy, browser security, third-party server policy বা user consent bypass করে না। Production release-এর আগে app-এর প্রকৃত use case অনুযায়ী legal/privacy/security review করুন।

## ১. Trust boundary

`www/`-এর JavaScript camera, precise location, secure storage, filesystem, native network, alarms প্রভৃতি শক্তিশালী API call করতে পারে। তাই:

- শুধু নিজের/বিশ্বস্ত/audited source বা static output bundle করুন
- downloaded remote script, tag manager, arbitrary user HTML/JS, `eval`, unsafe plugin system NativeKit access পেলে সেটি native privilege পেতে পারে
- UI remote host থেকে চালাতে production `server.url` ব্যবহার করবেন না
- `security.trustedLocalContentOnly` বাধ্যতামূলক true
- dependency lockfile review এবং CI security update process রাখুন
- app-specific least privilege: অপ্রয়োজনীয় feature/permission false

Façade immutable হওয়া accidental replacement কমায়; compromised page/XSS-কে থামায় না। CSP কঠোর করুন, user content escape/sanitize করুন, secrets DOM/localStorage/log-এ রাখবেন না।

### Third-party App Browser boundary

Uploaded HTML/CSS/JS কখনো trusted `www/` DOM-এ inject বা parent-এর আসল NativeKit-এ attach হয় না। Native path private staged package, per-app virtual origin/profile, Android separate app process + authenticated bounded IPC এবং iOS isolated controller/watchdog ব্যবহার করে। Installed façade hard-coded method allowlist, native-held app/session identity, app/capability/method policy, rate/payload quota এবং bounded metadata audit-এ সীমিত; raw Capacitor plugin নেই। নতুন facade (যেমন v1.4.x-এর `nearby`) capability enum ও method allowlist-এ স্পষ্টভাবে যোগ না করা পর্যন্ত installed tier থেকে অ্যাক্সেসযোগ্য নয় — বর্তমানে `nearby` **trusted-only**; মিনি-অ্যাপের কাছে এক্সপোজ করা মানে আলাদা security review। Permitted fallback-এ `sandbox="allow-scripts"` opaque-origin iframe চলে এবং maximum process isolation থাকে না।

প্রতি RPC invocation native side effect-এর আগে device-local IndexedDB-তে `OUTCOME_PENDING` হিসেবে commit হয়; audit store unavailable হলে operation fail-closed। Final outcome update ব্যর্থ হলে pending record থাকে। Log raw argument/result/secret রাখে না এবং tamper-proof remote log নয়।

Durable policy `ask|allow|block`। App disable ও capability `block` absolute; capability block stale method allow bypass করতে পারে না। Effective `ask` call trusted UI-র `allow_once|allow_always|block_once|block_always` পর্যন্ত অপেক্ষা করে। Stored allow/block পরের call automatic settle করে; global feature gate, method allowlist, ownership/quota/host rule ও OS permission bypass হয় না।

Per-app network mode তিন স্তরে (owner policy-এ ঘোরানো যায়, refactor v1.2.0, **v1.2.1-এ ডিফল্ট `full`** — owner rule "default always allow": নতুন/অজানা app খোলা ইন্টারনেটেই চলে, অনুমতির দরকার নেই; নির্দিষ্ট করে আটকানোর মোড): `sandboxed` আগের মতোই সব remote traffic বন্ধ; `hosts` শুধু approved host whitelist; `full` owner-এর স্পষ্ট অনুমতিতে সম্পূর্ণ HTTPS/WSS ইন্টারনেট ও ফর্ম-পোস্ট খুলে দেয়—এক্ষেত্রে UI warning দেখায় যে granted native capability-এর data বাইরে যেতে পারে। Running session-এ launch-কালীন mode-ই প্রযোজ্য; mode বদলালে session restart হয়। Brokered http/transfer call policy/audit দিয়েই যায়; direct renderer request-ও per-app হিসেবে গণনা হয় (`appBrowser.networkStats`) — request counter ও top host audit panel/metadata-এ দেখা যায়, তবে payload-এর বিষয়বস্তু গোপন থাকে। উপরে-নিচের system bar এখন **ব্লেন্ড (transparent)** — page-এর নিজের রঙই বারের নিচে জায়গায় ঘষে যায় (উপরের স্ট্রিপ page-এর উপরের রঙ, নিচেরটা নিচের রঙ); প্রতি mini-app manifest-এ `colorScheme: "dark"|"light"` ঘোষণা দিলে সেই অনুযায়ী আইকন contrast adjust হয় (ডিফল্ট dark = হালকা আইকন)। Media autoplay আলাদা owner flag (`mediaAutoplay`); download network mode মেনে app-private storage-এ যায় (Android)। Process/profile isolation, package integrity, token bridge, raw-plugin নিষেধ এবং mixed-content block সব network mode-এ অপরিবর্তিত।

Session close, disable/revoke, package update/remove, renderer failure এবং approval timeout pending calls reject করে। Session/subscription এবং ownership অনুযায়ী background location/scheduled notification/alarm release করার চেষ্টা হয়। Remove native active state-এর পাশাপাশি owned Preferences, secure storage, SQLite, filesystem, staged package এবং installed profile delete করে; independent cleanup failure aggregate হয় এবং retry-এর জন্য app disabled/metadata retained থাকে। Global feature disabled থাকলে corresponding cleanup facade skip হতে পারে—config toggle-এর আগের persisted state review করুন।

এই boundary সব risk মুছে না: WebView/browser/plugin vulnerability, granted high-risk global OS state, social engineering এবং shared WebView main-thread resource exhaustion বিবেচনা করতে হবে। বিস্তারিত API, quota ও lifecycle: [`API-REFERENCE.bn.md`](./API-REFERENCE.bn.md)।

### Remote URL boundary

Remote HTTPS URL installed mini app নয়। Trusted host-এর `appBrowser.openUrl()` dedicated browser-only controller খোলে; remote document কোনো `window.NativeKit`, transport, injected bootstrap/script handler, native permission card বা broker audit পায় না। URL credential-বিহীন HTTPS এবং configured navigation boundary-র মধ্যে থাকতে হয়। Android supported WebView-এ stable dedicated remote named profile, iOS 17+-এ named persistent data store, আর iOS 15–16-এ platform সীমার কারণে default persistent store ব্যবহৃত হয়। Remote profile session close/app-package removal-এ ইচ্ছাকৃতভাবে retained; তাই remote browsing cookie/storage usable থাকে, কিন্তু iOS 15–16-এ full default-store partition promise নেই।

## ২. Local bundle বনাম hosted web

Installed Android/iOS app:

- UI local staged bundle থেকে চলে
- offline app shell-এর জন্য Service Worker দরকার নেই
- native equivalents background/network/file/notification কাজ করে
- production `server.url` নেই

Separately hosted web/PWA target:

- HTTPS/localhost origin-এ generated Service Worker optional
- static same-origin app files pre-cache
- content hash cache revision stale content কমায়
- OS native APIs অনুপস্থিত হলে web fallback সীমিত

`file://` reliable Service Worker origin নয়। Capacitor iOS bundled origin `capacitor://localhost`; fake HTTPS/remote URL দিয়ে SW force করা unsupported design।

## ৩. CORS ও networking

Native HTTP/SSE/file transfer browser CORS preflight এড়িয়ে native transport নিতে পারে, কিন্তু universal proxy/bypass নয়। এটি নিশ্চয়তা দেয় না যে:

- DNS/Internet/host available
- server request accept করবে
- TLS certificate/hostname valid
- mTLS, VPN, captive portal বা enterprise policy compatible
- token/cookie/CSRF/session valid
- rate limit, WAF, Cloudflare/anti-bot pass
- IP/geofence restriction pass
- OAuth provider embedded WebView অনুমতি দেবে
- iframe `X-Frame-Options`/CSP `frame-ancestors` bypass হবে
- WebSocket বা browser `EventSource` native patch হবে

Patched fetch/XHR সুবিধাজনক, কিন্তু explicit `NativeKit.http` বেশি স্পষ্ট। Web/PWA-তে third-party server CORS header না দিলে এবং নিজের backend/proxy না থাকলে browser request অসম্ভব হতে পারে। Service Worker CORS bypass করতে পারে না।

শুধু HTTPS ব্যবহার করুন। `allowCleartext=true` দিলে transport exposure ও store/security risk বাড়ে; production-এ false রাখুন। Public-key pinning এই template-এ নেই; যোগ করলে certificate rotation strategy অপরিহার্য।

## ৪. Authentication ও secrets

- OAuth/OIDC-এর system browser/ASWebAuthenticationSession/Custom Tabs + PKCE ব্যবহার করুন যেখানে provider embedded login নিষিদ্ধ করে
- client app-এ API private key/client secret স্থায়ীভাবে গোপন রাখা যায় না
- short-lived token, revocation/rotation, secure storage এবং server-side authorization ব্যবহার করুন
- secure storage encrypted at rest হলেও running compromised app/XSS-accessible value safe নয়
- certificate/private signing key কখনো app bundle বা repository-তে দেবেন না
- request/response/token/precise location logs production-এ redact করুন

## ৫. Android exact alarm

Exact alarms battery-sensitive এবং Android policy-controlled।

- `SCHEDULE_EXACT_ALARM`: user-granted special access; app access status check/request করবে
- `USE_EXACT_ALARM`: restricted permission; কেবল সত্যিকারের core alarm/timer/calendar ধরনের eligible app
- access না থাকলে implementation inexact fallback report করতে পারে
- exact মানেও device shutdown, OEM behavior বা app state-এর বাইরে absolute guarantee নয়
- reboot restoration persisted future alarms-এর best effort

App-এ user-facing reason, schedule/cancel UI, current access status এবং graceful fallback দেখান। Exactness convenience/background sync-এর জন্য ব্যবহার করবেন না।

## ৬. Android full-screen intent

Full-screen alarm screen intrusive এবং policy-sensitive। Modern Android/Google Play eligibility সাধারণত alarm/calling core use case-এ সীমিত।

- `fullScreenAlarm=true` ও manifest permission capability request করে; entitlement নিশ্চিত করে না
- `requestFullScreenAccess()` status/settings flow; user/OS deny করতে পারে
- সাধারণ notification যথেষ্ট হলে full screen ব্যবহার করবেন না
- locked/unlocked, Do Not Disturb, notification channel/user setting, OEM behavior পরীক্ষা করুন
- misleading call/alarm behavior review rejection বা permission revocation ঘটাতে পারে

## ৭. iOS AlarmKit ও fallback

- AlarmKit iOS/iPadOS 26+ এবং user authorization-dependent
- `NSAlarmKitUsageDescription` সত্য, app-specific হতে হবে
- current adapter fixed-date AlarmKit schedule support করে
- older OS, disabled feature বা denied/unavailable AlarmKit-এ Local Notifications fallback
- fallback AlarmKit-এর সব system alarm behavior/guarantee সমতুল্য নয়
- recurrence current design-এ Local Notifications fallback path ব্যবহার করে

Do Not Disturb/silent/focus behavior, authorization denial এবং app reinstall/update পরীক্ষা করুন। Critical Alerts এই template-এ নেই; Apple entitlement ছাড়া দাবি করবেন না।

## ৮. Background runner

Background execution OS-scheduled, exact cron নয়।

- interval minimum request মাত্র; iOS/Android defer, batch, skip বা terminate করতে পারে
- force-quit, battery saver, Low Power Mode, background restriction প্রভাব ফেলতে পারে
- runner দ্রুত, bounded, idempotent এবং retry-safe করুন
- long-running stream/upload/download runner-এ শুরু করে completion guarantee ধরে নেবেন না
- sync checkpoint isolated `CapacitorKV`-তে রাখুন; main Preferences-এর সঙ্গে এক store ভাববেন না
- owned backend আবশ্যক নয়; `defaultSyncUrl` blank বৈধ

Guaranteed time-sensitive behavior-এর জন্য user-visible notification/alarm বা platform-appropriate server push design প্রয়োজন হতে পারে।

## ৯. Background location

Background GPS privacy-, battery- এবং store-review-sensitive। Enable করার আগে:

- feature core value কিনা যাচাই
- Android foreground service + persistent notification ও proper service type
- background location runtime permission stagedভাবে request
- iOS Always authorization/background mode এবং accurate purpose text
- prominent in-app disclosure before OS prompt
- explicit start/stop/current-state UI
- retention duration, deletion/export, server transmission, encryption documented
- minimum practical sampling frequency/distance

Implementation OS termination/OEM restriction অতিক্রম করতে পারে না। `maxBuffer` bounded; app না খুললে পুরোনো/overflow point হারাতে পারে। User location permission revoke করলে gracefully stop/error report করুন।

## ১০. Notifications ও push

- permission prompt context ছাড়া startup-এ দেখাবেন না
- Android notification channels once created হলে user-controlled; ID/importance migration পরিকল্পনা করুন
- scheduled local notification device clock/time-zone changes বিবেচনা করুন
- push plugin থাকা মানে delivery ready নয়
- Android Firebase config/provider এবং iOS APNs entitlement/profile/provider পরে যোগ করতে হবে
- device token rotate হতে পারে; user/account mapping update/remove করুন
- notification payload-এ unnecessary sensitive data দেবেন না

## ১১. Camera, photos, files ও sharing

- purpose string ও permission only when needed
- image metadata (EXIF/GPS) privacy review করুন
- large base64 memory pressure এড়াতে URI/file path ব্যবহার করুন
- user-selected/untrusted files-এর type, size ও content validate
- filesystem sandbox path arbitrary OS path নয়
- `External`/`ExternalStorage` platform/API-dependent
- download checksum/expected MIME/size verify করুন যেখানে integrity গুরুত্বপূর্ণ
- Share sheet খুললে final recipient/user action app control করে না

## ১২. SQLite ও data lifecycle

- SQL values parameterize; concatenated user input injection তৈরি করে
- schema migration/versioning/backups design app-এর দায়িত্ব
- SQLite encryption automatically configured নয়
- logout/account switch/uninstall/backup behavior পরীক্ষা
- Preferences low-sensitivity small values-এর জন্য; secret Secure Storage-এ
- privacy deletion request secure storage, DB, files, queued upload, notification/alarm সব cover করবে

## ১৩. WebView navigation ও CSP

`allowNavigation` remote host-কে top-level WebView navigation allow করতে পারে; এটি API allowlist নয়। Remote page same bridge context পেলে risk বাড়তে পারে। Default খালি রাখুন এবং external links system browser-এ খোলা উত্তম।

App Browser-এর installed Android/iOS path custom native navigation guard দিয়ে exact local Capacitor origin এবং initial `about:srcdoc` ছাড়া document navigation reject করে। `navigate-to` CSP directive browser-এ implemented নয়; security এর ওপর নির্ভর করে না। Android navigation callback frame metadata না দেওয়ায় guard subframe navigation-কেও block করতে পারে। Separately hosted browser preview-তে native interceptor নেই: load-এর পরে session stop হলেও outbound navigation request আগে শুরু হতে পারে। Hostile package-এর security smoke test installed WebView-তে করুন।

CSP defence-in-depth:

- production hostname শুধুই `connect-src`-এ
- remote `script-src` এড়িয়ে local hashed/nonce scripts
- inline script/style কমিয়ে `unsafe-inline` সরান যেখানে সম্ভব
- `frame-src`, `img-src`, `media-src` actual need অনুযায়ী সীমিত

Staging CSP inject করে, কিন্তু existing app behavior ও third-party dependency পরীক্ষা করা দরকার। CSP ভুল হলে feature break; broad CSP হলে protection কমে।

## ১৪. Permission-denied UX

প্রতি capability-তে অন্তত এই states design করুন:

1. not determined → context/rationale
2. granted → feature চালান
3. denied → non-coercive fallback
4. permanently denied/restricted → settings link এবং alternative
5. revoked while app/background task running → stop ও explain
6. feature unavailable on OS/device → capability-based UI hide/disable

Permission prompt বারবার spam করবেন না। Permission ছাড়া unrelated core app ব্যবহার সম্ভব রাখুন যেখানে বাস্তবসম্মত।

## ১৫. Release compliance checklist

- [ ] privacy policy/data safety/nutrition labels actual behavior-এর সঙ্গে মেলে
- [ ] third-party SDK/data collection inventoried
- [ ] exact alarm/full-screen/background location eligibility documented
- [ ] permission purpose strings placeholders নয়
- [ ] push/notification consent ও unsubscribe controls আছে
- [ ] account deletion/data deletion requirements পূরণ
- [ ] child/health/financial/location-sensitive regional rules reviewed
- [ ] accessibility, localization, offline/error UX tested
- [ ] real devices/OS versions, reboot, clock/time-zone, force-stop scenarios tested
- [ ] secrets/logging/CSP/dependency audit সম্পন্ন
- [ ] store submission screenshots/descriptions featureকে misleadingভাবে উপস্থাপন করে না

Store policy সময়ের সঙ্গে বদলায়; submission-এর দিন Google Play ও Apple-এর current policy আবার যাচাই করুন।
