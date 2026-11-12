# Android/iOS build, signing ও GitHub Actions

## ১. Toolchain

### Common

- Node.js 22+
- `npm ci`

### Android

- JDK 21
- Android SDK/API 36 ও accepted licenses
- repository Gradle wrapper ব্যবহার করুন

### iOS

- macOS
- Xcode 26+
- Apple Developer membership (device/App Store/ad-hoc distribution-এর জন্য)
- app ID-matching certificate ও provisioning profile

Capacitor 8 baseline: Android minimum API 24; iOS deployment target 15। Repository workflows hosted runners-এ toolchain setup করে।

## ২. Reproducible preparation

```bash
npm ci
npm run check
npm run ci:android  # validate + clean stage + Capacitor sync + generated config
# macOS only
npm run ci:ios
```

`ci:android`/`ci:ios` compile করে না; native projects deterministicভাবে prepare করে। Build commands এরপর চলে। Generated files config থেকে আবার লেখা হতে পারে।

## ৩. Android local builds

```bash
cd android
./gradlew --no-daemon assembleDebug
./gradlew --no-daemon assembleRelease
./gradlew --no-daemon bundleRelease
```

Typical outputs:

- `android/app/build/outputs/apk/debug/app-debug.apk`
- `android/app/build/outputs/apk/release/*.apk`
- `android/app/build/outputs/bundle/release/*.aab`

AAB Play/App Store ধরনের distribution artifact; সরাসরি সাধারণ APK installer নয়। Release signing না থাকলে release artifact unsigned হতে পারে; debug APK debug key দিয়ে installable।

### Android release signing variables

`configure-native.mjs` নিচের environment variables একসঙ্গে পেলে generated release signingConfig বসায়:

| Variable | মান |
|---|---|
| `ANDROID_KEYSTORE_PATH` | decoded `.jks`/`.keystore` absolute/relative path |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

CI secret হিসেবে file path নয়, Base64 data রাখা হয়:

| GitHub Secret | অর্থ |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore-এর single-line Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | alias |
| `ANDROID_KEY_PASSWORD` | key password |

macOS/Linux:

```bash
base64 < release.keystore | tr -d '\n'
```

Secret set editor-এ output paste করুন। Workflow temporary file decode করে, `ANDROID_KEYSTORE_PATH` export করে এবং job শেষে delete করে। চার secret-এর আংশিক set error—সব দিন অথবা একটিও নয়।

### Keystore তৈরি (প্রথম release-এর আগে)

```bash
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Keystore/password secure offline backup করুন। Play App Signing ব্যবহার করলে upload key হারানো recoverable process হতে পারে, কিন্তু app-signing identity এবং operational access রক্ষা জরুরি। Keystore repository-তে commit করবেন না।

## ৪. iOS local compile/archive

Unsigned simulator compile:

```bash
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Signed device archive:

```bash
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$PWD/build/App.xcarchive" \
  DEVELOPMENT_TEAM=YOURTEAMID \
  CODE_SIGN_IDENTITY='Apple Distribution' \
  archive
```

Export:

```bash
xcodebuild -exportArchive \
  -archivePath "$PWD/build/App.xcarchive" \
  -exportPath "$PWD/build/export" \
  -exportOptionsPlist /secure/path/ExportOptions.plist
```

Placeholder structure: [`ExportOptions.example.plist`](./ExportOptions.example.plist)। এটি সরাসরি usable secret নয়। অন্তত বদলান:

- `method`: Xcode 26-এ `app-store-connect`, `release-testing`, `debugging`, অথবা eligible হলে `enterprise`
- `teamID`
- `provisioningProfiles` dictionary-র bundle ID key ও profile name/UUID
- certificate selector/signing style, যদি আপনার setup আলাদা হয়

বর্তমান Xcode-এর authoritative key/value list localভাবে দেখুন:

```bash
xcodebuild -help | sed -n '/Available keys for -exportOptionsPlist:/,$p'
```

Export options Base64 secret-এ রাখলে real profile/team metadata source control-এ দিতে হয় না।

## ৫. iOS signing assets

GitHub Secrets:

