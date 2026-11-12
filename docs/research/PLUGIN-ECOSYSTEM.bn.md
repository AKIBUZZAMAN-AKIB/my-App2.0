# 🔌 প্লাগিন ইকোসিস্টেম ডিপ-ডুব — আর কী কী অ্যাড করা যায় (v1, 2026-08-24)

> প্রশ্ন: আমাদের শেল/এজেন্ট-রোডম্যাপের জন্য Capacitor ইকোসিস্টেমে আর কোন কোন প্লাগিন যোগ করা সার্থক? স্কোরিং: (ক) agentic-রিলেভ্যান্স, (খ) ইতিমধ্যে শিপড ফিচারের সাথে যোগফল, (গ) রক্ষণাবেক্ষণ/ঝুঁকি।
> সোর্স: [awesome-capacitor (capawesome-team)](https://github.com/capawesome-team/awesome-capacitorjs) · [riderx/awesome-capacitor](https://github.com/riderx/awesome-capacitor) · [dotnetdreamer/awesome-capacitor](https://github.com/dotnetdreamer/awesome-capacitor) · [Capawesome ML Kit ডকস](https://capawesome.io/docs/plugins/mlkit/) · [Cap-go background-geolocation রিলিজ](https://github.com/Cap-go/capacitor-background-geolocation/releases)

## বর্তমান ইনভেন্টরি (**১৯টি প্যাকেজ** — Android-এ **২০টি রেজিস্টার্ড ক্লাস**; সব কাজ প্রমাণিত)
অফিসিয়াল: app, background-runner, camera, file-transfer, filesystem, geolocation, haptics, keyboard, local-notifications, network, preferences, push-notifications, share · কমিউনিটি: sqlite · Capgo: inappbrowser (২ ক্লাস) · trancee: nearby-connections · নিজস্ব: custom-native, isolated-browser, widget।
*(এটি ২০২৬-০৮-২৪-এর পরে `widget` লোকাল প্লাগিন যোগের পরে আপডেট — আগে ১৮ প্যাকেজ/১৯ ক্লাস ছিল।)*

---

## 🏆 টায়ার-১: ইনস্টলই করলে পরের দিনই লাভ (জিরো-ঝুঁকি অফিসিয়াল/আধা-অফিসিয়াল)

| প্লাগিন | কেন | এজেন্ট-যোগফল |
|---|---|---|
| **@capacitor/clipboard** (অফিসিয়াল) | রিড/রাইট ক্লিপবোর্ড — এজেন্টের ইনপুট/আউটপুট লুপে ক্লিপবোর্ড = ক্যারির | "এই টেক্সটটা কপি করো", ক্লিপবোর্ডে নম্বর পড়ে ফোন করাও |
| **@capacitor/toast** (অফিসিয়াল) | এজেন্টের ছোট ফিডব্যাক ("রিমাইন্ডার সেট হয়েছে") | নিশ্চিতকরণ মেসেজ |
| **@capacitor/dialog** (অফিসিয়াল) | confirm/alert/prompt — কনসেন্ট তারকা UI | হাই-রিস্ক অ্যাকশনে confirm চাইছি |
| **@capacitor/device** (অফিসিয়াল) | ব্যাটারি/মেমরি, মডেল, OS ইনফো | লো-ব্যাটারিতে LLM-লুপ বন্ধ; ডিসপ্লে-গেটিং |
| **@capacitor/motion** (অফিসিয়াল) | accelerometer/gyro — shake-to-activate জেসচার | শেক করলে ভয়েস এজেন্ট জাগে |
| **@capacitor/screen-reader** (অফিসিয়াল) | Accessibility স্টেট পড়া | স্ক্রিন-রিডার চালু থাকলে এজেন্টের আচরণ সেই অনুযায়ী ঠিক করা |
| **@capacitor/splash-screen + screen-orientation + text-zoom** (অফিসিয়াল) | UX পলিশ | — |
| **@capacitor/watch** (অফিসিয়াল) | Wear OS/WatchOS-এ অ্যাপ যুক্ত করা | ঘড়ি-এজেন্ট = রোডম্যাপের শেয়ার |
| **@capgo/nativegeocoder** (Capgo ⭐31) | ল্যাট-লং ↔ ঠিকানা | **"পল্টনে গেলে মনে করাও"** — ঠিকানা→কোঅর্ডিনেট O(1); geofence-এর আগে দরকার |
| **@capgo/capacitor-flash** ⭐16 / **@capawesome/capacitor-torch** | ফ্ল্যাশলাইট | "লাইট জ্বালাও" — Gemini Utilities-এর ক্লাসিক ইউজ-কেস |
| **@capacitor-community/text-to-speech** ⭐116 | TTS — এজেন্টের মুখ | সবশেষে অবশ্যই (on-device LLM-TTS-এর হালকা বিকল্প; ফ্রি — সিস্টেম ভয়েস ব্যবহার করে) |
| **@capawesome-team/capacitor-speech-recognition** (বা community ⭐118) | STT — এজেন্টের কান; community-রটা পুরনো, capawesome-টা সক্রিয় | ভয়েস কমান্ড |
| **@capawesome-team/capacitor-audio-recorder** | মাইক রেকর্ড | ভয়েস মেমো → STT → LLM |

**ইন্টিগ্রেশন নোট:** পুরো গ্রুপটাই `configure-native` টেমপ্লেটে `features.*` গেট করে ঢুকবে — ম্যানিফেস্ট-এ স্পেসিফিক পারমিশন প্রায় লাগবে না (RECORD_AUDIO speech/recorder-এ, READ_CONTACTS পরে)।

## 🥈 টায়ার-২: মাঝারি ঝুঁকি/বড় মূল্য

| প্লাগিন | কেন | সতর্কতা |
|---|---|---|
| **@capgo/capacitor-background-geolocation** (ফ্রি পোর্ট) — **geofence ফিচার ইতিমধ্যে বিল্ট-ইন** ([রিলিজ নোট](https://github.com/Cap-go/capacitor-background-geolocation/releases)): enter/exit ইভেন্ট + রিবুট-সরভাইভ | **"ওই জায়গায় গেলে মনে করিয়ো" USE-CASE-এর সরাসরি উত্তর** — আমরা নিজে হাতে geo-check না করেই নেটিভ GeofencingClient ব্যবহার করে | transistorsoft-এর প্রিমিয়াম লাইসেন্স মুড না এলে Capgo-রটাই নিন; আমাদের বর্তমান bg-location custom-native-এর সাথে কনফ্লিক্ট-চেক লাগবে |
| **@capacitor-mlkit/barcode-scanning** — QR/বারকোড স্ক্যান (GMS-ভিত্তিক মডেল; Play Services-বিহীন ডিভাইসের জন্য bundled স্ট্যাটিক-মডেল ভেরিয়েন্টেও কাজ করে) | "এই QR-টা স্ক্যান করো"; ওয়াইফাই QR পড়ে কানেক্ট হয়ে যাও | GMS-বিহীন ভেরিয়েন্ট: bundled স্ট্যাটিক মডেল (বিকল্প) |
| **@capacitor-mlkit/face-detection + face-mesh** (ভিশন) | অন-ডিভাইস ছবি-বোঝা, এজেন্ট কনটেক্সট | API-লেভেল |
| **@capacitor-mlkit/document-scanner** | রসিদ/ডকুমেন্ট স্ক্যান → ফাইল → LLM-এ ফিড | Android গ্রেডেন্ট ধীর |
| **@capacitor-mlkit/translation** | ON-DEVICE অনুবাদ (bn↔en!) | মডেল ডাউনলোড = আমাদের Download ফ্লোই |
| **@capacitor-community/barcode-scanner** ⭐445 | MLKit-এর বিকল্প (ZXING) | রক্ষণাবেক্ষণ অনিয়মিত |
| **@capawesome-team/capacitor-biometrics** / @aparajita ⭐214 | ফিঙ্গারপ্রিন্ট দিয়ে হাই-রিস্ক এজেন্ট-অ্যাকশন কনফার্ম | শক্ত কনসেন্ট প্যাটার্ন — এজেন্ট বললেই টাকা কাটবে না |
| **@capawesome-team/capacitor-contacts** | সম্পর্ক পড়ুন/লিখুন — "মামাকে মেসেজ দাও" | পারমিশন-ভারী; Play পলিসি ডিসক্লোজার |
| **@ebarooni/capacitor-calendar** ⭐62 | ক্যালেন্ডার ইভেন্ট তৈরি/পড়া — "কালকের মিটিং রিমাইন্ড করো" | পারমিশন UI স্পষ্ট করে লিখুন |
| **@capawesome-team/capacitor-bluetooth-low-energy** | BLE কন্ট্রোল — IoT-এজেন্ট | Nearby-র পাশাপাশি ইন্ডাস্ট্রিয়াল BLE |
| **@capgo/capacitor-nfc** | NFC ট্যাগ পড়া/লেখা — ট্যাগ-ট্রিগার অটোমেশন | স্টার তুলনামূলক কম, তবু কাজ করে |
| **@capacitor-community/keep-awake** ⭐163 | দীর্ঘ এজেন্ট-টাস্কে স্ক্রিন জাগিয়ে রাখা | ব্যাটারি নোট |
| **@capawesome/capacitor-screenshot** | এজেন্টের প্রমাণ/রিপোর্ট ক্যাপচার | — |
| **@capawesome-team/capacitor-file-opener** | জেনেরেট করা PDF/রিপোর্ট ইউজারের অ্যাপে খোলে দেওয়া | FileProvider সঙ্গে — কনফ্লিগ করতে হয় |

## 🥉 টায়ার-৩: সিচুয়েশনাল/দেরিতে

- **@revenuecat/purchases-capacitor** ⭐210 (সাবস্ক্রিপশন — মনিটাইজেশন এলে), **Stripe** ⭐230 (পেমেন্ট), **Admob** ⭐271 (অ্যাড)
- **@capgo/capacitor-updater** ⭐647 — OTA লাইভ-আপডেট — APK ছাড়াই ফিচার পুশ; পলিসি-রিস্ক-নিরপেক্ষ ব্যবহার (app-code-শেয়ার নয়, হটফিক্স)। চিন্তা করুন পরে।
- **@capacitor-firebase/* (analytics/crashlytics/remote-config/functions)** — প্রোডাকশন শিপ এলে; FCM তখনই push beta-থেকে বেরোবে।
- **@capawesome-team/capacitor-android-foreground-service** — generic foreground work; আমরা আমাদের নিজস্বে ব্যবহার করি, এটা রিডান্ড্যান্ট।
- **@capawesome-team/capacitor-secure-preferences** — আমাদের custom-native secure-storage-ই আছে — অপ্রয়োজনীয় ডুপ্লিকেট।
- **capacitor-plugin-camera (OCR ফ্রেম-হুক)** ও cordova ইতিহাস — MLKit পরিবারই সঠিক পথ।

## ❌ যেগুলো অ্যাড করবেন না
- **safe-area / status-bar / system-bars প্লাগিন** — আমরা কোর SystemBars + নিজস্ব ইনসেট পাইপ নিজেরাই গড়েছি; বাইরের প্লাগিন দিলে সেই ভিত্তির সঙ্গে কনফ্লিক্ট।
- **action-sheet** — dialog-ই যথেষ্ট (`Toast`+`Dialog`)।
- অতিরিক্ত সাবধানতা: `@capacitor-community/background-geolocation` (ইতিমধ্যে চিহ্নিত শেপ; আমরা Capgo ভ্যারিয়েন্টে যাব)।

---

## এজেন্ট-ম্যাপিং দৃষ্টিভঙ্গি (quick chessboard)

| ইউজার-স্টেটমেন্ট | লাগবে | স্ট্যাটাস |
|---|---|---|
| "সকাল ৭টায় অ্যালার্ম দাও" | alarms (✅ শিপড) + STT (⬇ T2) + TTS | ২ ধাপ বাকি |
| "পল্টনে গেলে বাজার করতে মনে করাও" | geocoder (⬇ T1) + geofence (⬇ T2) | ২ ধাপ |
| "লাইট জ্বালাও/নেভাও" | torch/flash (⬇ T1) | ১ ধাপ |
| "এই QR স্ক্যান করে ওয়াইফাই বাদে সব জানাও" | MLKit barcode (⬇ T2) | ১ ধাপ |
| "রসিদটা ছবি তুলে pdf করে পাঠাও" | document-scanner (⬇ T2) + filesystem ✅ + share ✅ | ১ ধাপ |
| "হেলো বলো তো কথা বলো" (ভয়েস এজেন্ট) | STT+TTS (⬇ T1) + LLM loop (P0.1) | ৩ ধাপ |
| "মামার ফোন নম্বরটা দাও" | contacts (⬇ T2) | ১ ধাপ |
| "আমার পরের মিটিংটা কখন এবং কোথায়" | calendar (⬇ T2) | ১ ধাপ |
| NFC ট্যাগ ছুঁয়ে দিলে রুটিন চালু | nfc (⬇ T2) | ১ ধাপ |

**করণীয় সিদ্ধান্ত (পরের ইটারেশন):** টায়ার-১ পুরোটা (১১ প্লাগিন) এক ঝটকায় feature-gate করে বসিয়ে দেওয়া যায় — সবই ছোট, সক্রিয়, পারমিশন-হালকা। তারপর geocoder+geofence প্যাকেজ "জায়গা-রিমাইন্ডার" ফিচারটি সম্পূর্ণ করে — ডেমোর জন্য সবচেয়ে নাটকীয় ফল।
