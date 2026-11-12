# Deep Research: মোবাইলে Full Node.js রানটাইম (Capacitor/NativeKit)

তারিখ: ২০২৬-০৮-২৩ · main repo = **abcpersonal40/Capacitor** (তৎকালীন head `eb97f87`)

## প্রশ্ন
`capacitor-nodejs` বা `nodejs-mobile-cordova` দিয়ে ব্যাকগ্রাউন্ড থ্রেডে পুরো
Node.js ইঞ্জিন চালানো যায় — কোনটা best plugin?

## ল্যান্ডস্কেপ — মোবাইলে Full Node.js চালানোর বাস্তব পথ মাত্র ৪টা

| পথ | স্ট্যাটাস (আগস্ট ২০২৬) | Node ভার্সন | প্ল্যাটফর্ম | নোট |
|---|---|---|---|---|
| **hampoelz/Capacitor-NodeJS** (npm-এ `capacitor-nodejs`) | v1.0.0-beta.10, ২৬ মে ২০২৬ (active) | **18.20.4** (+16kb-fix) | ✅ Android · ❌ iOS *(coming soon-এ ৩ বছর ধরে আটকে আছে)* | একমাত্র রক্ষণাবেক্ষণকৃত Capacitor plugin; 103★ |
| `7HR4IZ3/capacitor-nodejs` | পুরোনো fork (beta.7), পরিত্যক্ত | 18.17 | Android | hampoelz-এরই পুরোনো হাত — **ব্যবহার করবেন না** |
| `nodejs-mobile-cordova` (Janea Systems) | **Archived / Unsupported** (Janea-র সব কাজ বন্ধ, ২০২৪) | 18.7 | Android+iOS | Cordova ইকোসিস্টেম — Capacitor-এর সাথে নয় |
| `okhiroyuki/nodejs-mobile-cordova` + nodejs-mobile org | কমিউনিটি fork (সর্বশেষ ঝকঝকে ২০২৪-০৫), iOS পুনরুদ্ধার করা | 18.7.1 | Android+iOS | ওটাও Cordova plugin |

(অন্য বিকল্প যেমন Tauri mobile, Termux, react-native-node — আলাদা স্ট্যাক; আমাদের WebView/sandbox আর্কিটেকচারে ওগুলো সরাসরি কাজ করে না।)

## গভীর ফল — প্রতিটার বাস্তবতা

### ১) hampoelz/Capacitor-NodeJS — বাছাই করতেই হলে এটাই "best"
- **ইনস্টল:** `npm install https://github.com/hampoelz/capacitor-nodejs/releases/download/v1.0.0-beta.10/capacitor-nodejs.tgz`
- **Capacitor v8+ প্রয়োজন** — আমাদের আর্কিটেকচার v8.5-র পাশাপাশি, Technically মিলবে
- Android prebuilt `libnode.so` = Node **18.20.4**; v-beta.9→beta.10-এ **`+16kb-fix` যুক্ত** — Android 15-এর 16KB page-size বাধ্য সমস্যা সমাধান হয়েছে (এটা আগে বড় blocker ছিল)
- ব্রিজ IPC সহজ: Node থ্রেডে `require('bridge')` দিয়ে `channel.addListener/send`; Web layer-এ `NodeJS.send/whenReady`
- `nodeDir` কনফিগ করে webdir-এ পুরো node প্রজেক্ট, npm ইন্সটল হয়; native addon চাইলে `staltz/prebuild-for-nodejs-mobile` দিয়ে প্রিবিল্ড
- `startMode: "manual"` দিলে runtime নিজে চাইলেই শুরু করা যায়
- **কিন্তু মেইন্টেইনার নিজেই README-এ লিখেছে:**
  > *"This plugin is no longer recommended for new projects. Consider migrating to Tauri."*
  কারণ: (১) upstream `nodejs-mobile` unmaintained → Node 18.20 **এসই EOL মধ্য-২০২৫** 🚨 (security patch আসবে না), (২) Electron সাপোর্ট বাদ চলে গেছে, (৩) সাইজ/startup/মেমরির অতিরিক্ত খরচ বড়।

### ২) nodejs-mobile-cordova — Janea-এর মূলধারার কাজ, কিন্তু Capacitor-এর জন্য নয়
- Janea Systems ২০২৪-এ সমর্থন বন্ধ করে দিয়েছে; `nodejs-mobile/nodejs-mobile-cordova` fork কমিউনিটির হাতে জীবন-মৃত্যুর মাঝে টিকে আছে
- যুক্ত করতে NDK যন্ত্রণা, GYP hook, cordova hook লাগে — **Capacitor-এর সাথে সরাসরি মিলে না**; আমাদের কাস্টম প্লাগিনে বসাতে manual rewiring লাগবে
- Node **১৮.৭** আরও পুরোনো; iOS-এ চলে, কিন্তু JIT ছাড়া V8 interpreted — ধীর।

