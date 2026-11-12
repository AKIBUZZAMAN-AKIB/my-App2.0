# In-App Browser plugin বনাম NativeKit App Browser

**Source-level audit date:** ২০২৬-০৮-১৭  
**সিদ্ধান্ত:** বর্তমান NativeKit App Browser-কে কোনো সাধারণ In-App Browser plugin দিয়ে wholesale replace করা উচিত নয়। বর্তমান broker রাখুন। Remote read-only web page দেখাতে official plugin আলাদা feature হিসেবে ব্যবহার করা যেতে পারে; native managed-WebView দরকার হলে Capgo-কে কেবল কঠোরভাবে সীমিত **renderer adapter** হিসেবে proof-of-concept করা যেতে পারে।

## ১. নাম এক হলেও দায়িত্ব এক নয়

এই project-এর `bridge/app-browser.ts` আসলে শুধু browser window নয়। এটি একসঙ্গে:

- runtime-এ ZIP/files/folder/Web Component package install ও persist করে;
- package path, size, count, manifest ও SHA-256 integrity যাচাই করে;
- package identity ও policy ধরে রাখে;
- opaque-origin sandbox-এ app চালায়;
- random session token ও exact `event.source`-bound RPC দেয়;
- per-app, per-capability এবং per-method native permission enforce করে;
- host allowlist, rate limit, payload/resource quota ও ownership enforce করে;
- native side effect-এর আগে durable audit invocation commit করে;
- disable/update/remove-এ session, subscription, alarm, notification, location, database, preference, secure storage ও file cleanup করে।

অন্যদিকে সাধারণ In-App Browser plugin-এর প্রধান দায়িত্ব হলো **একটি URL native WebView/System Browser-এ দেখানো ও তার presentation lifecycle চালানো**। `executeScript()` বা `postMessage()` থাকলেও সেগুলো transport; package identity, authorization বা audit নয়।

তাই তুলনাটি দুই layer আলাদা করে করতে হবে:

1. **Renderer/presentation layer:** WebView তৈরি, toolbar, back/forward, sizing, show/hide, navigation event।
2. **Package-security broker:** কে call করছে, কোন app, কোন method allowed, data/resource কার, quota কত, audit হয়েছে কি না।

Plugin দিয়ে প্রথম layer-এর কিছু বা সব বদলানো সম্ভব। দ্বিতীয় layer বাদ দেওয়া নিরাপদ নয়।

## ২. যে version/source পরীক্ষা করা হয়েছে

NPM registry-এর ২০২৬-০৮-১৭ snapshot অনুযায়ী:

| Candidate | Audited version | Capacitor peer | Android minSdk | License |
|---|---:|---:|---:|---|
| Official `@capacitor/inappbrowser` | `4.0.2` | `>=8.0.0` | **26** | MIT |
| `@capawesome/capacitor-in-app-browser` | `0.2.0` | `>=8.0.0` | 24 | MIT |
| `@capgo/capacitor-inappbrowser` | `8.15.2` | `>=8.0.0` | 24 | MPL-2.0 |

বর্তমান shell-এর `android.minSdk` হলো **24**। তাই official plugin install করলে পুরো Android app-এর minSdk অন্তত 26 করতে হবে; Android 7.0/7.1 (API 24–25) support বাদ যাবে। অন্য দুই candidate-এর declared minSdk বর্তমান shell-এর সঙ্গে মেলে।

Reproducibility-এর জন্য inspected repository heads:

- official plugin: `4af1964bcf85e1c77331ffc6b313a30ae407394e`
- official Android dependency: `de7dc46dfe7df78ea15394a2765802377c6c7098`
- official iOS dependency: `dba78d3eb49df762896aaa527f2a2581f9066c8f`
- Capawesome monorepo: `200d5cd2f79c8ec070aa94661daaf3f2c12b2419`
- Capgo plugin: `fdc545f6283fc6b836b525696c8994e7d48e1776`

এটি source audit; actual device/WebView penetration test নয়। বিশেষত official iOS storage-isolation claim runtime-এ আলাদাভাবে পরীক্ষা করা প্রয়োজন।

## ৩. Requirement matrix

