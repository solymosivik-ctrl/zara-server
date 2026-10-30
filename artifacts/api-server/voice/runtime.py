"""One private, persistent inference subprocess owned by the existing API.

JSON-lines on stdio, no HTTP listener and no new server. Model/library output
is discarded to prevent reply text or reference transcripts entering logs.
"""

import base64
from contextlib import redirect_stderr, redirect_stdout
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys

from assets import ensure_assets
from text import prepare_text

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".cache" / "zara-voice" / "approved-v1"


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    os.environ["OMP_NUM_THREADS"] = "4"
    os.environ["MKL_NUM_THREADS"] = "4"
    with open(os.devnull, "w") as quiet:
        try:
            with redirect_stdout(quiet), redirect_stderr(quiet):
                import numpy as np
                import soundfile as sf
                import torch
                import torchaudio
                torch.set_num_threads(4)
                torch.set_num_interop_threads(2)

                def load_audio(path, **kwargs):
                    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
                    return torch.from_numpy(audio.T.copy()), sr

                torchaudio.load = load_audio
                from f5_tts.api import F5TTS
                cache = ensure_assets(CACHE)
                reference = json.loads((cache / "reference.json").read_text())
                vocabulary = set((cache / "model/vocab.txt").read_text().splitlines())
                # Reference uses the same lowercase-only vocabulary.
                import unicodedata
                reference_text = unicodedata.normalize("NFC", reference["transcript"]).lower()
                if set(reference_text) - vocabulary:
                    raise ValueError("Invalid reference vocabulary.")
                model = F5TTS(
                    model="F5TTS_v1_Base",
                    ckpt_file=str(cache / "model/model_last_final.safetensors"),
                    vocab_file=str(cache / "model/vocab.txt"),
                    vocoder_local_path=str(cache / "vocoder"), device="cpu", use_ema=True,
                )
        except Exception:
            emit({"event": "fatal", "message": "Zara saját hangmotorja nem indítható. A szöveges válasz elérhető."})
            return 1
        emit({"event": "ready"})
        for line in sys.stdin:
            request_id = None
            try:
                request = json.loads(line)
                request_id = request["id"]
                text = request["text"]
                if not isinstance(text, str) or not 0 < len(text) <= 5000:
                    raise ValueError("Érvénytelen hangkérés.")
                prepared = prepare_text(text, vocabulary)
                with redirect_stdout(quiet), redirect_stderr(quiet), torch.inference_mode():
                    audio, sr, _ = model.infer(
                        ref_file=str(cache / "reference.wav"),
                        ref_text=reference_text, gen_text=prepared,
                        nfe_step=32, seed=42,
                    )
                audio = np.asarray(audio, dtype=np.float32)
                if not len(audio) or not np.isfinite(audio).all():
                    raise RuntimeError("Invalid generated audio.")
                peak = float(np.max(np.abs(audio)))
                if peak > 0.98:
                    audio *= 0.98 / peak
                wav = BytesIO()
                sf.write(wav, audio, sr, format="WAV", subtype="PCM_16")
                encoded = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                     "-f", "mp3", "-b:a", "96k", "pipe:1"],
                    input=wav.getvalue(), capture_output=True, check=True, timeout=30,
                ).stdout
                if len(encoded) < 256:
                    raise RuntimeError("Empty encoded speech.")
                emit({"id": request_id, "ok": True,
                      "audioBase64": base64.b64encode(encoded).decode("ascii"),
                      "mimeType": "audio/mpeg"})
            except ValueError:
                emit({"id": request_id, "ok": False,
                      "message": "Zara saját hangja ezt a szöveget nem tudta felolvasni. A szöveges válasz megmaradt."})
            except Exception:
                emit({"id": request_id, "ok": False,
                      "message": "Zara saját hangjának előállítása nem sikerült. A szöveges válasz megmaradt."})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