### ৩) iOS-এ full Node — ভালো কিছু, খুব কম আছে
- capacitor-nodejs-এ iOS **"coming soon"** বছর তিনেক ধরে আছে — এখনো নেই
- cordova fork-এ `NodeMobile.xcframework` 18.7.1 আছে, যেটা আমাদের নিজস্ব iOS প্লাগিনে manually না বসালে চলবে না (কঠিন পরিশ্রম)
- App Store-এ interpreter-ভিত্তিক JS রানটাইম ঘোষিতভাবে অনুমোদিত; শুধু জায়গাটা পুরোনো seeded।
- উপলব্ধি: **iOS-এ maintained "full Node" plugin বর্তমানে নেই**। তাই যে রাস্তা হয় সেটা Android-only।

## ⚠️ রিস্কের চূড়ান্ত তালিকা
১. **Node 18 EOL** — security patch বন্ধ; mini-app sandbox আমাদেরকে রক্ষারেও Node রানটাইম নতুন attack surface
২. **APK সাইজ +৪০-৮০MB** (libnode প্রতি ABI) — ২৪MB-signed APK যেন ৬০-১০০MB
৩. **স্টার্টআপ + মেমরি চাপ** — সাধারণত low-end ডিভাইসে ব্যাকগ্রাউন্ড Node চালানো ভারী অতিরিক্ত ব্যয়
৪. **কোনো child process নয়** — `child_process.spawn/fork` মোবাইলে চলবে না (single-process প্রকৃতি) → যেসব npm package যেগুলো binary spawn করে = **না**; Android-এ `fs.link` না; `os.tmpdir` জমা হয় নিজে ঝাড়া লাগে
৫. **Native addon** (better-sqlite3, sharp ইত্যাদি) ব্যবহারে আলাদা prebuild লাগবে
৬. **Maintenance debt** — upstream টিকে থাকছে না; maintainer নিজেই সরে যেতে বলছে

## 🎯 ভার্ডিক্ট
**"কোনটা best?" → hampoelz/Capacitor-NodeJS v1.0.0-beta.10** — আজকের দিনে সবচেয়ে তাজা, Capacitor v8-সামঞ্জস্যপূর্ণ, 16KB-page সমাধানসহ prebuilt-ওয়ালা।
**কিন্তু এখনই NativeKit-এ বসানো উচিত? → না।**
- **আমাদের নিজের ব্রিজ background-runner আগেই আছে** (`backgroundRunner` label/event/defaultSyncUrl, কনফিগে আছে) — ওটাই হালকা, নিরাপদ, এবং Node-এর বেশিরভাগ background use-case সামলায়
- শুধু আসল Node-নির্দিষ্ট সুবিধা (npm ecosystem: device-এ express/http server চালানো, node-only crypto লাইব্রেরি, worker_threads, ডিএনএস/tcp প্রিমিটিভ) দরকার হলে তখনই এটা মূল্যনুকূল — তখন আলোচনা হবে।

## রোডম্যাপ সুপারিশ
- **এখন (আজকের):** backgroundRunner + app-browser network freedom (`full`-ডিফল্ট) দিয়েই এগিয়ে যাই — এটাই আমাদের mini-app সিস্টেমের নিরাপদ ও সঠিক পথ
- **ভবিষ্যতে দরকার হলে:** capacitor-nodejs beta.10-এর **Android native অংশ** (prebuilt `libnode.so` + `NodeJS.java` + bridge C++) কেটে নিয়ে **নিজস্ব NativeKit plugin** আকারে বসাই — cordova dependency বাদ দিয়ে আমাদের token-secured ব্রিজের ভিতরে। iOS তখন আলোচনা করি।
- **নজরে রাখতে:** Tauri v2 mobile, এবং ভবিষ্যতে nodejs-mobile-এর জাগরণ (community যদি আবার Node 20/22 prebuilt ছাড়ে) — তখন প্ল্যান পুনর্মূল্যায়ন।

---

**ক্রস-লিংক:** AI-agent হারনেসে এই গবেষণার সিদ্ধান্ত অনুসরণ করা হয়েছে — Node ছাড়াই WebView JS runtime: [`../ai-agent/HARNESS.bn.md`](../ai-agent/HARNESS.bn.md) · on-device ব্রেইনের সত্যিকার প্রার্থী llama.cpp: [`AGENTIC-ROADMAP.bn.md`](./AGENTIC-ROADMAP.bn.md) (P0.3)।