| প্রয়োজন | বর্তমান NativeKit broker | Official | Capawesome | Capgo |
|---|---:|---:|---:|---:|
| Remote HTTP(S) page দেখানো | সীমিত/direct network policy অনুযায়ী | ✅ | ✅ | ✅ |
| System browser / native toolbar | ❌ custom iframe stage | ✅ | ✅ | ✅ |
| Build-time bundled local path | ✅ current shell assets | ❌ cross-platform API নেই | ❌ initial HTTP(S)-only | ✅ `8.15.0+` |
| Runtime-uploaded ZIP/files install | ✅ | ❌ | ❌ | ❌ |
| Package validation/integrity | ✅ | ❌ | ❌ | ❌ |
| Installed-app identity + session binding | ✅ broker identity/session | ❌ | ❌ | ❌ |
| Page ↔ host messaging | ✅ controlled RPC | ❌ | ✅ generic | ✅ extensive generic |
| `executeScript` | ইচ্ছাকৃতভাবে package-কে raw API নয় | ❌ | ✅ | ✅ |
| Per-app capability switch | ✅ | ❌ | ❌ | ❌ |
| Per-method allow/deny | ✅ | ❌ | ❌ | ❌ |
| Global feature gate | ✅ | ❌ | ❌ | ❌ |
| Host allowlist + redirects disabled | ✅ | ❌ | ❌ | deny/proxy controls আছে, broker-equivalent নয় |
| Storage/file/DB/alarm/notification ownership | ✅ | ❌ | ❌ | ❌ |
| Resource quota | ✅ | ❌ | ❌ | ❌ |
| Disable/update/remove cleanup | ✅ | ❌ | ❌ | browsing lifecycle আছে; app-owned native cleanup নেই |
| Durable per-call audit | ✅ | ❌ | ❌ | console/proxy events আছে; authorization audit নয় |
| Navigation-এ bridge revocation | ✅ installed native guard + session stop | bridge নেই | ❌ built-in নয় | ❌ broker-grade built-in নয় |
| Renderer/process isolation | same host WebView/process | Android API 28+ শক্তিশালী; নিচে সীমা আছে | native WebView; Android store shared | managed native WebView; package-security isolation নয় |

**সবচেয়ে গুরুত্বপূর্ণ ফল:** কোনো candidate-ই current broker-এর security/control requirements পূরণ করে না।

## ৪. Official `@capacitor/inappbrowser` 4.0.2

### এটি কী ভালোভাবে করে

- external browser, system browser এবং embedded native WebView—তিনটি presentation path;
- toolbar, close, navigation buttons, custom headers/user-agent ও lifecycle/navigation-completed event;
- remote untrusted **read-only** web content-এর সঙ্গে app-এর Capacitor bridge না মেশানোর সরল model;
- Android API 28+ এ default `isIsolated: true` হলে আলাদা `:OSInAppBrowser` process ও `WebView.setDataDirectorySuffix("OSInAppBrowser")`;
- main app-এর cookies/localStorage থেকে Android API 28+ managed WebView storage আলাদা রাখা।

Official plugin-এর public API-তে `executeScript`, page `postMessage`, local package install বা arbitrary native RPC নেই। Remote content-এর attack surface ছোট রাখার দিক থেকে এই অনুপস্থিতি **ভালো**; কিন্তু NativeKit package runtime-এর জন্য এটিই plugin-টিকে অযোগ্য করে।

### Local uploaded app কেন চলবে না

Android এবং iOS plugin entry points initial URL-এ শুধু `http://` বা `https://` গ্রহণ করে। Public TypeScript contract-ও HTTP(S) URL চায়। ফলে:

- iOS-এর `capacitor://localhost/...` rejected;
- `file://`, `data:`, `blob:` rejected;
- runtime-uploaded package/ZIP install বা serve করার API নেই;
- page ↔ host RPC transport নেই;
- `window.NativeKit` bootstrap বা call routing নেই।

Android-এ `https://localhost/...` string validation পার হলেও official browser activity Capacitor host WebView-এর local asset loader নয়; এটিকে documented cross-platform local-package mechanism ধরা যাবে না।

### Android isolation-এর সঠিক সীমা

Official documentation-এর wording-এর চেয়ে source behavior নির্দিষ্টভাবে বোঝা জরুরি:

