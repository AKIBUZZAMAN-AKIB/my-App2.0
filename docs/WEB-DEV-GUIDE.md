# Web Developer Guide — ship a web component, done

> **Who this is for:** a web developer who has a working web component (a single `customElements.define()` module)
> and wants it running inside the NativeKit app with zero wiring. If you already know HTML/CSS/JS, you can go from
> "I have a component" to "it's running and can call device APIs" in about a minute.

The goal of this path is **drop-in simplicity**: you upload **one file** and the shell handles the manifest, the entry
page, install, launch, and the native-API consent prompt for you. You do not write any NativeKit-specific packaging,
manifest, or bridge code.

---

## 1. The one-minute path ("⚡ QUICK ADD")

The shell ships a **Sandboxed App Browser** that hosts third-party mini-apps. Inside it there is a dedicated
**⚡ QUICK ADD — Web Component** box.

1. Open the app and scroll to **Sandboxed App Browser → ⚡ Quick Add**.
2. Pick **one** of your web component files — a `.js` or `.mjs` module.
3. The shell reads the file, finds your tag, and pre-fills **Custom element tag**.
   - If it can't find the tag, it tells you — type the tag in the box (must be lowercase, with a hyphen).
4. Optional: give it a **Display name**.
5. Press **Install & run**.

That's it. The shell then:

- auto-detects the tag, e.g. `customElements.define('my-widget', …)` → tag `my-widget`;
- synthesizes an `nativekit.manifest.json` for you (id, name, version, `webComponent`);
- generates a tiny entry page that mounts `<my-widget>` and loads your module;
- installs it as a mini-app (with a generated id like `nativekit.quick.my-widget`);
- launches it in the isolated renderer;
- shows the per-app **API policy** screen, where the first native call will ask for consent (default: `ask`).

You can freely re-upload the same component later — it updates the same id (and, because the package changed, the shell
**disables it for re-review**; enable it again from its policy page).

### If you upload an `.html` file instead
The shell treats it as a plain mini-app **page** (no custom element). The file becomes the entry. Same install/run flow,
no tag needed.

---

## 2. The web component contract

Your component must be a **custom element** that the shell can mount:

- Register it with `customElements.define('my-tag', MyClass)` at module top level.
- The tag must be **lowercase and contain a hyphen** (this is enforced — the shell parses `nativekit.manifest.json`
  too, and the wrapper entry relies on it).
- Your module is loaded as `<script type="module" src="your-module.js">` by the generated entry page, so keep asset
  paths **relative** to the file.
- Do your async work in `connectedCallback()`. That's when `window.NativeKit` is available.

Example (`native-status-card.js`) — this is the reference component in the repo
(`examples/app-browser-web-component/native-status-card.js`):

```js
class NativeStatusCard extends HTMLElement {
  async connectedCallback() {
    this.style.cssText = 'display:block;font:16px system-ui;background:#071827;color:#e8f3ff;min-height:100vh;padding:32px;box-sizing:border-box';
    this.textContent = 'Loading…';
    try {
      const [app, network] = await Promise.all([NativeKit.app.info(), NativeKit.network.status()]);
      this.innerHTML = '';
      const title = document.createElement('h2');
      title.textContent = this.getAttribute('heading') || 'Device status';
      const output = document.createElement('pre');
      output.textContent = JSON.stringify({ app, network, identity: NativeKit.appIdentity }, null, 2);
      this.append(title, output);
    } catch (error) {
      this.textContent = `Policy denied or unavailable: ${error.message}`;
    }
  }
}
customElements.define('native-status-card', NativeStatusCard);
```

`window.NativeKit` is **injected** by the shell into the mini-app and is the **brokered** façade — it is not the raw
Capacitor runtime. It requires (and is subject to) per-app consent/policy. See §4.

---

## 3. When one file isn't enough

The quick-add flow is intentionally minimal. To control identity, network, or requested capabilities you have two
options:

1. **Add a `nativekit.manifest.json`** beside your component (the shell reads it automatically — see
   [Mini-App Creator Guide](./MINI-APP-CREATOR-GUIDE.md) for the full field list).
