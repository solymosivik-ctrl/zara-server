"""Load private, checksum-verified F5 assets from App Storage or a mounted disk."""

import hashlib
import json
import os
import re
import stat
from pathlib import Path

ASSET_PREFIX = "zara-voice/approved-v1"
REQUIRED_FILES = (
    "reference.wav",
    "reference.json",
    "model/model_last_final.safetensors",
    "model/vocab.txt",
    "model/LICENSE.md",
    "vocoder/config.yaml",
    "vocoder/pytorch_model.bin",
)


def storage_location():
    from google.auth import identity_pool
    from google.cloud import storage

    root = os.environ.get("PRIVATE_OBJECT_DIR", "").strip("/")
    if "/" not in root:
        raise RuntimeError("Private voice storage is not configured.")
    bucket_name, private_prefix = root.split("/", 1)
    credentials = identity_pool.Credentials.from_info({
        "type": "external_account",
        "audience": "replit",
        "subject_token_type": "access_token",
        "token_url": "http://127.0.0.1:1106/token",
        "credential_source": {
            "url": "http://127.0.0.1:1106/credential",
            "format": {"type": "json", "subject_token_field_name": "access_token"},
        },
    })
    client = storage.Client(project="zara-voice", credentials=credentials)
    return client.bucket(bucket_name), f"{private_prefix}/{ASSET_PREFIX}"


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_files(manifest):
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise RuntimeError("The private Zara voice asset manifest is invalid.")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(REQUIRED_FILES):
        raise RuntimeError("The private Zara voice asset manifest is incomplete.")
    for name in REQUIRED_FILES:
        checksum = files.get(name)
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise RuntimeError("The private Zara voice asset manifest is invalid.")
    return files


def _load_local_assets(directory):
    root = Path(directory).expanduser()
    if not root.is_absolute():
        raise RuntimeError("ZARA_F5_ASSET_DIR must be an absolute private disk path.")
    try:
        root = root.resolve(strict=True)
        if not root.is_dir():
            raise RuntimeError("ZARA_F5_ASSET_DIR is not a directory.")
        if stat.S_IMODE(root.stat().st_mode) & 0o077:
            raise RuntimeError("The private Zara voice asset directory permissions are too broad.")
        manifest_path = root / "manifest.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise RuntimeError("The private Zara voice asset manifest is missing.")
        if stat.S_IMODE(manifest_path.stat().st_mode) & 0o077:
            raise RuntimeError("The private Zara voice asset manifest permissions are too broad.")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = _manifest_files(manifest)
        for name in ("model", "vocoder"):
            directory_path = root / name
            if directory_path.is_symlink() or not directory_path.is_dir():
                raise RuntimeError("A private Zara voice asset directory is missing.")
            if stat.S_IMODE(directory_path.stat().st_mode) & 0o077:
                raise RuntimeError("The private Zara voice asset directory permissions are too broad.")
        for name in REQUIRED_FILES:
            candidate = root / name
            if candidate.is_symlink():
                raise RuntimeError("A private Zara voice asset cannot be a symbolic link.")
            target = candidate.resolve(strict=True)
            if not target.is_relative_to(root) or not target.is_file():
                raise RuntimeError("A private Zara voice asset is missing.")
            if stat.S_IMODE(target.stat().st_mode) & 0o077:
                raise RuntimeError("Private Zara voice asset permissions are too broad.")
            if sha256(target) != files[name]:
                raise RuntimeError("Private Zara voice asset integrity check failed.")
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("Private Zara voice assets could not be verified.") from None
    return root


def ensure_assets(cache):
    local_directory = os.environ.get("ZARA_F5_ASSET_DIR", "").strip()
    if local_directory:
        return _load_local_assets(local_directory)

    if os.environ.get("RENDER", "").strip().lower() in {"1", "true", "yes"}:
        raise RuntimeError("Set ZARA_F5_ASSET_DIR to the private Render disk asset directory.")

    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(cache, 0o700)
    bucket, prefix = storage_location()
    manifest = json.loads(bucket.blob(f"{prefix}/manifest.json").download_as_bytes())
    files = _manifest_files(manifest)
    for name in REQUIRED_FILES:
        checksum = files[name]
        target = cache / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target.parent, 0o700)
        if target.is_file() and sha256(target) == checksum:
            os.chmod(target, 0o600)
            continue
        temporary = target.with_suffix(target.suffix + ".download")
        bucket.blob(f"{prefix}/{name}").download_to_filename(str(temporary))
        if sha256(temporary) != checksum:
            temporary.unlink(missing_ok=True)
            raise RuntimeError("Voice asset integrity check failed.")
        os.chmod(temporary, 0o600)
        temporary.replace(target)
    encoded_manifest = json.dumps(manifest)
    local_manifest = cache / "manifest.json"
    temporary_manifest = local_manifest.with_suffix(".json.tmp")
    temporary_manifest.write_text(encoded_manifest, encoding="utf-8")
    os.chmod(temporary_manifest, 0o600)
    temporary_manifest.replace(local_manifest)
    return cache
