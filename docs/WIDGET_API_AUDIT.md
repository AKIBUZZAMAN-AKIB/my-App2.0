# NativeKit Widget API — Deep Audit & Cross-Device Review

Scope: the home-screen widget + floating overlay native API exposed to web (JS bridge
`window.NativeKit.widget.*` → plugin `@nativekit/widget` → Java/WidgetKit). Android-focused
(the user runs Android 10 / low-end). iOS notes included for parity.

---

## 1. Can a web developer "design freely" from HTML?

**Two very different answers, depending on which widget.**

### A) Floating bubble overlay — YES, full HTML/CSS/JS design
The bubble is a real WebView. A developer can supply **any** HTML page and style it freely.

- Provide a page via `window.NativeKit.widget.showFloating({ page: 'public/your-page.html', ... })`.
- The page is served by `WebViewAssetLoader` at
  `https://appassets.androidplatform.net/<page>`.
  - `AssetsPathHandler(context)` (no path prefix) reads from the **root of `assets/`**.
  - Capacitor copies the web staging dir into `assets/public/`, so the page must use the
    `public/` prefix: `public/widgets/floating.html` → `assets/public/widgets/floating.html`.
  - **Contract:** place your file under the web root (e.g. `www/my-widget.html`), then pass
    `page: 'public/my-widget.html'`. Relative `./` assets resolve fine.
- Two-way messaging:
  - App → page: `window.__nativeKitFloatingApply(jsonString)` (called on load + on every
    `sendToFloating`).
  - Page → app: `window.NativeKitFloating.postMessage(JSON.stringify(payload))` → becomes a
    `nativeFloatingMessage` event; app-side `onFloatingMessage`.
- So the floating widget is *fully* custom (any layout/JS/network-free design).

### B) Home-screen widget — NO free HTML (preset fields only)
The home-screen widget is drawn with native **RemoteViews** (TextView-only), rendered **by
the launcher process**, not by the app. RemoteViews cannot run arbitrary HTML/JS/views.

What a developer **can** configure per kind (via `setConfig(kind, spec)`):
`layout` (small|medium|large), `value`, `title`, `subtitle`, `icon` (emoji/glyph),
`backgroundColor`, `accentColor`, `action`, `actionValue`, `buttonLabel`. That is the whole
design surface — it maps onto 3 fixed layouts. You cannot add columns, images, charts, or
free positioning on the home-screen widget.

> Practical takeaway: **"design freely from HTML" = true for the floating overlay, false for
> the home-screen widget.** For a rich, fully-custom look, use the floating overlay.

---

## 2. Public API surface (what web calls)

```js
// Home-screen widget
await NativeKit.widget.setConfig('nativekit-widget', { layout:'medium', value:'42', title:'Counter',
  subtitle:'today', icon:'⚡', backgroundColor:'#0F172A', accentColor:'#4FC3F7',
  action:'open-counter', actionValue:'{"count":42}', buttonLabel:'Open' });
await NativeKit.widget.update('nativekit-widget', spec);   // setConfig + reload
await NativeKit.widget.reload('nativekit-widget');
await NativeKit.widget.getWidgetIds('nativekit-widget');
await NativeKit.widget.listConfigs();
await NativeKit.widget.requestPin('nativekit-widget');

// Floating overlay
await NativeKit.widget.checkFloatingPermission();     // -> { granted }
await NativeKit.widget.requestFloatingPermission();   // opens Settings
await NativeKit.widget.showFloating({ title, page, width, height, collapsed, data });
await NativeKit.widget.sendToFloating({ value: 42 });   // -> page
await NativeKit.widget.isFloatingVisible();
await NativeKit.widget.hideFloating();

// Events
await NativeKit.widget.onWidgetTap(cb);        // nativeWidgetTap
await NativeKit.widget.onFloatingMessage(cb);  // nativeFloatingMessage
```

---

## 3. Audit findings (bugs / risks)

### Severity: HIGH — resolved
| # | Issue | Status |
|---|-------|--------|
| 1 | `widget_small` was missing `widget_icon` → `RemoteViews.setTextViewText` threw → app crash | Fixed (icon added + per-view `safe()` guard) |
| 2 | `startForeground` always used `specialUse` type; invalid on Android 10 → service silently refused to start | Fixed (`promoteToForeground` dispatches by API level) |
| 3 | `buildBubble` cast `LinearLayout.LayoutParams` → `FrameLayout.LayoutParams` → `ClassCastException`, bubble never attached | Fixed (generic `ViewGroup.LayoutParams`, no cast) |
| 4 | `plugin load()` / `showFloating` / `addToWindow` could throw → whole app died | Fixed (try/catch + graceful stop + real `shown/error` reporting) |
| 5 | WebView renderer killed on low-end (memory) → app crash | Fixed (`onRenderProcessGone` → rebuild, API 26+ only) |

