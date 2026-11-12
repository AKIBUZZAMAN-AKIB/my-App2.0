# Deep Research: HTML Fullscreen মোডে Phone Navigation নাটক (Blend + Immersive)

তারিখ: ২০২৬-০৮-২৩ · v1.3.3 → v1.3.4 · Owner-এর প্রশ্ন: *"page spans FULL screen — কিন্তু HTML fullscreen মোডে গেলে আবার ফোনের navigation বোতাম পাতার নিচের বোতামের উপর ভেসে আসবে?"*

## গবেষণার ফল (যাচাইকৃত): চিন্তা একদম সঠিক ছিল!

### রুট কারণ চেইন
1. আমাদের নতুন **blend (transparent bar + edge-to-edge window)** মানে nav/status বারের নিচে page-কনটেন্ট দেখা যায় — এর উদ্দেশ্য রঙ মিলে যাওয়া
2. HTML5 `requestFullscreen()` চালু হলে → Android WebView-এর `WebChromeClient.onShowCustomView()` ডাকা হয় — Capacitor (v8.5) তার `BridgeWebChromeClient`-এ **কেবল defer করে super-কে**; কোনো সিস্টেম-বার হ্যান্ডলিংই করতে নেই
3. ফলে ফুলস্ক্রিন ভিডিও/কনটেন্ট দেখানোর সময়ও ফোনের nav-button এলাকা তার **transparent স্বচ্ছ জায়গাতেই থাকে** — মানে page-এর নিজের বোতাম/কন্ট্রোলের উপরে ভেসে পড়ে
4. এটা WebView-নির্দিষ্ট দুর্বলতা না — Android-এর ধরনের UX trade-off (যেকোনো app-এই ফুলস্ক্রিন ভিডিও মোডে সিস্টেম বার লুকায় — YouTube/Netflix টাই)

### Android-এর প্রমাণিত সমাধান (অ-পরামর্শ নয়, স্ট্যান্ডার্ড)
- ফুলস্ক্রিনে প্রবেশের সঙ্গে সঙ্গেই **সিস্টেম বার লুকিয়ে ফেলতে হয়**: `WindowInsetsControllerCompat.hide(systemBars())`
- আর **swipe-এ transient-ভাবে** ফিরে আসবে: `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — অর্থাৎ ভিডিও চলার সময় edge-সোয়াইপ করলেই বার ফিরে আসে একটু translucent হয়ে, তারপর নিজেই আবার লুকে যায়
- ফুলস্ক্রিন থেকে বের হলে `show()` + আমাদের **blend আবার প্রয়োগ**

## আমাদের ফিক্স (v1.3.4) — দুই স্তরে
১. **কিভাবে বুঝব ফুলস্ক্রিনে গেছে?** JS জিজ্ঞেস করতে হয় না। Android-এ হাঁ'সেখানে: `onShowCustomView` ঘটলে decorView-এ **নতুন top-level child যুক্ত হয়** — তাই আমরা decorView-এর `OnHierarchyChangeListener` দিয়ে detect করি (initial layout- এলাকার শিশুদের এড়াতে এক post-টিকের পরে "armed" করি)
২. **Detected → immersive**:
   - Main shell (`MainActivity` — **configure-native টেমপ্লেটে**, যেহেতু `configure:native` রানে MainActivity রিজেনারেট/ওভাররাইট হয় — আগের ভুল থেকে শিক্ষা)
   - Mini-app উইন্ডো (`IsolatedBrowserActivity` — plugin ফাইল, যা regenerate হয় না)

### আচরণ (পরীক্ষার ছক)
| অবস্থা | উপরের বার | নিচের বার |
|---|---|---|
| সাধারণ scroll | blend (page-এর রঙ) | blend (page-এর রঙ) |
| HTML fullscreen-এ প্রবেশ | **লুকে যায়** | **লুকে যায়** |
| Fullscreen-এ edge-সোয়াইপ | translucent-এ ফিরে | translucent-এ ফিরে, কিছুক্ষণ পরে আবার লুকে |
| Fullscreen থেকে বের হওয়া | blend-এ ফিরে | blend-এ ফিরে (re-apply) |

### বাকি সতর্কতা (deep research-এর ব্যাপারে)
- **OEM বৈকল্পিক**: Xiaomi/Samsung-এর gesture pill অনেক সময় নিজেই scrims টেনে দেয় — আমাদের transparent + immersive সঠিকভাবে ওদেরও standard পথ
- **page-এ নিচে বসানো বাটন**: ফুলস্ক্রিন *ছাড়াও* — page নিজেকে `--safe-area-inset-bottom` দিয়ে pad করে (আমাদের UI এমনই) — mini-app author-রূপে ওই একই নিয়ম মানলে কোনো সমস্যি overlap হবে না
- ভবিষ্যতে যদি ভিডিও-কন্ট্রোল চাই (নিচে) — সেটা page নিজে padding দিয়ে রাখে; সিস্টেম জায়গায় আমরা কিছুক্ষণই ভেসে থাকব সোয়াইপে

## টেস্ট প্রোটোকল (নতুন APK হাতে পেলে)
1. app-এ কোনো HTML5 ভিডিও/embedded পাতা খুলে "fullscreen" চাপুন (যে কোনো ভিডিও/fullscreen-able element)
2. দেখতে হবে: nav+status বার **মিলে যায়**, কনটেন্ট একদম edge-থেকে edge
3. নিচের edge-এ আলতো swipe → বার translucent-ভাবে ফিরে, কয়েক সেকেন্ডে আবার লুকে যায়
4. fullscreen থেকে exit → আবার blend (page রঙে মিলে)

---

## ✅ চূড়ান্ত অবস্থা (v1.3.4 → **v1.3.6**, শিপড)

1. **v1.3.4** — decorView hierarchy-listener দিয়ে element-fullscreen detect (ভুল: সব WebView layout-এ ফলস-পজিটিভ → সর্বদা-ফুলস্ক্রিন রিগ্রেশন)
2. **v1.3.5** — ≥70% window-size gate সহ filtered listener — ফলস-পজিটিভ বন্ধ, কিন্তু শিখেছি: **Chromium WebView element-fullscreen কখনো onShowCustomView বা অনন্য decor-event দেয় না** — আসল ডিটেক্টর হিসেবে ব্যর্থ
3. **v1.3.6 (শিপড, commit `4b6f9a0`)** — আসল সমাধান: **JS `fullscreenchange` ব্রিজ**। buildDocument-এ mini-app ডকুমেন্টে ইঞ্জেক্টেড স্ক্রিপ্ট `window.NativeKitImmersive.setFullscreen(!!document.fullscreenElement)` ডাকে; native তখনই bars লুকায়/ফেরায়। Main shell-ও same `addJavascriptInterface` পথ; decor-listener শুধু fallback। সাথে বহু-বোতাম fullscreen টেস্ট পেজ।

> শিক্ষা: WebView element-fullscreen-এ native-side detection আশা অর্থহীন — DOM event + bridge-ই সঠিক পথ।
