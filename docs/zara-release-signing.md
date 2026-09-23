# Zara Android release signing

The Zara Android release key is a long-lived project credential. It must be
preserved for every future Android release.

## Current release identity

- Application ID: `com.zara.assistant`
- Current release line: `1.0.2` (`versionCode 3`)
- Keystore type: JKS
- Alias: `zara-release`
- Workspace keystore path:
  `artifacts/zara-assistant/android/credentials/zara-release.jks`
- Encrypted recovery backup:
  `artifacts/zara-assistant/android/credentials/zara-release.jks.enc`

The credentials directory is intentionally excluded from git. The keystore and
its encrypted backup must never be pasted into chat, committed to source
control, or included in a public artifact.

## Required build configuration

Replit Secrets:

- `ZARA_RELEASE_STORE_PASSWORD`
- `ZARA_RELEASE_KEY_PASSWORD`

Non-secret shared environment values:

- `ZARA_RELEASE_KEYSTORE` — absolute path to the JKS file in this workspace
- `ZARA_RELEASE_KEY_ALIAS` — `zara-release`

The Gradle release build also requires `EXPO_PUBLIC_DOMAIN`. A release build
must fail when any signing secret is missing; never fall back to
`debug.keystore`.

## Rules for 1.0.3 and later

1. Keep `applicationId` equal to `com.zara.assistant`.
2. Increase both `versionName` and `versionCode`.
3. Use the same JKS file and `zara-release` alias.
4. Do not run `keytool -genkeypair` again and do not replace the keystore.
5. Verify the generated APK certificate before distribution.
6. Keep a tested encrypted backup of the JKS file. Restore it only through a
   secure environment, then restore file mode `600`.

The original 1.0.1 APK was signed with a different, unavailable key. This
JKS is the signing identity for 1.0.2 and every subsequent Zara Android
release.