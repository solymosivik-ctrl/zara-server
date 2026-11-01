---
name: Android Gradle verification
description: Native Expo Android build verification limits observed in this workspace.
---

An Android Gradle compile can spend several minutes configuring and compiling Expo Gradle plugins, then lose its daemon before reaching the target module. In one observed run, the log said `Gradle build daemon disappeared unexpectedly` and the cgroup reported an OOM kill; this did not prove that the target Kotlin source compiled or failed.

**Why:** A successful patch application and JavaScript typecheck do not prove native Kotlin compilation.

**How to apply:** Report the exact Gradle task reached and distinguish daemon/resource failure from Kotlin diagnostics. Do not claim native compilation succeeded unless the target module task completes.

Expo 57 autolinking can use the published Expo Audio AAR instead of the patched package source, leaving `:expo-audio:compileDebugKotlin` absent from the Gradle project graph. Set `expo.autolinking.android.buildFromSource` to include `expo-audio` when the goal is to compile and verify a local Expo Audio patch.

**Why:** A patched package file is not part of the native build if autolinking selects its prebuilt binary.

**How to apply:** Before running a patched module's Kotlin task, inspect the Gradle project list and ensure autolinking selects the source module.