- **API 28+ এবং `isIsolated:true`:** পৃথক activity/process ও data-directory suffix ব্যবহৃত হয়।
- **API 26–27:** platform limitation-এর কারণে shared activity/process/store fallback।
- **`isIsolated:false`:** supported API-তেও shared path।
- plugin নিজেই minSdk 26 চায়; API 24–25 আর support থাকবে না।

এটি current same-WebView iframe-এর তুলনায় API 28+ এ meaningful renderer/storage boundary দিতে পারে। কিন্তু process isolation package authorization নয়। Official Android WebView source-এ একই সঙ্গে নিচের settings enabled:

```text
allowFileAccess = true
allowFileAccessFromFileURLs = true
allowUniversalAccessFromFileURLs = true
```

অতএব “separate process/store” মানেই hostile-content hardened sandbox নয়। বিশেষ করে future navigation/file-origin behavior ও WebView vulnerability threat model-এ এগুলো review করতে হবে।

### iOS documentation/source discrepancy

Official docs বলছে iOS storage default-এ isolated। কিন্তু audited dependency `OSInAppBrowserLib-iOS` exact `2.3.2`-এ:

- `OSIABWebViewConfigurationModel.toWebViewConfiguration()` একটি default `WKWebViewConfiguration()` বানায়;
- সেখানে `.nonPersistent()` বা plugin-owned isolated `WKWebsiteDataStore` assign করা দেখা যায়নি;
- official plugin adapter cache manager-কে `OSIABBrowserCacheManager(dataStore: .default())` দিয়ে তৈরি করে।

এ কারণে **iOS isolation source থেকে verify করা যায়নি** এবং documentation-এর সঙ্গে দৃশ্যমান implementation-এর discrepancy আছে। Runtime cookie/localStorage test ছাড়া “iOS isolated” security claim গ্রহণ করা উচিত নয়। এটি সরাসরি vulnerability প্রমাণ নয়; source-visible uncertainty।

### এই project-এ official plugin নিলে কী পাওয়া যেত

পাওয়া যেত:

- remote help/legal/support page-এর maintained native browser UI;
- Custom Tabs/SFSafariViewController path;
- Android API 28+ এ remote WebView storage/process isolation;
- custom toolbar/lifecycle code কম maintenance।

হারাতে/বদলাতে হতো:

- Android API 24–25 support;
- local uploaded app runtime;
- controlled NativeKit RPC, package policy, quota, ownership, cleanup ও audit—সবই আলাদা করে রাখতে হতো।

**Verdict:** remote read-only browser হিসেবে উপযোগী; current App Browser replacement নয়।

## ৫. Capawesome `@capawesome/capacitor-in-app-browser` 0.2.0

### কী সুবিধা দেয়

Official plugin-এর চেয়ে app ↔ page integration বেশি:

- `executeScript()`;
- `postMessage()` এবং page-side `window.CapacitorInAppBrowser.postMessage(...)`;
- URL-change, navigation-completed, page-loaded ও close event;
- cache/cookie controls;
- iOS-এ shared বনাম isolated/non-persistent data store option;
- hidden/show এবং toolbar controls।

RPC bootstrap লেখা সহজ হতো এবং native WebView presentation পাওয়া যেত।

### Source-level security observations

1. Initial `openInWebView` URL HTTP(S)-only। Runtime package installer/loader নেই।
2. Android definitions স্পষ্ট বলে data store app-global/shared; per-package storage isolation নেই।
3. Android WebView-এ Java `addJavascriptInterface` register হয় এবং page start/finish-এ JS wrapper inject হয়। Source-এ subsequent HTTP(S) navigation-এর strict origin allowlist/revocation দেখা যায়নি। ফলে initial trusted package অন্য origin-এ গেলে সেই নতুন document-ও messaging interface পেতে পারে।
4. Android media request-এ host app-এর CAMERA/RECORD_AUDIO permission থাকলে requesting web origin যাচাই না করেই সংশ্লিষ্ট WebView resource grant করা হয়।
5. iOS main-frame document start-এ message bridge inject ও script handler register হয়; media-capture delegate request origin না দেখে `.grant` দেয়।

