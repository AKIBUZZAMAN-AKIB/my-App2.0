# Releasing & Installing NativeKit Test builds

> This guide explains how a version tag becomes an installable Android and iOS release on GitHub,
> which file a tester should download, and how to install/verify it. It reflects the actual
> `.github/workflows/android.yml` and `.github/workflows/ios.yml`.

---

## 1. The one-command release

Release is **automatic**. You do **not** need to create a GitHub Release by hand anymore.

```bash
# 1. (optional) bump version first, then commit on main
vi app.config.json          # set app.versionName / app.versionCode / buildNumber

# 2. push main
git push origin main

# 3. create and push a version tag that matches 'v*'
git tag -a v1.4.2-testlab -m "message"
git push origin v1.4.2-testlab
```

Pushing a `v*` tag triggers the **Android** workflow, which builds debug + release APK and the AAB, then runs the
**"Publish GitHub Release (version tags only)"** step that creates the GitHub Release and attaches the artifacts.
The **iOS** workflow builds in parallel and, on the same tag, exports a signed IPA.

> Pre-release convention: `testlab` tags are published as **prereleases** (e.g. `v1.4.2-testlab`). That matches
> the existing `v1.3.x`/`v1.4.x` history.

---

## 2. What is in a release

Every GitHub **Release** (and the per-build workflow artifact) contains these four files:

| File | What it is | Do testers install it? |
|---|---|---|
| `app-release.apk` | **Signed release APK** | ✅ **Yes — this is the "install & test" file** |
| `app-debug.apk` | Debug APK (debug keystore) | ✅ Yes, also installable (for quick/local check) |
| `app-release.aab` | **Android App Bundle** | ❌ **No** — for Play-Store upload only, cannot be sideloaded |
| `SHA256SUMS.txt` | SHA-256 checksums of the above | — use to verify integrity |

**The single file to hand to a tester is `app-release.apk`.**

---

## 3. Which keys sign the release

The Android workflow sets one of two signing modes:

| Mode | When | Meaning |
|---|---|---|
| `stable` | All four `ANDROID_KEYSTORE_*` secrets are set | Signed with your real keystore → installable **AND** update-continuous across builds **AND** valid to upload to the store. **This is what's currently active.** |
| `ephemeral` | Secrets are absent | A throwaway test keystore is generated at build time → installable for testing, but **NOT** update-continuous and **NOT** store-valid. |

The release title and notes report the mode, e.g. `v1.4.2-testlab — test build (signing: stable)`. For a store
release you **must** configure the secrets so the mode is `stable`.

---

## 4. Installing & verifying on a device (Android)

1. On GitHub, open **Releases** and pick the newest version (e.g. `v1.4.2-testlab`).
2. Download **`app-release.apk`**.
3. (Recommended) Verify the checksum:
   ```bash
   # on Linux/macOS
   sha256sum app-release.apk          # compare with SHA256SUMS.txt
   # on Windows PowerShell
   Get-FileHash app-release.apk -Algorithm SHA256
   ```
4. Transfer to the phone and tap to install. Allow "install from unknown sources" if prompted.
5. Open the app. The **Sandboxed App Browser → ⚡ Quick Add** lets you upload a web component and run it.

> Do **not** install `app-release.aab`. It cannot be installed directly and is meant only for Play Console.

---

## 5. iOS builds

The iOS workflow (`ios.yml`) always compiles an unsigned simulator app for validation. A **signed IPA** is produced
only when:

- a `v*` tag is pushed, **or**
- the workflow is run manually (`workflow_dispatch`) with `create_ipa: true`.

The signed IPA export requires the iOS secrets:

- `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_EXPORT_OPTIONS_PLIST_BASE64`
- `IOS_TEAM_ID`, `IOS_CODE_SIGN_IDENTITY`

If those secrets are missing, the IPA export step fails (with a clear "Missing GitHub Actions secrets" message); the
simulator validation build still succeeds.

IPA install (TestFlight / device):
1. Open the **iOS validation and IPA** workflow run → **Artifacts** → download `ios-ipa-<sha>.zip`.
2. Extract the `.ipa` + dSYMs bundle.
3. Upload the `.ipa` to **TestFlight** or install via a device provisioning profile.

---

## 6. Signing secrets reference

### Android (`android.yml`)
| Secret | Purpose |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 of your `.jks`/`.keystore` (single line) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Set **all four** or **none**. If you send only some, the workflow fails fast ("Android signing secrets are incomplete").

### iOS (`ios.yml`)
| Secret | Purpose |
|---|---|
| `IOS_CERTIFICATE_BASE64` | Base64 of the Apple distribution `.p12` |
| `IOS_CERTIFICATE_PASSWORD` | `.p12` password |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the `.mobileprovision` |
| `IOS_EXPORT_OPTIONS_PLIST_BASE64` | Base64 of `ExportOptions.plist` |
| `IOS_TEAM_ID` | Apple Team ID (must match the profile) |
| `IOS_CODE_SIGN_IDENTITY` | e.g. `Apple Distribution` (default) |

---

## 7. Troubleshooting

- **`./gradlew: Permission denied` (exit 126)** — the repo previously committed `android/gradlew` without the
  executable bit. Now fixed and hardened: the workflow runs `chmod +x android/gradlew` before every build. If it ever
  recurs, re-add with `git update-index --chmod=+x android/gradlew`.
- **`app-release.apk` won't install** — either it's an `app-release.aab` (wrong file), or the browser blocked the
  download. Use "download" directly; on the phone allow "install unknown apps".
- **Release not created after a tag push** — check the run's **"Publish GitHub Release (version tags only)"** step.
  It only runs on `refs/tags/`. Make sure the tag actually carries the release: `git push origin v1.4.2-testlab`.
- **Failed iOS IPA export** — confirm all six iOS secrets are set. The simulator build still succeeds regardless.

---

## 8. Related docs

- [Build, Signing & CI](./BUILD-SIGNING-CI.bn.md) — deeper CI/signing mechanics.
- [Configuration](./CONFIGURATION.bn.md) — `app.versionName` / `app.versionCode` under `app`.
- [Index of docs](./INDEX.bn.md).
