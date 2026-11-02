# Zara approved Hungarian reference voice

The existing `/api/zara/speak` endpoint uses the approved F5-TTS Hungarian
reference voice. It does not fall back to Edge TTS, OpenAI, Google, ElevenLabs,
or Android device speech.

## Runtime and private assets

- One persistent Python inference subprocess belongs to the existing Node API.
  It does not open another HTTP port.
- In Replit, the reference, model, and vocoder load from private App Storage
  using the Replit identity service and `PRIVATE_OBJECT_DIR`.
- On Render, set `ZARA_F5_ASSET_DIR` to the absolute path on a private mounted
  disk. The directory must contain `manifest.json`, the approved reference,
  model, and vocoder files. The loader verifies checksums and restrictive file
  permissions; the assets are never served over HTTP.
- The seven required files are `reference.wav`, `reference.json`,
  `model/model_last_final.safetensors`, `model/vocab.txt`, `model/LICENSE.md`,
  `vocoder/config.yaml`, and `vocoder/pytorch_model.bin`.
- `voice/provision.py` creates the private App Storage manifest from the
  already-prepared local bundle. Do not run it unless that bundle is present
  and the operator explicitly intends to provision App Storage.
- Production builds use the pinned CPU Python dependencies in `.pythonlibs`.
  `uv`, Python 3.13, and `ffmpeg` must be available to the build/runtime.
- Setting `ZARA_F5_WARMUP=1` loads the model before the HTTP listener starts.
  This may add up to 180 seconds to startup; it does not synthesize a greeting.
- The experimental CPU compile path is opt-in only:
  `ZARA_F5_COMPILE_MODE=reduce-overhead`. The default is `eager`; no compile
  setting is needed for the normal voice path. A first inference can spend over
  a minute compiling and variable text lengths may create additional graphs.
- `ZARA_F5_COMPILE_WARMUP=1` additionally synthesizes and discards one fixed,
  short probe before the runtime reports ready. It requires compile mode and
  can delay startup substantially. It does not alter the public API or persist
  the probe audio. Any compile exception restores the original transformer and
  retries that request once using Eager. To run this before the API begins
  listening, set both `ZARA_F5_WARMUP=1` and `ZARA_F5_COMPILE_WARMUP=1`.

## API compatibility and latency

`POST /api/zara/speak` keeps the existing synchronous `{audioBase64,
mimeType, status}` MP3 response. New clients may send `async: true`, then poll
with the returned `jobId`; only a `completed` response contains audio. The
client uses this job flow to tolerate long CPU inference and reports failures
without substituting another voice. Jobs and the bounded audio cache are
in-memory and are lost on process restart.

No model or reference audio is included in Git. These instructions prepare the
existing API for deployment; they do not configure or deploy Render.