এগুলো plugin-টিকে সাধারণ trusted embedded page-এর জন্য অকার্যকর করে না। কিন্তু hostile/runtime-uploaded app model-এ current default-deny broker-এর বদলে সরাসরি ব্যবহার নিরাপদ নয়।

### এই project-এ নিলে কী পাওয়া যেত

- native WebView presentation;
- generic bidirectional messaging ও script injection;
- iOS optional non-persistent store;
- current iframe rendering code-এর কিছু অংশ কমানো।

কিন্তু package install, identity, capability/method authorization, quota, ownership, cleanup ও audit পুরোই রাখতে হতো। উপরন্তু navigation-origin ও media-capture behavior fork/harden করতে হতো।

**Verdict:** developer convenience ভালো; এই threat model-এ replacement নয় এবং default implementation নিয়ে broker renderer হিসেবেও recommend করা হচ্ছে না।

## ৬. Capgo `@capgo/capacitor-inappbrowser` 8.15.2

### তিনটির মধ্যে কেন closest renderer candidate

Capgo managed WebView layer অনেক বিস্তৃত:

- `openWebView()`-এ toolbar, multi-instance ID, full/partial-screen dimensions;
- hide/show, front/back layering, runtime resize;
- `executeScript`, `postMessage`, page messaging;
- screenshot, print, popup, download, file chooser;
- proxy/interception rules, console capture;
- private/non-persistent browsing controls;
- `8.15.0+` এ `/index.html` বা `assets/page.html`-এর মতো relative **app-bundled** path platform-local Capacitor URL-এ resolve করে serve করা।

এটি renderer/presentation হিসেবে current iframe-এর চেয়ে native UI, sizing, multiple windows ও process/WebView lifecycle control বেশি দেয়। Capgo-এর Android minSdk 24 হওয়ায় shell-এর declared device floor-ও বদলাতে হয় না।

### Bundled path support-এর গুরুত্বপূর্ণ সীমা

Capgo local path feature app build-এর `public/`/`www/`-এ আগে থেকে packaged asset serve করে। এটি নিজে:

- runtime-uploaded ZIP install করে না;
- IndexedDB-তে রাখা package validate/persist করে না;
- প্রতিটি newly uploaded package-এর private local origin তৈরি করে না;
- manifest identity বা policy তৈরি করে না।

অতএব “local assets supported” মানে current runtime package manager পুরো বাদ দেওয়া যাবে—এমন নয়। Runtime package bytes native-private storage/virtual origin-এ stage/serve করার আলাদা adapter লাগবে, অথবা current srcdoc/data-URL packaging রাখতে হবে।

### Source-level security observations

Capgo feature surface বড়, তাই default attack surface-ও বড়:

- Android WebView-এ `AndroidInterface`, `mobileApp`, `PreShowScriptInterface`, `PrintInterface` এবং proxy enabled হলে `__capgoProxy` JavaScript interface register হয়;
- Android settings-এ content/file access, file-URL access এবং universal file-origin access enabled;
- page scripting, proxying, downloads, popup ও native UI actions plugin contract-এর অংশ;
- `blockedHosts` denylist আছে, কিন্তু এটি per-package positive host allowlist + authenticated native authorization-এর সমতুল্য নয়;
- built-in WebView ID transport identity নয়: caller কোন installed package, integrity version বা policy session—plugin নিজে জানে না।

এগুলো Capgo-কে “খারাপ plugin” বলে না; feature-rich browser হওয়াই এর উদ্দেশ্য। কিন্তু least-privilege untrusted package runner হিসেবে unnecessary interfaces disable/remove না করলে risk বাড়ে।

### এই project-এ নিলে কী পাওয়া যেত

Capgo renderer adapter দিয়ে সম্ভাব্যভাবে replace করা যেত:

- iframe presentation/stage-এর বড় অংশ;
- custom native window sizing, show/hide ও multi-instance plumbing;
- app-bundled local page resolution;
- optional screenshot/print/download/popup UI integration।

যা replace করা যাবে না:

- package ZIP/path/integrity validation;
- runtime app storage ও stable app ID;
- random policy session এবং source binding;
- per-app/per-method authorization;
- global feature gate;
- host/network policy ও request bounds;
- alarm/notification/file/DB/preference ownership;
- quotas, revoke/remove cleanup;
- native-call fail-closed durable audit।

