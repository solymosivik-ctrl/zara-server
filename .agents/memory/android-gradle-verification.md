---
name: Android Gradle verification
description: Native Expo Android build verification limits observed in this workspace.
---

An Android Gradle compile can spend several minutes configuring and compiling Expo Gradle plugins, then lose its daemon before reaching the target module. In one observed run, the log said `Gradle build daemon disappeared unexpectedly` and the cgroup reported an OOM kill; this did not prove that the target Kotlin source compiled or failed.

**Why:** A successful patch application and JavaScript typecheck do not prove native Kotlin compilation.

**How to apply:** Report the exact Gradle task reached and distinguish daemon/resource failure from Kotlin diagnostics. Do not claim native compilation succeeded unless the target module task completes.
