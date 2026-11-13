#!/usr/bin/env bash
# Records and checks which revision of the vendored Rust crate the committed
# native binaries were built from.
#
# Why: the Android .so slices and the iOS xcframework are rebuilt by CI
# (native-agent-ffi.yml, ios-agent-xcframework.yml) *after* a push that changes
# plugins/native-agent/rust/**, and committed back as a separate commit. The
# push itself therefore always carries binaries built from the previous crate.
# Before this stamp existed nothing noticed that:
#   - "iOS validation and IPA" failed to compile on 7d106f5 (the bindings
#     called uniffi_native_agent_ffi_checksum_method_nativeagenthandle_subagents,
#     which the old xcframework did not have), and the xcframework/bindings
#     identity test failed all three app workflows on e7f456b;
#   - "Android APK and AAB" published Release build-9 from 7d106f5 with an
#     arm64 .so that lacked the subagents symbols the Kotlin bindings check at
#     load time, and builds 13-15 with engines older than their own commits.
#
# The stamp is the git tree id of plugins/native-agent/rust/native-agent-ffi
# at the commit the binaries were built from. Comparing it with the tree at
# HEAD tells whether the binaries are current, with no build and no macOS.
#
# Usage:
#   ffi-source-stamp.sh tree                 print the crate tree id at HEAD
#   ffi-source-stamp.sh write android|ios    write the stamp for that platform
#   ffi-source-stamp.sh check android|ios    exit 0 when current, 1 when stale
#
# `check` also writes fresh=true|false (and stamp/tree) to $GITHUB_OUTPUT when
# it is set, so a workflow can gate steps on it.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
crate="plugins/native-agent/rust/native-agent-ffi"

stamp_path() {
  case "$1" in
    android) echo "$root/plugins/native-agent/android/FFI_SOURCE_TREE" ;;
    ios)     echo "$root/plugins/native-agent/ios/Frameworks/FFI_SOURCE_TREE" ;;
    *) echo "unknown platform '$1' (android|ios)" >&2; exit 2 ;;
  esac
}

crate_tree() {
  git -C "$root" rev-parse "HEAD:$crate"
}

cmd="${1:-}"
case "$cmd" in
  tree)
    crate_tree
    ;;
  write)
    platform="${2:?platform required (android|ios)}"
    file="$(stamp_path "$platform")"
    crate_tree > "$file"
    echo "stamped $platform binaries as built from crate tree $(cat "$file")"
    ;;
  check)
    platform="${2:?platform required (android|ios)}"
    file="$(stamp_path "$platform")"
    tree="$(crate_tree)"
    stamp=""
    [[ -f "$file" ]] && stamp="$(tr -d '[:space:]' < "$file")"
    fresh=false
    [[ -n "$stamp" && "$stamp" == "$tree" ]] && fresh=true
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      { echo "fresh=$fresh"; echo "stamp=${stamp:-none}"; echo "tree=$tree"; } >> "$GITHUB_OUTPUT"
    fi
    if [[ "$fresh" == true ]]; then
      echo "$platform native binaries are current: built from crate tree $tree"
      exit 0
    fi
    echo "$platform native binaries are stale: built from crate tree ${stamp:-unknown (no stamp)}, HEAD has $tree"
    exit 1
    ;;
  *)
    sed -n '2,28p' "$0"
    exit 2
    ;;
esac
