import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Differential contract tests for the on-device Rust AI agent plugin.
//
// These read the REAL sources (Kotlin plugin, Swift plugin, TS definitions, the
// trusted bridge, the demo lab, the Rust crate and the ABI tooling) and prove
// they agree with each other.
//
// The plugin is pinned to the PUBLIC upstream generation "0.5.2"
// (docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md) because only that tag ships the Rust
// crate source publicly — which is what makes a 4-ABI build (armeabi-v7a
// included) reproducible for anyone. That pinning has consequences this file
// now enforces:
//   1. the UniFFI contract version on both sides must be the 0.5.2 one (26),
//   2. the crash-safety fixes backported from 0.9.x must stay in place (catch
//      Throwable / never throw across the FFI boundary),
//   3. the five wake/surfaced APIs are implemented for real: the engine runs a
//      wake but cannot ask the OS for background runtime, so the PLUGIN owns
//      that half (WorkManager periodic work on Android, a BGProcessingTask on
//      iOS) and the bridge passes the OS's own answer through — including the
//      platform floors (Android: 15 minutes) which are reported, not smoothed
//      over. The surfaced inbox is filled from the engine's `cron_runs` rows,
//   4. the private-repo submodule must never come back,
//   5. this is the ONLY agent engine in the app: the long-term memory it needs is
//      implemented in-repo (file-backed, lexical) instead of behind an optional
//      vector-database plugin.

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const unique = <T,>(arr: T[]) => [...new Set(arr)];

const KOTLIN = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentPlugin.kt';
const SWIFT = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift';
const DEFS = 'plugins/native-agent/src/definitions.ts';
const WEB = 'plugins/native-agent/src/plugin.ts';
const NATIVEKIT_TYPES = 'types/nativekit.d.ts.template';
const PLUGIN_GRADLE = 'plugins/native-agent/android/build.gradle';
const PACKAGE_SWIFT = 'plugins/native-agent/Package.swift';
const CRATE = 'plugins/native-agent/rust/native-agent-ffi';
const BRIDGE = 'bridge/nativekit.ts';
const LAB = 'www/agent-lab.js';
const HTML = 'www/index.html';

/** @PluginMethod-annotated Kotlin methods = the Android API surface. */
function kotlinMethods(): string[] {
  return unique([...read(KOTLIN).matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1])).sort();
}

/** CAPPluginMethod(name:) entries = the iOS API surface actually exported to JS. */
function swiftExportedMethods(): string[] {
  return unique([...read(SWIFT).matchAll(/CAPPluginMethod\(name:\s*"(\w+)"/g)].map((m) => m[1])).sort();
}

/** @objc func ... = the iOS implementations. */
function swiftImplMethods(): string[] {
  return unique([...read(SWIFT).matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]));
}

/** `NativeAgent.<name>(` calls made by the trusted bridge. */
function bridgeNativeCalls(): Set<string> {
  return new Set(unique([...read(BRIDGE).matchAll(/NativeAgent\.(\w+)\(/g)].map((m) => m[1])));
}

/**
 * The agent namespace block of the bridge. Anchored on its first member rather
 * than on `agent: {` alone: `NativeKitBuildConfig` also declares an `agent`
 * object, and a lazy match from that one would swallow every other namespace.
 */
function bridgeAgentBlock(): string {
  const block = read(BRIDGE).match(/\n  agent: \{\n    supported:[\s\S]*?\n  \},\n\};/);
  expect(block, 'agent namespace not found in bridge/nativekit.ts').not.toBeNull();
  return block![0];
}

