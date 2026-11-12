# NativeKit Widget — Full UI & Screen-Overlay Customization from Web

Goal: a web developer should be able to **fully design** the floating overlay (position, size,
full-screen, chrome, behavior, and its HTML/CSS/JS content) **from `www/`** — no native code.

The home-screen widget is drawn by the launcher with native `RemoteViews` (TextView-only), so it
can never be freely designed from HTML. **The floating overlay is a real WebView**, so that is
where full customization lives. This doc maps what is possible today, what is fixed, the design we
implemented to unlock the rest, and how to use it.

---

## 1. What a web developer can customize TODAY (`showFloating`)

| Option | Type | Effect | Status |
|--------|------|--------|--------|
| `title` | `string` | Native header title + FGS notification title | ✅ |
| `page` | `string` | Bundled HTML page under `www/` (pass `public/...`), loaded into the bubble WebView | ✅ |
| `width` / `height` | `number` (dp) | Bubble size | ✅ |
| `collapsed` | `boolean` | Start as the small handle | ✅ |
| `data` | `any` | JSON pushed to the page on load (→ `window.__nativeKitFloatingApply`) | ✅ |
| (page markup) | HTML | The page itself is arbitrary HTML/CSS/JS via `window.NativeKitFloating.postMessage` + `window.__nativeKitFloatingApply` | ✅ |

### What was FIXED / not controllable from web (the gaps)
These were hard-coded in `FloatingWidgetService` and could not be changed by a web developer:

- **Position / anchor** — always `TOP|START`, `x=24dp`, `y=96dp`. No top/center/bottom, no align.
- **Full-screen vs bubble** — window was always `WRAP_CONTENT` sized to the bubble; no full-screen mode.
- **Window flags** — always `NOT_FOCUSABLE | NOT_TOUCH_MODAL`; no focusable (typing) or touch-pass-through (badge) modes.
- **Native chrome** — always rendered the native header bar (drag handle + title + close). A developer wanting a pure-HTML design had to live with the native bar.
- **Content as inline HTML** — only a bundled `page` file; couldn't pass an inline `html` string.
- **Runtime geometry** — could not reposition/resize after showing.
- **Arbitrary JS** — could not inject JS into the overlay from `www`.

---

## 2. Design implemented — a richer `showFloating` + runtime controls

### `showFloating(options)` — extended options
```ts
interface FloatingWidgetOptions {
  title?: string;            // header title (chrome:'bar') + notification title
  page?: string;             // bundled page under public/ (e.g. 'widgets/mine.html')
  html?: string;             // inline HTML — overrides `page` when set (full custom content)
  width?: number;            // dp (ignored in fullscreen)
  height?: number;           // dp (ignored in fullscreen)
  collapsed?: boolean;       // start collapsed to the handle
  data?: unknown;            // initial payload pushed to the page

  fullscreen?: boolean;      // true => overlay fills the screen (MATCH_PARENT), chrome hidden
  focusable?: boolean;       // true => can take input focus (ILME/typing); default false
  touchThrough?: boolean;    // true => FLAG_NOT_TOUCHABLE (pass-through, passive badge)
  chrome?: 'bar' | 'none';   // 'bar' native header (default) | 'none' pure-HTML
  draggable?: boolean;       // default true (drag only via the native header bar)

  position?: {
    gravity?: 'top' | 'center' | 'bottom';   // default 'top'
    align?:   'start' | 'center' | 'end';    // default 'start'
    x?: number;                              // dp offset (edge-relative)
    y?: number;                              // dp offset
    marginX?: number;                        // dp margin from the edge (used when x/y omitted)
    marginY?: number;
  };
}
```

### Runtime control methods (new)
| Method | Purpose |
|--------|---------|
| `updateFloating(options)` | Re-apply size / position / flags / chrome / html **live** without restarting the bubble. |
| `runFloatingJavascript(code)` | Inject arbitrary JS into the overlay WebView (e.g. drive the page's own DOM). |
| `sendToFloating({data})` | (existing) push JSON → `window.__nativeKitFloatingApply`. |

### Control from inside the page (`window.NativeKitFloating.*`)
The page can command the overlay itself:
| Method | Effect |
|--------|--------|
| `postMessage(msg)` | (existing) page → host app event `nativeFloatingMessage`. |
| `resize(width, height)` | Resize the bubble content (native dp). |
| `move(x, y)` | Reposition the overlay. |
| `collapse()` / `expand()` | Toggle the content visibility. |
| `close()` | Hide/stop the overlay. |

---

## 3. Behavior notes / cross-device
- Overlay is `TYPE_APPLICATION_OVERLAY` on Android 8+ (`TYPE_PHONE` below); requires
  `SYSTEM_ALERT_WINDOW` (system permission). Check/request via
  `checkFloatingPermission()` / `requestFloatingPermission()`.
- `fullscreen` uses `FLAG_LAYOUT_IN_SCREEN | FLAG_LAYOUT_NO_LIMITS` + `MATCH_PARENT`. On OEM skins the
  overlay still cannot cover status/navigation bars without extra flags; content fills the usable area.
- `touchThrough` makes the whole overlay non-touchable, so the WebView cannot receive taps — use for
  passive surfaces (e.g. a timer badge). For anything interactive keep it `false`.
- Inline `html` is loaded with `loadDataWithBaseURL("https://appassets.androidplatform.net/", ...)`,
  so relative `./` assets still resolve from the app assets root.
- `chrome:'none'` hides the native header, so the only drag handle is gone — combine with
  `draggable:false` for a fixed overlay, or render your own drag affordance in the page.
- All new config is read defensively; unknown keys are ignored, so existing `showFloating` calls keep
  working unchanged. Low-end / Android 10 fallbacks (renderer-gone rebuild, native-text fallback) apply.

---

## 4. Verification
- Widget suite (`tests/widget.test.ts`) — 17 tests, all pass.
- `plugins/widget/android/src/main/java/.../FloatingWidgetService.java` and
  `NativeKitWidgetPlugin.java` brace-balanced; new config keys parsed defensively.
- Types updated in `plugins/widget/index.d.ts` and `types/nativekit.d.ts.template`
  (regenerated into the gitignored `.nativekit/bridge/nativekit.d.ts` by `build-bridge.mjs`).
- Demo in `www/app.js` + `www/widgets/floating.html` exercise position, fullscreen, chrome,
  inline html, `runFloatingJavascript`, and page-side `resize/move/collapse`.
- Android compile verified by CI (not run locally — no `android.jar` in sandbox).
