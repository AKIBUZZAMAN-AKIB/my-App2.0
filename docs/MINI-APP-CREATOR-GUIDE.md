# Mini-App Creator Guide — packages, manifests, capabilities, isolation

> **Who this is for:** someone building a full mini-app (HTML/CSS/JS, a ZIP, or a web component) that runs inside the
> NativeKit **Sandboxed App Browser**. This is the deep reference for the package format, the `nativekit.manifest.json`
> schema, the capability/permission model, network modes, and isolation. For the one-file "just upload a web component"
> happy path, start with the [Web Developer Guide](./WEB-DEV-GUIDE.md).

---

## 1. What a mini-app is (trust tier #2)

NativeKit has **three** trust tiers. A mini-app is tier **#2**:

| Tier | Content | `window.NativeKit` | Example |
|---|---|---|---|
| **1 · Trusted host** | The shell's own bundled `www/` | Full host façade | The native shell UI |
| **2 · Installed mini-app** | ZIP / static files / **web component** | **Brokered** façade (capability-gated, consented, audited) | `<my-widget>` or `index.html` |
| **3 · Remote HTTPS URL** | A remote page | **None** (browser-only) | `https://example.com` |

A mini-app always runs in an isolated renderer (separate process on Android where supported, WebKit-process
isolation/partition on iOS), communicates to native code only through an authenticated chunked IPC, and every native
call is resolved against per-app policy and written to an audit log.

**Never** merge third-party code into the trusted `www/`.

---

## 2. Package formats

You can install a mini-app from:

| Source | UI | Notes |
|---|---|---|
| **ZIP** | "ZIP / files" | `assertZipMetadata` checks central-directory file count + expanded byte limits before extraction. |
| **Multi-file** | "ZIP / files" | Select several files at once; the common root path is stripped (each path normalized). |
| **Folder** | "Folder" | `webkitdirectory`; each file's relative path is kept. |
| **Single web component** | "⚡ Quick Add" | One `.js`/`.mjs`; the shell auto-synthesizes the manifest wrapper. |

Rules that apply to every package:

- Paths are normalized; `..`, absolute, and dotfile (`.hidden`) paths are **rejected**.
- Duplicate paths are rejected.
- `1`–`500` files and ≤ 15 MiB total.
- An **HTML entry** must exist: `index.html` by default, or whatever `entry` says (must end in `.html`/`.htm`).

---

## 3. `nativekit.manifest.json` — full reference

Put this at the **package root**. Everything is optional except (effectively) the entry. The shell merges it with the
install options, validates, and generates an id when you don't supply one.

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | generated | Stable lowercase dotted/dashed identifier (`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$`), ≤ 120 chars. Used as the app namespace for storage/DB/audit. |
| `name` | string | from package/entry | ≤ 80 chars, display name. |
| `version` | string | `1.0.0` | ≤ 40 chars. |
| `description` | string | `''` | ≤ 500 chars. |
| `entry` | string | `index.html` | Must exist in package and end in `.html`. |
| `requestedCapabilities` | string[] | `[]` | Which native capabilities you want. **Unknown/unsupported values throw a validation error** (they are not silently dropped); duplicates are de-duplicated. See §4. |
| `allowedHosts` | string[] | `[]` | Host policy for network (when `networkMode` is `hosts`). Supports `*.example.com` and `host:port`; an **invalid** host throws a validation error. |
| `networkMode` | `sandboxed` \| `hosts` \| `full` | `full` | See §5. |
| `colorScheme` | `dark` \| `light` | `dark` | Renderer theme. |
| `webComponent` | object | none | `{ tag, module, attributes }` — see §6. |

A complete example:

```json
{
  "id": "dev.nativekit.thirdparty.status-card",
  "name": "Native Status Web Component",
  "version": "1.0.0",
  "description": "Manifest-generated entry + Web Component example",
  "requestedCapabilities": ["appInfo", "networkStatus"],
  "allowedHosts": [],
  "networkMode": "hosts",
  "colorScheme": "dark",
  "webComponent": {
    "tag": "native-status-card",
    "module": "native-status-card.js",
    "attributes": { "heading": "Device status" }
  }
}
```

### The generated id
If you omit `id`, the shell produces `thirdparty.<safe-name>.<integrity-prefix>` — where `<integrity-prefix>` is the
first 10 hex chars of the package SHA-256. **A package id is not a signature**: if the package bytes change, the shell
**disables the app** and requires review before it can run again.

---

## 4. Capabilities & the permission model

`requestedCapabilities` is the list of native capabilities you declare. The exact set:

```
permissions, http, camera, location, backgroundLocation, haptics,
notifications, alarms, background, preferences, secureStorage, sqlite,
filesystem, fileTransfer, sharing, networkStatus, appInfo, pushNotifications, browser
```

Per app there is a **tri-state decision** for each capability and (optionally) per-method overrides:

| Decision | Meaning |
|---|---|
| `ask` | Prompt on first use; user picks one of four **settlements**. |
| `allow` | Always allow (stored). |
| `block` | Always block. |

The four settlements a pending prompt can resolve to:

| Action | Effect |
|---|---|
| `allow_once` | Allow this call only. |
| `allow_always` | Allow this call and remember it. |
| `block_once` | Block this call only. |
| `block_always` | Block this call and remember it. |

Defaults are **fail-closed**: requested capabilities default to `ask`, unrequested ones default to `block`. When a
decision is changed to block/ask, the shell also **revokes** the app's active native subscriptions/resources relating
to that capability. Live privilege changes (disable/update/remove, renderer/session loss, timeout) cause pending calls
to reject.

The host can inspect and alter all of this per-app from the shell UI, and every native call is written to the **usage
audit** (`audit.list({ appId, capability, outcome, limit })`).

---

## 5. Network modes

`networkMode` controls whether the mini-app can reach the network via ordinary web requests:

| Mode | Behavior |
|---|---|
| `sandboxed` | Network is off; remote requests are prevented up front. |
| `hosts` | Only hosts in `allowedHosts` are reachable. |
| `full` | Full internet (HTTPS/WSS + forms) is available. |

> **Security note:** `full` + camera/location/filesystem can exfiltrate native data. Grant `full` only to apps you
> trust. A missing/empty `networkMode` is treated as `full` (the historical default); malformed values fail **closed**
> to `sandboxed`.

For native network calls there is also `NativeKit.http` (browser CORS is bypassed) — but upstream TLS, auth, WAF,
rate-limiting, and IP restrictions still apply.

---

## 6. Web component mini-apps

If no `entry` exists but `webComponent` is present, the shell generates a wrapper entry for you:

```html
<!doctype html><html><head><meta charset="utf-8"></head><body>
  <native-status-card></native-status-card>
  <script type="module" src="native-status-card.js"></script>
</body></html>
```

Requirements enforced by the shell:

- `webComponent.tag` must be lowercase and contain a hyphen; `webComponent.module` must exist in the package.
- Or, via the **Quick Add** flow, the tag is auto-detected from `customElements.define('my-widget', …)`.
- `attributes` (`Record<string, string>`) are applied to the element on mount.

Use `connectedCallback()` for your async work — that's when `window.NativeKit` is available.

---

## 7. Isolation & lifecycle

- **Renderer:** the shell uses an **isolated** renderer where available (Android separate app process + authenticated
  chunked IPC; iOS WebKit-process heartbeat/replacement), with an **opaque iframe** fallback (`fallbackToIframe`). The
  mode is `appBrowser.renderer = "isolated"` and `appBrowser.isolated` config.
- **Data isolation:** preferences/secure storage/sqlite/filesystem are namespaced per app id
  (`safeRelativeDataPath`/`appDatabase`), e.g. `nativekit-app-browser/<appId>/...` and per-app databases. They are
  removed on app removal/cleanup.
- **Install/update:** re-install with a changed package **disables** the app for review. The package and its policy are
  written atomically so a crash cannot launch new code under an old enabled policy.
- **Launch/stop:** `launch(appId, host)` and the returned session's `stop()`. Stopping cleans subscriptions & owned
  native state. A hang (isolated) terminates after `hangTerminationDelayMs`.
- **usage / cleanup:** `usage(appId)` reports resource snapshot (storage, DBs, scheduled, active sessions,
  subscriptions, background location). `cleanup(appId)` removes the app's data/state **without** uninstalling the
  package; if any step fails it reports an error (not fake success) and leaves a retryable state. `remove(appId)`
  disables, revokes resources, deletes DBs/storage/files, clears the isolated package, and deletes the app/policy.

---

## 8. Limit reference

| Limit | Value |
|---|---|
| Max installed apps | 20 |
| Max files per package | 500 |
| Max package bytes | 15 MiB (15,728,640) |
| Audit log limit | 2,000 |
| Requests per minute | 120 |

> These are the **template defaults** from `app.config.json → appBrowser`; your deployment can override them in
> `app.config.json` (and they are validated against the JSON Schema). The app-browser module reads them from that
> config rather than hard-coding them.

---

## 9. Security & store-policy reminders

- Keep sensitive data out of anything visible to other users (mini-apps are isolated from each other, but think about
  the app owner).
- Native HTTP bypasses browser CORS but not server-side policy.
- Leave `allowDirectWebNetwork` / network modes restrictive unless a specific endpoint is required.
- Follow the trust-boundary and "golden rules" in [Security Policy](./SECURITY-POLICY.bn.md).

---

## 10. Related docs

- [Web Developer Guide](./WEB-DEV-GUIDE.md) — the one-file quick-add path.
- [Quick Start Checklist](./QUICK-START.md).
- [API Reference](./API-REFERENCE.bn.md) — the brokered `window.NativeKit` surface.
