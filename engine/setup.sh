#!/bin/bash
# Install the local image/video runtime and the presets that fit this Mac.
set -euo pipefail
ROOT="/Users/majid/Projects/harbor"
cd "$ROOT"
mkdir -p data models/hf-home
LOG="$ROOT/data/install.log"
echo $$ > "$ROOT/data/install.pid"
exec >>"$LOG" 2>&1
trap 'echo FAILED_SETUP' ERR
echo "=== start $(date) ==="

if [[ ! -d engine/FastVideo/fastvideo ]]; then
  git clone --depth 1 https://github.com/hao-ai-lab/FastVideo.git engine/FastVideo
fi

python3 - <<'PY'
from pathlib import Path
p = Path("engine/FastVideo/fastvideo/__init__.py")
text = p.read_text()
if "VideoGenerator" in text:
    p.write_text('from fastvideo.version import __version__\n\n__all__ = ["__version__"]\n')
    print("SLIMMED_INIT")
PY

if [[ ! -x engine/.venv/bin/python ]]; then
  uv venv --python 3.12 engine/.venv
fi
PY="engine/.venv/bin/python"
uv pip install --python "$PY" \
  'mlx>=0.31.2,<0.33' \
  'torch' 'torchvision' \
  'transformers>=4.48' 'tokenizers>=0.20,<0.23' 'sentencepiece' 'safetensors' 'protobuf' \
  'huggingface_hub' \
  'diffusers>=0.38' 'accelerate' \
  'numpy' 'scipy' 'einops' 'pillow' 'imageio' 'imageio-ffmpeg' 'tqdm' \
  'cloudpickle' 'filelock' 'remote_pdb' 'opencv-python-headless'

export PYTHONPATH="$ROOT/engine/FastVideo"
export PYTHONUNBUFFERED=1
export HF_HOME="$ROOT/models/hf-home"
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_XET=1

"$PY" - <<'PY'
import sys
sys.path.insert(0, "engine/FastVideo")
import torch
import mlx.core  # noqa: F401
import diffusers  # noqa: F401
import transformers  # noqa: F401
import fastvideo.mlx_runtime.fast_spatial  # noqa: F401
print("SMOKE_OK", torch.__version__, "mps", torch.backends.mps.is_available())
PY
date -u +%Y-%m-%dT%H:%M:%SZ > data/smoke-ok

"$PY" - <<'PY'
import shutil
import time
from pathlib import Path
from huggingface_hub import snapshot_download

def free_gb():
    return shutil.disk_usage("/").free / (1024 ** 3)

video = Path("models/FastMetal-1.3B-QAD")
marker = video / "mlx_dit.safetensors"
index = video / "text_encoder" / "model.safetensors.index.json"
if marker.is_file() and index.is_file():
    print("VIDEO_WEIGHTS_READY already")
else:
    free = free_gb()
    print(f"DISK_BEFORE_VIDEO {free:.1f} GiB")
    if free < 16:
        raise SystemExit(f"FAILED_SETUP need 16 GiB free to download Coast Video, have {free:.1f}")
    for attempt in range(1, 8):
        try:
            snapshot_download(
                "FastVideo/FastMetal-1.3B-QAD",
                local_dir=str(video),
                max_workers=1,
            )
            break
        except Exception as exc:
            print(f"VIDEO_RETRY {attempt} {type(exc).__name__}: {exc}")
            if attempt == 7:
                raise
            time.sleep(8)
    print("VIDEO_WEIGHTS_READY")

# Small interpolator used by Quick pace. Safe to skip if the hub is down.
try:
    snapshot_download("mlx-community/RIFE-4.25")
    print("RIFE_READY")
except Exception as exc:
    print("RIFE_LATER", type(exc).__name__, exc)

image = Path("models/sd-turbo")
unet = image / "unet" / "diffusion_pytorch_model.fp16.safetensors"
if unet.is_file():
    print("IMAGE_WEIGHTS_READY already")
else:
    free = free_gb()
    print(f"DISK_BEFORE_IMAGE {free:.1f} GiB")
    if free < 8:
        print(f"IMAGE_SKIPPED disk={free:.1f}")
    else:
        snapshot_download(
            "stabilityai/sd-turbo",
            local_dir=str(image),
            allow_patterns=[
                "model_index.json",
                "scheduler/*",
                "tokenizer/*",
                "text_encoder/config.json",
                "text_encoder/model.fp16.safetensors",
                "unet/config.json",
                "unet/diffusion_pytorch_model.fp16.safetensors",
                "vae/config.json",
                "vae/diffusion_pytorch_model.fp16.safetensors",
            ],
        )
        print("IMAGE_WEIGHTS_READY")
PY

echo "SETUP_DONE $(date)"