**Verdict:** closest optional rendering-layer candidate; current broker replacement নয়।

## ৭. যদি ভবিষ্যতে Capgo hybrid করা হয়

এটি “plugin install করে broker delete” refactor হবে না। নিরাপদ design হবে:

```text
Uploaded package
      ↓
Hardened native WebView renderer (Capgo fork/adapter)
      ↓  authenticated, bounded message transport
Existing NativeKit package broker
      ↓  every-call policy + ownership + quota + pre-audit
NativeKit/native plugins
```

Minimum acceptance criteria:

1. package-accessible unnecessary built-in JavaScript interfaces disable/remove;
2. package-কে raw `executeScript`, proxy decision, print/screenshot/native UI control না দেওয়া;
3. per-launch cryptographically random token, app ID + package integrity + WebView instance ID bind করা;
4. message schema, method name, arguments ও response/event size hard-limit;
5. main-frame navigation commit হওয়ার **আগে** exact local origin/approved host allowlist enforce;
6. disallowed navigation attempt-এ bridge/session immediately revoke;
7. per-app non-shared/non-persistent store বা documented private-store strategy;
8. runtime package private storage/virtual-origin serving—path traversal ও MIME validationসহ;
9. every native call-এ broker-side authorization; page JavaScript-এর self-reported app ID বিশ্বাস না করা;
10. current quotas, ownership marker, cleanup ও `OUTCOME_PENDING` audit semantics অপরিবর্তিত রাখা;
11. Android API 24–27, 28+, current target; iOS 15–26; cookie/localStorage, navigation race, popup, file URL, camera/mic এবং process-kill tests;
12. upstream update নেওয়ার আগে source-diff/security regression review।

এই hardening ছাড়া Capgo hybrid current implementation-এর চেয়ে feature-rich হলেও security-wise regression হতে পারে।

## ৮. Final architecture recommendation

### এখনই যা রাখব

- `bridge/app-browser.ts` package/security broker;
- `sandbox="allow-scripts"` opaque-origin boundary;
- random token + exact frame source check;
- native navigation guard;
- per-app/capability/method policy;
- quota, ownership, cleanup ও audit।

### Optional আলাদা remote-browser feature

Remote legal/help/support/OAuth-compatible page দেখাতে official `@capacitor/inappbrowser` আলাদা API হিসেবে বিবেচনা করা যায়—কিন্তু:

- এটি uploaded app launcher হবে না;
- page-কে NativeKit bridge দেওয়া হবে না;
- Android minSdk 26 করার product decision আগে নিতে হবে;
- official iOS isolation runtime-এ verify করতে হবে;
- OAuth provider embedded WebView নিষিদ্ধ করলে system browser/appropriate auth session ব্যবহার করতে হবে।

### কখন Capgo POC যুক্তিযুক্ত

শুধু তখন, যখন product requirement-এর মধ্যে নিচের এক বা একাধিকটি সত্যি দরকার:

- uploaded app-কে separate native WebView/window-এ চালানো;
- partial-screen/native layering;
- multiple persistent browser instances;
- iframe main-thread/resource-isolation limitation কমানো;
- native download/popup/file chooser integration।

এগুলোর প্রয়োজন না থাকলে current simpler renderer + broker রাখা কম dependency ও ছোট attack surface দেয়।

## ৯. সরাসরি প্রশ্নের উত্তর

**“Existing In-App Browser plugin নিলে কী অর্জন হতো?”**

- maintained native WebView/system-browser presentation;
- toolbar/lifecycle/navigation UI কম custom code;
- candidate অনুযায়ী messaging/script/sizing/download/proxy সুবিধা;
- official Android API 28+ path-এ stronger process/storage separation।

**“Custom App Browser বাদ দেওয়া যেত?”**

না। কারণ plugin-গুলো browser renderer; বর্তমান App Browser package installer, identity provider, authorization broker, resource governor এবং audit/cleanup controller।

**“কোনটি সবচেয়ে কাছাকাছি?”**

Capgo `8.15.2`, তবে কেবল renderer layer-এ। Generic `executeScript`/`postMessage` security boundary নয়।

**“এখন refactor করব?”**

