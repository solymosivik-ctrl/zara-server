---
name: pnpm dependency patches
description: Workspace-specific cautions when maintaining a pnpm patch for a native dependency.
---

When using `pnpm patch-commit` in this workspace, inspect `pnpm-workspace.yaml` and `pnpm-lock.yaml` immediately. The command may reserialize existing workspace settings and refresh unrelated lockfile snapshots; preserve existing comments and revert unrelated resolution changes before finishing.

**Why:** A targeted Expo Audio patch caused broad formatting/comment churn and an unrelated TypeScript peer-resolution update during patch registration.

**How to apply:** Keep only the patched dependency registration, its lockfile hash/importer snapshot, and the patch file; verify the final diff before running further install commands.