| Secret | প্রয়োজন | অর্থ |
|---|---:|---|
| `IOS_CERTIFICATE_BASE64` | signed IPA | private key-সহ `.p12` Base64 |
| `IOS_CERTIFICATE_PASSWORD` | signed IPA | `.p12` password |
| `IOS_PROVISIONING_PROFILE_BASE64` | signed IPA | `.mobileprovision` Base64 |
| `IOS_EXPORT_OPTIONS_PLIST_BASE64` | signed IPA | real `ExportOptions.plist` Base64 |
| `IOS_TEAM_ID` | optional | profile থেকে derive না করে override |
| `IOS_CODE_SIGN_IDENTITY` | optional | default `Apple Distribution` override |

Encoding:

```bash
base64 < Distribution.p12 | tr -d '\n'
base64 < App.mobileprovision | tr -d '\n'
base64 < ExportOptions.plist | tr -d '\n'
```

Workflow:

1. random-password temporary keychain তৈরি
2. `.p12` import ও codesign access partition list সেট
3. profile decode করে UUID অনুযায়ী `~/Library/MobileDevice/Provisioning Profiles/`-এ install
4. profile plist থেকে Team ID derive (override না থাকলে)
5. archive এবং IPA export
6. IPA ও dSYM checksums তৈরি
7. `always()` cleanup-এ profile, certificate, plist, keychain delete

Profile-এ app bundle ID, team এবং প্রয়োজনীয় entitlements/capabilities মিলতে হবে। Expired/revoked certificate/profile দিয়ে archive/export fail করবে।

## ৬. GitHub Actions behavior

### `.github/workflows/android.yml`

Triggers: configured push, pull request, manual dispatch। Workflow:

- official checkout/setup Node/setup Java/setup Gradle actions
- `npm ci`, `npm run check`, `npm run ci:android`
- optional signing secret validation/decode
- আলাদা Gradle invocation-এ debug APK, release APK, release AAB
- artifact list ও SHA-256 checksum
- `android-apk-aab-${{ github.sha }}` artifact, 14 দিন retention
- credentials cleanup

APK/AAB আলাদা task হওয়ায় একসঙ্গে heavy lint/dex/resource workload-এর memory risk কমে।

### `.github/workflows/ios.yml`

- every normal push/PR/manual run: Xcode 26 unsigned Simulator compilation
- signed export শুধু:
  - `v*` tag push; অথবা
  - manual dispatch-এ `create_ipa=true`
- four required signing secrets missing/partial হলে signed job fail-fast
- IPA, zipped dSYMs, checksum → `ios-ipa-${{ github.sha }}`, 14 দিন retention

Workflow artifact তৈরি করে; App Store Connect-এ upload/submission/release স্বয়ংক্রিয় করে না।

## ৭. Push credentials আলাদা

Project Push Notifications plugin API প্রস্তুত রেখেছে, কিন্তু নিচেরগুলো intentionally deferred:

- Android `google-services.json`, Firebase project ও server/provider credentials
- iOS APNs capability/entitlement, compatible provisioning profile ও APNs key/certificate
- user token registration এবং notification provider/backend

`pushNotificationsReady=true` বা `ios.pushCapabilityConfigured=true` দিলেই credentials তৈরি হয় না। Secret source control-এ দেবেন না।

## ৮. Secret safety

- fork pull request-এ secrets সাধারণত দেওয়া হয় না; untrusted PR code-কে signing secrets দেবেন না
- Actions log-এ `set -x`, Base64 echo, decoded path contents, signing command password print নিষিদ্ধ
- GitHub Environment approval/protection ব্যবহার করে production signing সীমাবদ্ধ করুন
- credentials rotate/expire হলে secrets update করুন
- checksum file integrity comparison-এ সহায়ক, কিন্তু publisher authenticity-এর বিকল্প নয়
- signed output real device, TestFlight/internal track-এ verify না করে release করবেন না

## ৯. Troubleshooting

### Android

- Java version error → `java -version` JDK 21 কিনা দেখুন
- SDK API missing → API 36 install/`ANDROID_HOME` check
- unsigned release → সব signing variable উপস্থিত কিনা
- OOM/lint failure → APK/AAB আলাদা invocation, runner resource/Gradle memory adjust; failing partial output release নয়

### iOS

- `No profiles for ...` → profile bundle ID/team/capabilities mismatch
- signing identity not found → `.p12` private key-সহ কিনা এবং password ঠিক কিনা
- export method error → Xcode 26 method value ও `xcodebuild -help` verify
- SPM resolution error → network/cache retry, Xcode version এবং `CapApp-SPM/Package.swift` inspect
- AlarmKit compile issue → Xcode 26+/iOS 26 SDK selected কিনা; older deployment support guarded fallback-এ থাকে
