# NativeKit Home-Screen Widget — Richer Customization from Web

The home-screen widget is drawn by the **launcher** with Android `RemoteViews`, so it cannot run
arbitrary HTML/CSS/JS the way the floating overlay can. But it **is** richer than a fixed template:

- `RemoteViews` supports `FrameLayout`/`LinearLayout`/`RelativeLayout`/`GridLayout` plus
  `TextView`/`ImageView`/`ImageButton`/`Button`/`ProgressBar`/`Chronometer`/collection views
  (`ListView`/`GridView`/`StackView`/`ViewFlipper`). Descendants / custom views are not supported.
- **WebView/HTML is impossible on a home-screen widget** — the widget is inflated in the launcher
  process from a `@RemoteView` whitelist. A WebView is not supported; the common workaround
  (offscreen WebView → Bitmap → `ImageView`) needs the overlay permission and is unreliable.

The **real design surface** is therefore a **layout resource your app ships**. This page documents
the fields that actually render (`WidgetConfig`) **plus** how to use a **fully custom layout** by
referencing a resource name, so a developer can design freely inside RemoteViews' rules.

> For unlimited HTML design, use the floating overlay (`showFloating`, see
> `docs/WIDGET_FULL_CUSTOMIZATION.md`). This doc is the home-screen counterpart.

---

## 1. Field-by-field surface (`WidgetConfig` / `NativeKitWidgetSpec`)

### Content
| Field | Type | Effect |
|-------|------|--------|
| `layout` | `'small' \| 'medium' \| 'large' \| '<res>'` | Bundled preset, **or the name of a layout resource your app ships** (free design). |
| `value` | `string` | Primary value text (big number, time, temp). |
| `title` | `string` | Heading (default `NativeKit`). |
| `subtitle` | `string` | Supporting line (hidden if empty/absent). |
| `icon` | `string` | Emoji/glyph header icon (hidden if absent). |
| `image` | `string` | A drawable resource name shown via an `ImageView` (`@+id/widget_image`). |
| `imageData` | `string` | A base64 PNG/JPEG (or `data:` URI) decoded to a Bitmap and shown via `ImageView`. |

### Layout & alignment
| Field | Type | Effect |
|-------|------|--------|
| `align` | `'start' \| 'center' \| 'end'` | Horizontal content alignment (root gravity). Default `center`. |

### Colors (hex strings, e.g. `#4FC3F7`)
| Field | Default | Effect |
|-------|---------|--------|
| `backgroundColor` | `#0F172A` | Widget background. |
| `valueColor` | `#4FC3F7` | Value text color (alias of `accentColor`). |
| `accentColor` | `#4FC3F7` | Alias of `valueColor`. |
| `titleColor` | `#FFFFFF` | Title text color. |
| `subtitleColor` | `#B0BEC5` | Subtitle text color. |
| `buttonColor` | `#1E293B` | Action-button background. |
| `buttonTextColor` | `#FFFFFF` | Action-button text color. |

