"""One-time private import of the already approved reference and public weights.

No uploads endpoint is exposed. No storage names, credentials or transcript
are printed. Re-running this preserves identical files and seeds a local cache.
"""

import json
import os
from pathlib import Path
import shutil

from assets import REQUIRED_FILES, sha256, storage_location

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "generated-artifacts" / "zara-voice-test"
CACHE = ROOT / ".cache" / "zara-voice" / "approved-v1"


def provision():
    bucket, prefix = storage_location()
    manifest = {"version": 1, "license": "CC-BY-NC-4.0", "files": {}}
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(CACHE, 0o700)
    for name in REQUIRED_FILES:
        source = SOURCE / name
        checksum = sha256(source)
        blob = bucket.blob(f"{prefix}/{name}")
        if blob.exists():
            blob.reload()
        if not blob.exists() or (blob.metadata or {}).get("sha256") != checksum:
            blob.metadata = {"sha256": checksum}
            blob.upload_from_filename(str(source))
        manifest["files"][name] = checksum
        target = CACHE / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target.parent, 0o700)
        if not target.exists() or sha256(target) != checksum:
            shutil.copyfile(source, target)
        os.chmod(target, 0o600)
        print(f"Prepared private voice asset {len(manifest['files'])}/{len(REQUIRED_FILES)}", flush=True)
    # Publish manifests last, so a partial import is never considered ready.
    encoded_manifest = json.dumps(manifest)
    bucket.blob(f"{prefix}/manifest.json").upload_from_string(
        encoded_manifest, content_type="application/json",
    )
    local_manifest = CACHE / "manifest.json"
    temporary_manifest = local_manifest.with_suffix(".json.tmp")
    temporary_manifest.write_text(encoded_manifest, encoding="utf-8")
    os.chmod(temporary_manifest, 0o600)
    temporary_manifest.replace(local_manifest)
    print("Approved voice assets stored privately; local cache ready.", flush=True)


if __name__ == "__main__":
    provision()