না। বর্তমান broker রাখাই recommended decision। Actual compiled Android/iOS WebView smoke test শেষ করার পর, আলাদা branch-এ hardened Capgo renderer POC করা যেতে পারে; security acceptance criteria pass না করলে merge নয়।

## ১০. Sources

### Package/version metadata

- <https://registry.npmjs.org/@capacitor%2Finappbrowser/latest>
- <https://registry.npmjs.org/@capawesome%2Fcapacitor-in-app-browser/latest>
- <https://registry.npmjs.org/@capgo%2Fcapacitor-inappbrowser/latest>

### Official Capacitor InAppBrowser

- Docs, minSdk ও isolation claim: <https://capacitorjs.com/docs/apis/inappbrowser>
- Public TypeScript API: <https://github.com/ionic-team/capacitor-os-inappbrowser/blob/main/src/definitions.ts>
- Android plugin/HTTP(S) validation: <https://github.com/ionic-team/capacitor-os-inappbrowser/blob/main/android/src/main/java/com/capacitorjs/osinappbrowser/InAppBrowserPlugin.kt>
- Android build/minSdk/dependency: <https://github.com/ionic-team/capacitor-os-inappbrowser/blob/main/android/build.gradle>
- iOS plugin and `.default()` cache manager: <https://github.com/ionic-team/capacitor-os-inappbrowser/blob/main/ios/Sources/InAppBrowserPlugin/InAppBrowserPlugin.swift>
- iOS exact `2.3.2` dependency: <https://github.com/ionic-team/capacitor-os-inappbrowser/blob/main/Package.swift>
- Android activity/process selection: <https://github.com/OutSystems/OSInAppBrowserLib-Android/blob/main/src/main/java/com.outsystems.plugins.inappbrowser/osinappbrowserlib/routeradapters/OSIABWebViewRouterAdapter.kt>
- Android data suffix ও WebView settings: <https://github.com/OutSystems/OSInAppBrowserLib-Android/blob/main/src/main/java/com.outsystems.plugins.inappbrowser/osinappbrowserlib/views/OSIABWebViewActivity.kt>
- iOS 2.3.2 WebView configuration: <https://github.com/OutSystems/OSInAppBrowserLib-iOS/blob/2.3.2/Sources/OSInAppBrowserLib/Models/OSIABWebViewConfigurationModel.swift>
- iOS 2.3.2 cache manager: <https://github.com/OutSystems/OSInAppBrowserLib-iOS/blob/2.3.2/Sources/OSInAppBrowserLib/OSIABCacheManager.swift>

### Capawesome

- Docs: <https://capawesome.io/docs/sdks/capacitor/in-app-browser/>
- Public API: <https://github.com/capawesome-team/capacitor-plugins/blob/main/packages/in-app-browser/src/definitions.ts>
- Android URL validation: <https://github.com/capawesome-team/capacitor-plugins/blob/main/packages/in-app-browser/android/src/main/java/io/capawesome/capacitorjs/plugins/inappbrowser/classes/options/OpenInWebViewOptions.java>
- Android bridge/navigation/media permission: <https://github.com/capawesome-team/capacitor-plugins/blob/main/packages/in-app-browser/android/src/main/java/io/capawesome/capacitorjs/plugins/inappbrowser/classes/WebViewDialog.java>
- iOS bridge/data store/media permission: <https://github.com/capawesome-team/capacitor-plugins/blob/main/packages/in-app-browser/ios/Plugin/Classes/WebViewController.swift>

### Capgo

- Docs: <https://capgo.app/docs/plugins/inappbrowser/>
- Public API ও bundled-path note: <https://github.com/Cap-go/capacitor-inappbrowser/blob/main/src/definitions.ts>
- Android build/minSdk: <https://github.com/Cap-go/capacitor-inappbrowser/blob/main/android/build.gradle>
- Android managed WebView/interfaces/settings: <https://github.com/Cap-go/capacitor-inappbrowser/blob/main/android/src/main/java/ee/forgr/capacitor_inappbrowser/WebViewDialog.java>
- Android bundled-asset resolver: <https://github.com/Cap-go/capacitor-inappbrowser/blob/main/android/src/main/java/ee/forgr/capacitor_inappbrowser/BundledAssetSupport.java>