### Typography (sp)
| Field | Effect |
|-------|--------|
| `valueSize` | Value text size (default: layout's size). |
| `titleSize` | Title text size. |
| `subtitleSize` | Subtitle text size. |

### Progress / level bar
| Field | Effect |
|-------|--------|
| `progress` | Value `0..progressMax` drawn as a horizontal `ProgressBar` (medium/large layouts). When absent the bar is hidden. |
| `progressMax` | Max of the bar (default `100`). |

### Interaction / HTML mode
| Field | Type | Effect |
|-------|------|--------|
| `action` | `string` | String identifier mapped by the host app → emits `nativeWidgetTap`. If absent, the button is hidden. |
| `actionValue` | `string` | Payload handed to the action callback. |
| `buttonLabel` | `string` | Action-button label (default `Open`). |
| `render` | `'native' \| 'html'` | `native` (default) draws preset RemoteViews. `html` renders an inline `html` string or a bundled `page` to a **snapshot bitmap**. |
| `html` | `string` | Inline HTML/CSS/JS rendered via an offscreen WebView (overrides `page`). |
| `htmlBaseUrl` | `string` | Base URL for relative assets in `html` (default the asset-loader host). |
| `widthPx` / `heightPx` | `number` | Snapshot render size in px (default `320x320`), scaled to the widget by `fitXY`. |
| `page` | `string` | When `render:'html'`, a bundled page under `public/` rendered to a snapshot. |

> **HTML mode is a static snapshot, not a live WebView.** A home-screen widget is inflated by the
> launcher from a RemoteViews whitelist, so it physically cannot host an interactive WebView. Instead
> the HTML/CSS/JS is rendered offscreen to a bitmap and shown full-bleed via `@+id/widget_html`.
> Re-trigger a widget update (e.g. `reload()` / `update()`) to refresh it. For a **live, interactive
> HTML/CSS/JS panel — animations, input, two-way messaging — use the floating overlay**
> (`showFloating`, see `docs/WIDGET_FULL_CUSTOMIZATION.md`), which is a real WebView and the true
> "design freely from HTML" target.

> `extra` is accepted as metadata but **not rendered** — the home-screen RemoteViews renderer cannot
> draw arbitrary keys. Pass the known fields above instead, or use a floating page for full HTML.

---

## 2. How it works
- `setConfig(kind, spec)` stores the spec in `WidgetStore`; `update(kind, spec)` = setConfig + reload.
- The generated `Widget_<Kind>` provider (per declared kind in `app.config.json`) reads the stored
  spec and renders via `NativeKitWidgetProvider.render()`. Every view op is wrapped in `safe()` so a
  bad value (missing view id, malformed color) is **logged and skipped** — it can never crash the app.
- **Layout resolution:** `layout` is a bundled preset (`small`/`medium`/`large`) OR any resource the
  app ships. `render()` resolves it with `getIdentifier(name, "layout", packageName)`, so a developer
  can ship their own `RemoteViews` layout (RelativeLayout + gradient drawable + ImageView + Button)
  and reference it by name. That layout only has to declare the same ids the renderer fills:
  `widget_root`, `widget_value`, `widget_title`, `widget_subtitle`, `widget_icon`, `widget_image`,
  `widget_progress`, `widget_button`. Missing ids are skipped (safe).
- Runtime `setBackgroundColor` is only applied when `backgroundColor` is passed, so a custom layout's
  own drawable background/gradient keeps its design. Same for button colors.
- Color hex parsing lives in `WidgetStore.color()` (tolerant of bad input → falls back).
- Text sizes use `RemoteViews.setFloat(viewId, "setTextSize", sp)`, the legal way to apply a float
  property — no new layout needed.
- A `progress` value draws the `@+id/widget_progress` horizontal bar present in the `medium`/`large`
  layouts (`small` has no bar; it is simply hidden).
- `image` uses `RemoteViews.setImageViewResource`; `imageData` decodes base64 → `Bitmap` →
  `setImageViewBitmap`. Both target `@+id/widget_image`.

### Free-design layout example (ship your own XML)
```xml
<!-- res/layout/my_dashboard.xml -->
<RelativeLayout ... android:id="@+id/widget_root"
    android:background="@drawable/my_bg_gradient">
  <ImageView android:id="@+id/widget_image" ... android:src="@drawable/my_badge"/>
  <TextView  android:id="@+id/widget_value" .../>
  ...
  <Button    android:id="@+id/widget_button" ... android:background="@drawable/my_btn"/>
</RelativeLayout>
```
```js
await NativeKit.widget.update('nativekit-widget', {
  layout: 'my_dashboard',   // resolved from your APK resources
  value: '42', title: 'Battery', image: 'my_badge',
  valueColor: '#4FC3F7', titleColor: '#E2E8F0',
  progress: 42, progressMax: 100, action: 'open-detail', buttonLabel: 'Open',
});
```
`widget_hero` (shipped in this repo) is a working example: RelativeLayout + gradient bg +
ImageView + rounded Button.

### HTML/CSS/JS mode (snapshot) example
```js
await NativeKit.widget.update('nativekit-widget', {
  render: 'html',
  html: '<!doctype html>...your css...<div class="v">42</div>...',
  widthPx: 320, heightPx: 160,
});
// or a bundled page:
await NativeKit.widget.update('nativekit-widget', {
  render: 'html', page: 'public/widgets/my_card.html',
});
```
The HTML is drawn to a bitmap by `HtmlWidgetRenderer` (offscreen WebView → `webView.draw(canvas)`
with `enableSlowWholeDocumentDraw()`), cached, and displayed via `@+id/widget_html` (full-bleed,
`fitXY`). A whole-widget tap opens the app. If rendering fails, the ImageView is hidden (safe).

### Where the three customization tiers land
| Target | How | Live/interactive? |
|--------|-----|-------------------|
| Floating overlay | `showFloating` with `page` or `html` — a real WebView | ✅ Yes (2-way messaging, JS, animations) |
| Home-screen widget (preset) | `layout`/colors/sizes/align/progress/image | ❌ Static |
| Home-screen widget (free layout) | own RemoteViews XML referenced by `layout` | ❌ Static |
| Home-screen widget (HTML) | `render:'html'` → WebView snapshot | ❌ Static snapshot (refresh on update) |

## 3. Example (all from web)
```js
await NativeKit.widget.update('nativekit-widget', {
  layout: 'large',
  value: '42',
  title: 'Battery',
  subtitle: 'Today',
  backgroundColor: '#052e16',
  accentColor: '#34d399',
  titleColor: '#ecfdf5',
  subtitleColor: '#6ee7b7',
  buttonColor: '#065f46',
  buttonTextColor: '#ecfdf5',
  valueSize: 64, titleSize: 16, subtitleSize: 12,
  align: 'start',
  progress: 42, progressMax: 100,
  action: 'open-detail', actionValue: '{"id":42}', buttonLabel: 'Open',
});
```

## 4. Verification
- Widget suite (`tests/widget.test.ts`) — 17 tests pass.
- `plugins/widget/android/src/main/res/layout/widget_medium.xml` & `widget_large.xml` now include
  `@+id/widget_progress`; `NativeKitWidgetProvider.render()` applies progress, colors, sizes, align.
- Types updated in `plugins/widget/index.d.ts` and `types/nativekit.d.ts.template` (`WidgetConfig` /
  `NativeKitWidgetSpec`).
- Demo in `www/app.js` (`widgetset`, `widgetinc`, `widgetstyle`) + `www/index.html` button show
  recolor / resize-text / right-align / progress live.
- Android compile verified by CI (not run locally — no `android.jar` in sandbox).