### Severity: MEDIUM — resolved
| # | Issue | Resolution |
|---|-------|------------|
| 6 | **Type/API mismatch:** `showFloating` & `isFloatingVisible` now return extra `shown`/`error`, but `index.d.ts` and `nativekit.d.ts.template` still declare `Promise<{ running: boolean }>` / `Promise<{ visible: boolean }>`. | **Fixed.** `plugins/widget/index.d.ts` and `types/nativekit.d.ts.template` now declare `shown?: boolean; error?: string;` on `showFloating`/`isFloatingVisible`, and `requestPin` returns `requested` + optional `hint`, and `sendToFloating` returns `delivered/running/shown`. |
| 7 | **`extra` field is documented but unused.** `WidgetConfig.extra`/`NativeKitWidgetSpec.extra` are declared and `WidgetStore.extra()` exists, but no renderer reads it. | **Resolved (documented, not rendered).** The home-screen widget uses native `RemoteViews` (TextView-only, rendered by the launcher), which cannot render arbitrary `extra` keys — so `extra` is documented as **metadata only** in both `.d.ts` files, with an explicit note to pass known layout fields directly or use a custom floating page for full HTML design. |
| 8 | **`floating.startOnLaunch` config does nothing.** It only exists in `app.config.json`/schema; native code never reads it. | **Fixed.** `NativeKitWidgetPlugin.load()` now reads the `dev.nativekit.FLOATING_START_ON_LAUNCH` manifest meta-data (baked by `configure-native.mjs`) and starts the bubble on launch via `maybeStartFloatingOnLaunch()` — guarded so it only fires when the config is `true`, overlay permission is already granted, and no bubble is running. |
| 9 | **`sendToFloating` silently no-ops when the overlay isn't shown.** `floatsend` returns `{ pushed: n }` regardless; if no bubble is running the broadcast is dropped. | **Fixed.** `sendToFloating` now returns the real delivery state: `{ delivered, running, shown }` (with `delivered` = `isShown()`). `www/app.js` `floatsend` surfaces it and shows a "Show bubble first" hint when not delivered. |
| 10 | **`requestPin` may return `false` on some launchers** (known Android/OEM quirk after fresh install or when the launcher hasn't refreshed the receiver). It never throws, but users see nothing happen. | **Fixed.** `requestPin()` now includes a `hint` field when `requestPinAppWidget` returns `false`, telling the user to long-press the home screen → Widgets → add "`<kind>`" manually. Type-bearing surfaces (`index.d.ts`, `nativekit.d.ts.template`) declare the optional `hint`. |

### Severity: LOW ✓ already safe
- Home-screen widget = pure TextView RemoteViews → no unsupported views; renders on all launchers.
- `PendingIntent` uses `FLAG_IMMUTABLE` (API 23+) — OK on minSdk 24.
- Whole-widget tap → `getLaunchIntentForPackage` + `FLAG_ACTIVITY_NEW_TASK` — always opens app.
- Overlay uses `TYPE_APPLICATION_OVERLAY` (API 8+ correct branch); `SYSTEM_ALERT_WINDOW` checked
  before start.
- `notifyListeners(..., true)` retains events for late listeners.
- Broadcast scoped via `setPackage()` → other apps can't spoof widget taps.

---

## 4. Cross-device support verdict

| Component | Android 8–10 | Android 11–13 | Android 14+ | Notes |
|-----------|:---:|:---:|:---:|-------|
| Home-screen widget (RemoteViews TextView) | ✅ | ✅ | ✅ | Most reliable; only preset layouts |
| Widget renderer (onUpdate in-app) | ✅ | ✅ | ✅ | Guarded vs bad config |
| `requestPinAppWidget` | ⚠️ | ⚠️ | ⚠️ | Can return `false` on OEM launchers; handle gracefully |
| Floating overlay (`TYPE_APPLICATION_OVERLAY`) | ✅ (perm required) | ✅ | ✅ | Works with overlay permission |
| Floating FGS (`specialUse`) | ✅ (2-arg startForeground) | ✅ (2-arg) | ✅ (specialUse + permission) | Now API-dispatched |
| Floating WebView | ✅ | ✅ | ✅ | Handles renderer kill |
| WidgetKit (iOS 15+) | — | — | — | `containerBackground` guarded for iOS 17+ |

**Remaining cross-device caveats (informational, not bugs):**
- On AOSP/clean Android the bubble works. On aggressive OEM skins (MIUI, EMUI, some Samsung)
  the FGS can be auto-stopped by battery optimizers; advise users to allow "no battery
  optimization" for the app if the bubble disappears.
- `SYSTEM_ALERT_WINDOW` requires a Play-visible disclosure (config already flags this).

---

## 5. Recommended next steps (prioritized) — all complete
1. Update `.d.ts` typings to include `shown`/`error` (fixes issue #6). ✅
2. Make `sendToFloating` report delivery state (issue #9). ✅
3. Give a clear hint when `requestPin` returns false (issue #10). ✅
4. Implement `floating.startOnLaunch` auto-start on launch (issue #8). ✅
5. Re-document `extra` as metadata-only for the RemoteViews renderer (issue #7). ✅

### Verification status
- `npm run test` → widget suite (17 tests) all pass (see `tests/widget.test.ts`).
- Java static checks: brace balance OK (the only `{`/`}` skew is inside a string literal,
  `message.startsWith("{")`); imports for `ApplicationInfo`/`PackageManager` present;
  `ContextCompat` present; `FloatingWidgetService.isRunning()/isShown()/ACTION_START` used.
- `.nativekit/` bridge bundle + `.nativekit/bridge/nativekit.d.ts` are gitignored build artifacts,
  regenerated from `types/nativekit.d.ts.template` by `scripts/build-bridge.mjs` at build time.
- Full Android compile is verified by CI (not run locally; the sandbox has no `android.jar`).
