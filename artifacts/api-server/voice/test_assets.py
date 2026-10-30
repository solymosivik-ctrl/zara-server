import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from assets import REQUIRED_FILES, ensure_assets


class LocalAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "approved-v1"
        self.root.mkdir(mode=0o700)
        self.manifest = {"version": 1, "license": "CC-BY-NC-4.0", "files": {}}
        for name in REQUIRED_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(target.parent, 0o700)
            contents = f"private-test-fixture:{name}".encode()
            target.write_bytes(contents)
            os.chmod(target, 0o600)
            self.manifest["files"][name] = hashlib.sha256(contents).hexdigest()
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        os.chmod(self.root / "manifest.json", 0o600)

    def test_local_bundle_verifies_without_storage_credentials(self):
        with patch.dict(os.environ, {"ZARA_F5_ASSET_DIR": str(self.root)}, clear=True), \
             patch("assets.storage_location", side_effect=AssertionError("storage must not be used")):
            result = ensure_assets(Path(self.temporary.name) / "unused-cache")
        self.assertEqual(result, self.root)

    def test_corrupt_asset_fails_integrity_check(self):
        (self.root / "reference.wav").write_bytes(b"corrupted")
        with patch.dict(os.environ, {"ZARA_F5_ASSET_DIR": str(self.root)}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "integrity"):
                ensure_assets(Path(self.temporary.name) / "unused-cache")

    def test_incomplete_manifest_is_rejected(self):
        self.manifest["files"].pop("reference.wav")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with patch.dict(os.environ, {"ZARA_F5_ASSET_DIR": str(self.root)}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                ensure_assets(Path(self.temporary.name) / "unused-cache")

    def test_world_readable_assets_are_rejected(self):
        (self.root / "reference.wav").chmod(0o644)
        with patch.dict(os.environ, {"ZARA_F5_ASSET_DIR": str(self.root)}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "permissions are too broad"):
                ensure_assets(Path(self.temporary.name) / "unused-cache")

    def test_render_requires_private_disk_configuration(self):
        with patch.dict(os.environ, {"RENDER": "true"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ZARA_F5_ASSET_DIR"):
                ensure_assets(Path(self.temporary.name) / "unused-cache")


if __name__ == "__main__":
    unittest.main()