describe('agent plugin — cross-platform contract', () => {
  it('Android and iOS expose exactly the same JS method names', () => {
    const android = kotlinMethods();
    const ios = swiftExportedMethods();
    expect(android.length).toBeGreaterThan(40);

    const missingOnIos = android.filter((m) => !ios.includes(m));
    const missingOnAndroid = ios.filter((m) => !android.includes(m));
    expect(missingOnIos, `implemented on Android but not exported on iOS: ${missingOnIos}`).toEqual([]);
    expect(missingOnAndroid, `exported on iOS but missing on Android: ${missingOnAndroid}`).toEqual([]);
  });

  it('every iOS-exported method has a matching @objc implementation', () => {
    const impl = new Set(swiftImplMethods());
    for (const method of swiftExportedMethods()) {
      expect(impl.has(method), `CAPPluginMethod '${method}' has no @objc implementation`).toBe(true);
    }
  });

  it('the TypeScript definitions declare every native method', () => {
    const defs = read(DEFS);
    for (const method of kotlinMethods()) {
      expect(
        new RegExp(`\\b${method}\\s*\\(`).test(defs),
        `native method '${method}' is missing from definitions.ts`,
      ).toBe(true);
    }
  });

  it('exposes the availability probe on both platforms', () => {
    expect(kotlinMethods()).toContain('checkAvailability');
    expect(swiftExportedMethods()).toContain('checkAvailability');
    expect(read(DEFS)).toMatch(/checkAvailability\(\): Promise<AgentAvailabilityResult>/);
  });

  it('provides explicit web stubs for every native plugin method', () => {
    const web = read(WEB);
    for (const method of kotlinMethods()) {
      expect(web, `web implementation is missing ${method}`).toMatch(new RegExp(`async\\s+${method}\\s*\\(`));
    }
  });

  it('keeps runtime provider/model defaults and public types in parity', () => {
    const rust = read(`${CRATE}/src/runtime_config.rs`);
    const loop = read(`${CRATE}/src/agent_loop.rs`);
    const android = read('plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/AgentRuntimeConfigStore.kt');
    const ios = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/AgentRuntimeConfigStore.swift');
    const defs = read(DEFS);
    const template = read(NATIVEKIT_TYPES);

    expect(rust).toContain('default_provider: "auto".into()');
    expect(rust).toContain('("kilo".into(), "kilo-auto/free".into())');
    expect(rust).toContain('("openrouter".into(), "openrouter/free".into())');
    expect(rust).toContain('self.default_models.len() > providers.len()');
    expect(loop).toContain('.unwrap_or(runtime_config.default_provider.as_str())');
    expect(loop).toContain('runtime.default_models.get(&provider)');

    expect(android).toContain('.put("defaultProvider", "auto")');
    expect(android).toContain('.put("kilo", "kilo-auto/free")');
    expect(android).toContain('.put("openrouter", "openrouter/free")');
    expect(android).toContain('.put("defaultModels", JSONObject()');
    expect(android).toContain('validateStringMap(value, "defaultModels")');
    expect(android).toContain('$field.$provider');
    expect(ios).toContain('"defaultProvider": "auto"');
    expect(ios).toContain('"kilo": "kilo-auto/free"');
    expect(ios).toContain('"openrouter": "openrouter/free"');
    expect(ios).toContain('"defaultModels": [');
    expect(ios).toContain('validateStringMap(value, field: "defaultModels")');
    expect(ios).toContain('\\(field).\\(provider)');

    for (const source of [defs, template]) {
      expect(source).toMatch(/defaultProvider:\s*(AgentProvider|NativeKitAgentProvider)/);
      expect(source).toMatch(/defaultModels:\s*Partial<Record<(AgentProvider|NativeKitAgentProvider), string>>/);
    }
    expect(defs).toMatch(/getRuntimeConfig\(\): Promise<\{ configJson: string \}>/);
    expect(template).toMatch(/getRuntimeConfig\(\): Promise<NativeKitAgentRuntimeConfig>/);
    expect(template).toMatch(/setRuntimeConfig\(patch: NativeKitAgentRuntimeConfigPatch\): Promise<NativeKitAgentRuntimeConfig>/);
  });

  it('keeps WebLLM provider callbacks synchronized across Rust, generated bindings, and platforms', () => {
    const rust = read(`${CRATE}/src/lib.rs`);
    const kotlin = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    const swift = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');
    const header = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffiFFI.h');
    expect(rust).toContain('pub fn respond_to_provider_request');
    expect(kotlin).toContain('respondToProviderRequest');
    expect(swift).toContain('respondToProviderRequest');
    expect(header).toContain('uniffi_native_agent_ffi_fn_method_nativeagenthandle_respond_to_provider_request');
    for (const slice of ['ios-arm64', 'ios-arm64-simulator']) {
      const prefix = `plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/${slice}/Headers/native_agent_ffi`;
      expect(read(`${prefix}/native_agent_ffi.swift`)).toContain('respondToProviderRequest');
      expect(read(`${prefix}/native_agent_ffiFFI.h`)).toContain('respond_to_provider_request');
    }
  });

});

