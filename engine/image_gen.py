"""Local stills on this Mac. SD-Turbo, a few steps, optional portrait start."""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--init-image", default="")
    parser.add_argument("--strength", type=float, default=0.72)
    args = parser.parse_args()

    dtype = torch.float16
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    kwargs = dict(
        torch_dtype=dtype,
        variant="fp16",
        local_files_only=True,
        safety_checker=None,
        requires_safety_checker=False,
    )
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.init_image:
        from diffusers import StableDiffusionImg2ImgPipeline

        pipe = StableDiffusionImg2ImgPipeline.from_pretrained(args.model, **kwargs)
        pipe.to("mps")
        pipe.set_progress_bar_config(disable=True)
        init = Image.open(args.init_image).convert("RGB").resize((args.width, args.height))
        steps = max(4, args.steps)
        image = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative or None,
            image=init,
            strength=args.strength,
            num_inference_steps=steps,
            guidance_scale=0.0,
            generator=generator,
        ).images[0]
    else:
        from diffusers import StableDiffusionPipeline

        pipe = StableDiffusionPipeline.from_pretrained(args.model, **kwargs)
        pipe.to("mps")
        pipe.set_progress_bar_config(disable=True)
        image = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative or None,
            width=args.width,
            height=args.height,
            num_inference_steps=max(1, args.steps),
            guidance_scale=0.0,
            generator=generator,
        ).images[0]

    image.save(out)
    print(f"IMAGE_DONE {out}")


if __name__ == "__main__":
    main()
