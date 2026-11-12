import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configPath = path.join(rootDir, 'app.config.json');
export const schemaPath = path.join(rootDir, 'app.config.schema.json');

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function resolveInsideRoot(relativePath) {
  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Project root-এর বাইরের path অনুমোদিত নয়: ${relativePath}`);
  }
  return resolved;
}

export async function validateConfig({ throwOnError = true } = {}) {
  const [config, schema] = await Promise.all([readJson(configPath), readJson(schemaPath)]);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const schemaValid = validate(config);
  const errors = (validate.errors ?? []).map((error) => {
    const where = error.instancePath || '/';
    return `${where}: ${error.message}`;
  });
  const warnings = [];

  if (schemaValid) {
    const { app, web, network, features, android, ios, appBrowser, backgroundRunner, security, widget } = config;
    const reservedDirs = [web.nativeStagingDir, web.webOutputDir];
    const sourceDir = web.mode === 'static'
      ? web.staticDir
      : path.join(web.framework.workDir, web.framework.outputDir);

    if (reservedDirs.includes(sourceDir)) {
      errors.push('/web: source directory এবং generated output directory একই হতে পারবে না');
    }
    if (features.appBrowser !== appBrowser.enabled) {
      errors.push('/appBrowser/enabled: features.appBrowser-এর সঙ্গে একই হতে হবে');
    }
    const appBrowserFeatureMap = {
      camera: 'camera',
      location: 'location',
      backgroundLocation: 'backgroundLocation',
      haptics: 'haptics',
      notifications: 'localNotifications',
      alarms: 'advancedAlarms',
      background: 'backgroundRunner',
      secureStorage: 'secureStorage',
      sqlite: 'sqlite',
      filesystem: 'filesystem',
      fileTransfer: 'fileTransfer',
      sharing: 'sharing',
      networkStatus: 'networkStatus',
      pushNotifications: 'pushNotificationsReady',
      browser: 'inAppBrowser',
    };
    for (const capability of appBrowser.defaultCapabilities) {
      const featureName = appBrowserFeatureMap[capability];
      if (featureName && !features[featureName]) {
        errors.push(`/appBrowser/defaultCapabilities: ${capability} global feature বন্ধ থাকা অবস্থায় default grant করা যাবে না`);
      }
    }
    if (appBrowser.defaultCapabilities.length > 0) {
      warnings.push('App Browser third-party app-কে default native grants দেওয়া আছে; zero-trust setup-এ list খালি রাখুন।');
    }
    if (appBrowser.permissionPrompts.requestedCapabilityDefault === 'allow' || appBrowser.permissionPrompts.unrequestedCapabilityDefault === 'allow') {
      warnings.push('App Browser permission prompt default-এ automatic allow আছে; zero-trust setup-এ requested=ask এবং unrequested=block রাখুন।');
    }
    if (appBrowser.urlMode.allowedHosts.length === 0) {
      warnings.push('App Browser URL mode-এ global host allowlist ফাঁকা; প্রতিটি openUrl call-এর initial HTTPS host-ই navigation boundary হবে।');
    }
    if (appBrowser.allowDirectWebNetwork) {
      warnings.push('App Browser renderer-এর direct web network চালু আছে; ওই traffic NativeKit native API audit-এ ধরা পড়বে না এবং browser CORS প্রযোজ্য হবে।');
    }
    if (appBrowser.renderer === 'isolated' && !appBrowser.isolated.enabled) {
      errors.push('/appBrowser/isolated/enabled: renderer=isolated হলে true হতে হবে');
    }
    if (appBrowser.urlMode.enabled && !appBrowser.isolated.enabled) {
      errors.push('/appBrowser/urlMode/enabled: bridge-free URL mode-এর native renderer-এর জন্য isolated.enabled=true হতে হবে');
    }
    if (appBrowser.renderer === 'isolated' && appBrowser.isolated.androidMinApi < 28) {
      errors.push('/appBrowser/isolated/androidMinApi: Android multi-process WebView data directory isolation-এর জন্য কমপক্ষে 28 হতে হবে');
    }
    if (appBrowser.renderer === 'isolated' && appBrowser.isolated.fallbackToIframe) {
      warnings.push('Android API 28-এর নিচে বা native transport unavailable হলে opaque iframe fallback ব্যবহৃত হবে। কঠোর deployment-এ fallbackToIframe=false করুন।');
    }
    const wc = widget ?? { enabled: false, homeScreen: { enabled: false }, floating: { enabled: false } };
    if (wc.enabled && !features.widget) {
      errors.push('/widget/enabled: features.widget=true না হওয়া পর্যন্ত widget bridge চালু করা যাবে না');
    }
    if (wc.homeScreen.enabled && !wc.enabled) {
      errors.push('/widget/homeScreen/enabled: widget.enabled=true ছাড়া home-screen widget চালু করা যাবে না');
    }
    if (wc.floating.enabled && !wc.enabled) {
      errors.push('/widget/floating/enabled: widget.enabled=true ছাড়া floating widget চালু করা যাবে না');
    }
    if (wc.floating.enabled && app.id.startsWith('dev.nativekit')) {
      warnings.push('Floating overlay android.permission.SYSTEM_ALERT_WINDOW চায় এবং Play policy-এ একটি দৃশ্যমান user-visible purpose + in-app explanation (disclosure) থাকতে হবে।');
    }
    if (features.widget) {
      warnings.push('Home-screen widget data SharedPreferences/App Group-এ রাখা হয়; সংবেদনশীল data widget-এ দেখাবেন না। Floating overlay শুধু Android 8.0+।');
    }
    if (features.backgroundLocation && !features.location) {
      errors.push('/features/backgroundLocation: location=true ছাড়া background location চালু করা যাবে না');
    }
    if (features.backgroundLocation && !android.backgroundLocationForegroundService) {
      errors.push('/android/backgroundLocationForegroundService: backgroundLocation feature চালু হলে true করতে হবে');
    }
    if (features.backgroundLocation && !ios.backgroundLocation) {
      errors.push('/ios/backgroundLocation: backgroundLocation feature চালু হলে true করতে হবে');
    }
    if (android.fullScreenAlarm && !features.advancedAlarms) {
      errors.push('/android/fullScreenAlarm: advancedAlarms feature চালু না থাকলে full-screen alarm চালু করা যাবে না');
    }
    if (ios.alarmKitOnIOS26 && !features.advancedAlarms) {
      errors.push('/ios/alarmKitOnIOS26: advancedAlarms feature চালু না থাকলে AlarmKit চালু করা যাবে না');
    }
    if (features.advancedAlarms && android.exactAlarmPermissionMode === 'none' && !ios.alarmKitOnIOS26) {
      warnings.push('Advanced alarm code থাকবে, তবে Android exact permission mode এবং iOS AlarmKit—দুটিই বন্ধ; runtime fallback হবে।');
    }
    if (network.patchFetch !== network.patchXMLHttpRequest) {
      warnings.push('CapacitorHttp-এর global patch fetch ও XMLHttpRequest একসঙ্গে চালু করে; বর্তমান config-এ যেকোনো একটি true হলে দুটিই patch হবে।');
    }
    if (network.allowCleartext) {
      warnings.push('HTTP cleartext চালু আছে। Production-এ TLS/HTTPS ছাড়া এটি ব্যবহার না করাই নিরাপদ।');
    }
    if (security.allowNavigation.length > 0) {
      warnings.push('allowNavigation non-empty: remote page-কে native bridge দেওয়ার ঝুঁকি আছে। শুধু audited origin ব্যবহার করুন।');
    }
    if (android.exactAlarmPermissionMode === 'use') {
      warnings.push('USE_EXACT_ALARM কেবল core alarm/calendar app ও store-policy eligibility থাকলে ব্যবহারযোগ্য। সাধারণ app-এর জন্য schedule বেছে নিন।');
    }
    if (android.fullScreenAlarm) {
      warnings.push('Full-screen intent কেবল বৈধ alarm/call use-case-এ Play policy অনুযায়ী ব্যবহার করুন।');
    }
    if (features.backgroundLocation) {
      warnings.push('Background GPS store-policy sensitive; in-app disclosure, consent, stop control ও privacy policy বাধ্যতামূলক ধরে নিন।');
    }
    if (features.pushNotificationsReady && !ios.pushCapabilityConfigured) {
      warnings.push('Push API ready, কিন্তু APNs/Firebase/capability এখনো configured নয়—push register সফল হবে না।');
    }
    if (backgroundRunner.label !== backgroundRunner.taskIdentifier) {
      errors.push('/backgroundRunner/taskIdentifier: iOS Background Runner-এর জন্য এটি label-এর সমান হতে হবে');
    }
    if (!/^https:\/\//.test(backgroundRunner.defaultSyncUrl) && backgroundRunner.defaultSyncUrl !== '') {
      errors.push('/backgroundRunner/defaultSyncUrl: URL ফাঁকা অথবা https:// হতে হবে');
    }
    if (app.id === 'dev.nativekit.shell') {
      warnings.push('Placeholder app.id বদলে স্থায়ী reverse-domain ID দিন; store-এ প্রকাশের পর ID বদলাবেন না।');
    }
    if (app.name === 'NativeKit Demo') {
      warnings.push('Placeholder app.name বদলে আপনার app-এর নাম দিন।');
    }
  }

  if (throwOnError && errors.length) {
    throw new Error(`app.config.json invalid:\n- ${errors.join('\n- ')}`);
  }
  return { valid: errors.length === 0, errors, warnings, config };
}