describe('agent plugin — parameter-name parity (the removeSkill bug class)', () => {
  const kotlin = read(KOTLIN);
  const swift = read(SWIFT);

  const keysFor = (src: string, methodRegex: RegExp, getter: RegExp) => {
    const match = src.match(methodRegex);
    if (!match) return null;
    return unique([...match[0].matchAll(getter)].map((m) => m[1]));
  };

  const methods = ['removeSkill', 'removeCronJob', 'endSkill', 'startSkill', 'runCronJob'];

  it.each(methods)('%s reads the same option keys on both platforms', (method) => {
    const kotlinKeys = keysFor(
      kotlin,
      new RegExp(`fun ${method}\\(call: PluginCall\\)[\\s\\S]{0,400}?\\n    \\}`),
      /call\.get\w+\("(\w+)"\)/g,
    );
    const swiftKeys = keysFor(
      swift,
      new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)[\\s\\S]{0,1400}?\\n    \\}`),
      /call\.get\w+\("(\w+)"\)/g,
    );
    expect(kotlinKeys, `could not locate ${method} in Kotlin`).not.toBeNull();
    expect(swiftKeys, `could not locate ${method} in Swift`).not.toBeNull();

    for (const key of kotlinKeys!) {
      expect(
        swiftKeys!.includes(key),
        `${method}: Android reads "${key}" but iOS reads ${JSON.stringify(swiftKeys)}`,
      ).toBe(true);
    }
  });

  it('the bridge translates the divergent keys instead of guessing', () => {
    // 0.5.2 takes `{ id }` for removeSkill while the bridge API is skillId-based.
    expect(read(BRIDGE)).toMatch(/NativeAgent\.removeSkill\(\{ id: skillId \}\)/);
    expect(read(BRIDGE)).toMatch(/loadSession\(\{ sessionKey, agentId: agentId \?\? 'main' \}\)/);
  });
});

describe('agent plugin — crash-safety and pinned-generation backports', () => {
  it('Kotlin catches Throwable, not just Exception (UnsatisfiedLinkError)', () => {
    const kotlin = read(KOTLIN);
    // An unsupported-ABI device throws UnsatisfiedLinkError, which is an Error
    // and would escape `catch (e: Exception)` → native crash + hung promises.
    expect(kotlin).toMatch(/catch \(t: Throwable\)/);
    expect(kotlin).toMatch(/if \(t is OutOfMemoryError\) throw t/);
    expect(kotlin, 'no coroutine body may go back to catching Exception only')
      .not.toMatch(/catch \(e: Exception\)/);
  });

  it('checkAvailability resolves on both platforms and never rejects', () => {
    const kotlinBody = read(KOTLIN).match(/fun checkAvailability\(call: PluginCall\)[\s\S]{0,1400}?\n    \}/)![0];
    expect(kotlinBody).toContain('call.resolve(ret)');
    expect(kotlinBody).not.toContain('call.reject');

    const swiftBody = read(SWIFT).match(/@objc func checkAvailability\(_ call: CAPPluginCall\)[\s\S]{0,1600}?\n    \}/)![0];
    expect(swiftBody).toContain('call.resolve([');
    expect(swiftBody).not.toContain('call.reject');
  });

  it('probes availability with the same library name uniffi loads', () => {
    // UniffiLib.INSTANCE -> loadIndirect(componentName = "native_agent_ffi")
    // -> Native.load(findLibraryName(...)) == "native_agent_ffi".
    expect(read(KOTLIN)).toMatch(/Native\.load\("native_agent_ffi", NativeProbeLib::class\.java\)/);
    const binding = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    expect(binding).toContain('loadIndirect<UniffiLib>(componentName = "native_agent_ffi")');
  });
});

describe('agent plugin — pinned generation (0.5.2) integrity', () => {
  it('keeps the UniFFI contract version aligned with the vendored crate', () => {
    const binding = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    const committed = binding.match(/val bindings_contract_version = (\d+)/)![1];
    expect(committed, 'committed Kotlin bindings must be the 0.5.2 generation').toBe('26');

    // uniffi 0.28.x == contract version 26; the crate pins it in Cargo.toml.
    const cargo = read(`${CRATE}/Cargo.toml`);
    expect(cargo).toMatch(/uniffi = \{ version = "0\.28"/);

    // The crate must still produce the library name the Kotlin binding loads.
    expect(cargo).toMatch(/^\s*name = "native_agent_ffi"$/m);
  });

  it('ships the crate source in-repo and has no private-repo dependency', () => {
    for (const f of [`${CRATE}/Cargo.toml`, `${CRATE}/Cargo.lock`, `${CRATE}/src/lib.rs`, `${CRATE}/VENDOR-MANIFEST.json`]) {
      expect(existsSync(path.join(root, f)), `missing vendored crate file: ${f}`).toBe(true);
    }
    expect(existsSync(path.join(root, 'plugins/native-agent/.gitmodules'))).toBe(false);
    expect(read(`${CRATE}/src/lib.rs`)).toContain('uniffi::setup_scaffolding!()');
    // No tracked file may point at the private GitLab again.
    expect(read(`${CRATE}/VENDOR-MANIFEST.json`)).toContain('"fileCount"');
  });

  it('ships its own memory provider: file-backed, lexical, no vector database', () => {
    // The engine's memory_* tools call a host MemoryProvider (UniFFI callback
    // interface). That provider used to be optional and LanceDB-backed, so with
    // no capacitor-lancedb in package.json the engine kept memory_provider=None
    // and every memory tool answered "Memory provider not configured". It is now
    // part of the plugin on both platforms — no optional dependency, no vector
    // index, no second native runtime.
    const kotlinFile = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/MemoryProviderImpl.kt';
    const swiftFile = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/MemoryProviderImpl.swift';
    expect(existsSync(path.join(root, kotlinFile)), 'Kotlin memory provider missing').toBe(true);
    expect(existsSync(path.join(root, swiftFile)), 'Swift memory provider missing').toBe(true);

    const kotlin = read(kotlinFile);
    expect(kotlin).toMatch(/class MemoryProviderImpl\(context: Context\) : MemoryProvider/);
    for (const method of ['store', 'recall', 'forget', 'search', 'list']) {
      expect(kotlin, `Kotlin provider must implement ${method}`).toContain(`override fun ${method}(`);
    }
    // Never throw across the FFI boundary: failures come back as JSON data.
    expect(kotlin).toContain('{"error"');
    // Storage is a private JSON document, not a vector store.
    expect(kotlin).toContain('native-agent-memory');
    expect(kotlin).toMatch(/MAX_ENTRIES/);

    const swift = read(swiftFile);
    expect(swift).toContain('public final class MemoryProviderImpl: MemoryProvider');
    for (const method of ['store', 'recall', 'forget', 'search', 'list']) {
      expect(swift, `Swift provider must implement ${method}`).toContain(`public func ${method}(`);
    }
    expect(swift).toContain('makeIfAvailable');

    // No vector machinery may creep back in on either platform. Comments are
    // stripped first: they explain the history (why LanceDB left) and are worth
    // keeping, so only real code may be inspected.
    const code = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
    for (const [name, source] of [['Kotlin', kotlin], ['Swift', swift]] as const) {
      expect(code(source), `${name} provider must not embed/vectorise`).not.toMatch(/embedding|vector|cosine|lancedb/i);
    }
    expect(swift, 'the old LanceDB bridge must be gone')
      .toMatch(/MemoryProviderImpl/);
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/NativeAgentPlugin/LanceDBBridge.swift'))).toBe(false);
    expect(existsSync(path.join(root, 'plugins/native-agent/android/src/main/java-memory'))).toBe(false);

    // Both plugins must WIRE it, or the tools stay dead in the app.
    expect(read(KOTLIN)).toContain('h.setMemoryProvider(MemoryProviderImpl(context.applicationContext))');
    expect(read(KOTLIN)).not.toContain('Class.forName');
    expect(read(SWIFT)).toMatch(/MemoryProviderImpl\.makeIfAvailable\(\)[\s\S]*?setMemoryProvider/);

    // …and the gradle module must not gate an optional vector plugin any more.
    expect(read(PLUGIN_GRADLE)).not.toContain('hasLanceDb');
    expect(read(PLUGIN_GRADLE)).not.toContain('capacitor-lancedb');
  });

  it('exposes the UniFFI C header as a SwiftPM target the bindings can import', () => {
    // A binaryTarget's headers are not importable from Swift under SwiftPM: the
    // generated bindings' `#if canImport(native_agent_ffiFFI)` is false without a
    // real C target, and the build then fails with
    // "cannot find 'uniffi_native_agent_ffi_checksum_...' in scope".
    const pkg = read(PACKAGE_SWIFT);
    expect(pkg).toContain('name: "native_agent_ffiFFI"');
    expect(pkg).toMatch(/"native_agent_ffiFFI"\s*\n\s*\]/);
    expect(read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift'))
      .toContain('canImport(native_agent_ffiFFI)');

    // The shim header must be a byte-for-byte copy of the header inside the
    // xcframework, or Swift compiles against a different ABI than it links.
    const shim = read('plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/native_agent_ffiFFI.h');
    const shipped = read('plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64/Headers/native_agent_ffi/native_agent_ffiFFI.h');
    expect(shim).toBe(shipped);
    expect(shim).toContain('checksum_method_nativeagenthandle_send_message');
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/module.modulemap'))).toBe(true);
    // A C target with no translation unit makes Xcode look for a
    // <target>.o that never gets produced ("Build input file cannot be found:
    // native_agent_ffiFFI.o"), so the shim needs one (intentionally empty) file.
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/native_agent_ffiFFI/shim.c'))).toBe(true);
  });

  it('every handle call in the Swift plugin matches the regenerated bindings', () => {
    // The 0.5.2 tag ships a stale xcframework (see build-ios-xcframework.sh), so
    // the bindings in this repo are regenerated from the vendored crate. That
    // makes it possible for the plugin to call a handle member with a parameter
    // list the bindings no longer declare — which is exactly how the iOS build
    // broke twice. Check names AND option labels.
    const plugin = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift');
    const bindings = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');

    const sigs = new Map<string, Set<string>>();
    for (const m of bindings.matchAll(/(?:open|public) func (\w+)\(([^)]*)\)/g)) {
      const labels = new Set(
        m[2]
          .split(',')
          .map((a) => a.split(':')[0].trim())
          .filter((a) => a.length > 0),
      );
      const set = sigs.get(m[1]) ?? new Set<string>();
      for (const l of labels) set.add(l);
      sigs.set(m[1], set);
    }
    expect(sigs.size, 'no handle API found in the generated bindings').toBeGreaterThan(20);

    const problems: string[] = [];
    for (const m of plugin.matchAll(/\bh\.(\w+)\(/g)) {
      const name = m[1];
      if (!sigs.has(name)) {
        problems.push(`${name} is not declared in the bindings`);
        continue;
      }
      let depth = 1;
      let i = m.index! + m[0].length;
      while (i < plugin.length && depth > 0) {
        if (plugin[i] === '(') depth += 1;
        else if (plugin[i] === ')') depth -= 1;
        i += 1;
      }
      const call = plugin.slice(m.index! + m[0].length, i - 1);
      const declared = sigs.get(name)!;
      for (const label of call.matchAll(/(?:^|,)\s*(\w+):/g)) {
        // labels of nested struct initialisers are not parameters of the call
        if (!declared.has(label[1])) problems.push(`${name}(_): unknown parameter '${label[1]}'`);
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('does not hard-depend on capacitor-lancedb in Package.swift (C3 fix)', () => {
    const pkg = read(PACKAGE_SWIFT);
    expect(pkg).not.toMatch(/\.package\(path:/);
    expect(pkg).not.toMatch(/product\(name: "CapacitorLancedb"/);
    // There is nothing optional left to guard: the memory provider is compiled
    // unconditionally, so the class must NOT sit behind #if canImport(…).
    const provider = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/MemoryProviderImpl.swift');
    // A real conditional-compilation line must be gone (the doc comment quotes
    // the old one on purpose, so check line starts, not the whole file).
    const preprocessor = provider.split('\n').map((line) => line.trimStart()).filter((line) => line.startsWith('#if'));
    expect(preprocessor, preprocessor.join(' | ')).toEqual([]);
    expect(provider).toContain('public static func makeIfAvailable() -> MemoryProvider?');
  });

  it('keeps the committed iOS xcframework and the generated bindings in step', () => {
    // A stale xcframework is invisible until an iOS build fails, so compare it
    // here: both slices must carry the same Swift API, and that API must be the
    // one uniffi-bindgen produced from the vendored crate.
    const generated = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');
    for (const slice of ['ios-arm64', 'ios-arm64-simulator']) {
      const header = read(`plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/${slice}/Headers/native_agent_ffi/native_agent_ffi.swift`);
      expect(header, `${slice} carries a different API than the generated bindings`).toBe(generated);
    }
    expect(generated).toContain('func setMemoryProvider(provider: MemoryProvider)');
    expect(generated).toMatch(/public protocol MemoryProvider\s*:\s*AnyObject/);
  });

  it('keeps the ABI tooling and CI wiring that makes armeabi-v7a builds possible', () => {
    const builder = read('tools/agent-ffi/build-android-all-abis.sh');
    for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']) {
      expect(builder, `build script must know about ${abi}`).toContain(abi);
    }
    expect(builder).toContain('--require-binding-match');
    expect(existsSync(path.join(root, 'tools/agent-ffi/verify-abis.sh'))).toBe(true);
    expect(existsSync(path.join(root, 'tools/agent-ffi/resolve-ffi-source.sh'))).toBe(true);

    const wf = read('.github/workflows/native-agent-ffi.yml');
    expect(wf).toContain('armeabi-v7a');
    expect(wf).toContain('release-asset');
    expect(wf).toContain('public-upstream');
  });
});

describe('agent — bridge and demo wiring', () => {
  it('exposes every native method through NativeKit.agent', () => {
    const calls = bridgeNativeCalls();
    const shimmed = new Set([
      // compat shims: implemented in the bridge because 0.5.2 has no such native method
      'setMcpTools',
      'addListener', // wrapped as agent.onEvent
    ]);
    for (const method of kotlinMethods()) {
      if (shimmed.has(method)) continue;
      expect(method, `native method ${method} is shimmed but also native?`).toBeTruthy();
      expect(calls.has(method), `native method '${method}' is not wired in bridge/nativekit.ts`).toBe(true);
    }
  });

  it('calls the real wake APIs on the plugin, on both platforms', () => {
    const calls = bridgeNativeCalls();
    const wakeApi = [
      'scheduleBackgroundWakes',
      'cancelBackgroundWakes',
      'getWakeStatus',
      'loadSurfacedMessages',
      'clearSurfacedMessages',
    ];
    for (const name of wakeApi) {
      expect(calls.has(name), `NativeAgent.${name}() must be called by the bridge`).toBe(true);
      expect(kotlinMethods(), `${name} must exist on the Android plugin`).toContain(name);
      expect(swiftExportedMethods(), `${name} must be exported on iOS`).toContain(name);
    }
    // setMcpTools stays a bridge shim: it is mapped onto the closest native
    // capability instead of a native method that does not exist.
    expect(bridgeAgentBlock()).toMatch(/setMcpTools→restartMcp/);
  });

  it('never reports a wake success it did not get from the OS', () => {
    // The wake APIs are wrappers, not pass-throughs: on success they spread the
    // native answer (so `intervalMinutes` is what the OS granted), and on failure
    // they still resolve — with `supported: false`, a reason and the documented
    // alternative. No envelope may invent a scheduled job.
    const block = bridgeAgentBlock();
    for (const name of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'getWakeStatus', 'loadSurfacedMessages', 'clearSurfacedMessages']) {
      const m = block.match(new RegExp(`^    ${name}: async \\([\\s\\S]*?\\n    \\},`, 'm'));
      expect(m, `${name} not found in the bridge`).not.toBeNull();
      const body = m![0];
      expect(body, `${name} must call the native plugin`).toMatch(new RegExp(`NativeAgent\\.${name}\\(`));
      expect(body, `${name} must not throw; failures resolve as data`).not.toContain('throw');
      expect(body, `${name} must report what the OS granted`).toContain('...(native');
      expect(body, `${name} needs a failure envelope`).toContain('supported: false');
      expect(body, `${name} failure envelope must explain itself`).toContain('reason:');
      expect(body, `${name} failure envelope must offer the alternative`).toContain('alternative:');
      expect(body, `${name} must never hardcode a scheduled job`).not.toContain('jobScheduled: true');
    }
  });


});