2. Or, if your component was registered via the quick-add box and you just want a few manifest fields, install it with
   a hand-written manifest via the normal **Install / update** box (ZIP or folder) instead.

A minimal manifest that mirrors what quick-add generates:

```json
{
  "id": "nativekit.quick.my-widget",
  "name": "My Widget",
  "version": "1.0.0",
  "description": "A quick-added web component",
  "requestedCapabilities": [],
  "allowedHosts": [],
  "webComponent": {
    "tag": "my-widget",
    "module": "my-widget.js",
    "attributes": { "heading": "Device status" }
  }
}
```

> `attributes` are applied to `<my-widget>` as HTML attributes on mount, so you can read them with
> `this.getAttribute('heading')` in `connectedCallback()`.

---

## 4. Calling device APIs (the brokered `window.NativeKit`)

Inside a mini-app you get a restricted `window.NativeKit`. Two entry points:

```js
await window.NativeKit.ready();            // or listen for the 'nativekitready' event
const info = await window.NativeKit.app.info();
```

Things to know:

- **You are not in the trusted host.** You only get methods that are in the **capability** model, and each one goes
  through the app-browser broker: it resolves against per-app policy (ask / stored allow / block) and is **audited**.
- Defaults are fail-closed for anything the component didn't request: requested capabilities default to `ask`,
  unrequested ones default to `block`. The app owner (or the test lab) can flip these per-app in **API policy**.
- Capabilities you can request in the manifest (exact set):
  `permissions`, `http`, `camera`, `location`, `backgroundLocation`, `haptics`, `notifications`, `alarms`,
  `background`, `preferences`, `secureStorage`, `sqlite`, `filesystem`, `fileTransfer`, `sharing`, `networkStatus`,
  `appInfo`, `pushNotifications`, `browser`.
- Data you write via `preferences`/`secureStorage`/`sqlite`/`filesystem` is **namespaced to your app id** and is
  removed when the app is removed. It is **not** shared with other mini-apps.

The full method surface, parameter shapes, quotas, and examples are in [API-REFERENCE.bn.md](./API-REFERENCE.bn.md).

---

## 5. Sizing & limits

| Limit | Value |
|---|---|
| Max installed apps | 20 |
| Max files per package | 500 |
| Max package size | 15 MiB (15,728,640 bytes) |
| Entry | must be `index.html` or set via `entry`; quick-add generates `__nativekit_component__.html` for you |
| Custom-element tag | lowercase, hyphenated (e.g. `my-widget`) |

These values are the current template defaults and are read from `app.config.json → appBrowser`; a deployment can
raise or lower them in its own config.

ZIPs are checked for metadata (central-directory limits, expanded byte limits) before extraction. Duplicate package
paths, path traversal (`../`, absolute, hidden), and non-HTML entries are rejected.

---

## 6. Troubleshooting

- **"No custom-element tag detected"** — your module doesn't register a hyphenated tag at top level
  (`customElements.define('my-widget', …)`). Either add it, or type the tag in the box (or pass `tag` explicitly).
- **"Feature is disabled in app.config.json: appBrowser"** — the shell config has `features.appBrowser: false` or
  `appBrowser.enabled: false`; no mini-apps can run.
- **Component shows "Policy denied or unavailable: …"** — a native call was blocked (or is pending an `ask`).
  Open the app's **API policy** and allow it, or review the **pending approvals** list.
- **Re-uploaded a changed package and it's disabled** — intended: a changed package is treated as unreviewed. Enable it
  again from **API policy** after you've verified it.
- **The app window doesn't appear** — check the **Host Event Log** for a launch error; confirm the entry path resolves.

---

## 7. Where to go next

- [Mini-App Creator Guide](./MINI-APP-CREATOR-GUIDE.md) — full package/manifest/capability/network reference.
- [Quick Start Checklist](./QUICK-START.md) — a step-by-step get-to-green checklist.
- [API Reference](./API-REFERENCE.bn.md) — every `window.NativeKit` method, with examples.
- [Security Policy](./SECURITY-POLICY.bn.md) — trust boundaries and the "golden rules".
