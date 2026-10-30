"""Generate local-only F5 onset trials with the approved voice assets."""

import os
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"

import json
import time
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / ".cache" / "zara-voice" / "approved-v1"
OUT = Path(__file__).resolve().parent
TRANSCRIPT = (
    "Nem sokat tudok mondani magamról, de Viktor segítségével "
    "szívesen válaszolok kérdésekre."
)
CANDIDATES = (
    ("period-seed-7", "rendben. szia, viktor! én vagyok zara.", 7),
    ("period-seed-2026", "rendben. szia, viktor! én vagyok zara.", 2026),
    ("comma-seed-42", "rendben, szia, viktor! én vagyok zara.", 42),
)


def load_audio(path, **kwargs):
    audio, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(audio.T.copy()), sample_rate


def main():
    torch.set_num_threads(4)
    torch.set_num_interop_threads(2)
    torchaudio.load = load_audio
    with open(os.devnull, "w") as quiet:
        with redirect_stdout(quiet), redirect_stderr(quiet):
            from f5_tts.api import F5TTS

            model = F5TTS(
                model="F5TTS_v1_Base",
                ckpt_file=str(ASSETS / "model/model_last_final.safetensors"),
                vocab_file=str(ASSETS / "model/vocab.txt"),
                vocoder_local_path=str(ASSETS / "vocoder"),
                device="cpu",
                use_ema=True,
            )
    manifest = {
        "voice_assets": str(ASSETS),
        "reference_sha256": json.loads((ASSETS / "reference.json").read_text())[
            "reference_sha256"
        ],
        "reference_transcript": TRANSCRIPT,
        "reference_transcript_status": "automatic transcript; not user-verified",
        "candidates": [],
        "warning": "Local listening test only; not integrated into the app.",
    }
    for name, text, seed in CANDIDATES:
        started = time.monotonic()
        with open(os.devnull, "w") as quiet:
            with redirect_stdout(quiet), redirect_stderr(quiet), torch.inference_mode():
                audio, sample_rate, _ = model.infer(
                    ref_file=str(ASSETS / "reference.wav"),
                    ref_text=TRANSCRIPT.lower(),
                    gen_text=text,
                    nfe_step=32,
                    seed=seed,
                )
        audio = np.asarray(audio, dtype=np.float32)
        wav_path = OUT / f"zara-onset-{name}.wav"
        sf.write(wav_path, audio, sample_rate, subtype="PCM_16")
        manifest["candidates"].append(
            {
                "name": name,
                "text": text,
                "seed": seed,
                "file": wav_path.name,
                "sample_rate": sample_rate,
                "duration_seconds": len(audio) / sample_rate,
                "peak": float(np.max(np.abs(audio))),
            }
        )
        print(f"generated candidate={name} seconds={time.monotonic() - started:.1f}", flush=True)
    (OUT / "onset-candidates.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
