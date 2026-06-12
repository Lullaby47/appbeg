"""Generate PWA home-screen icons from the Royal VIP logo source image."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "icons"
SOURCE = ROOT / "public" / "icons" / "royal-vip-source.png"

# Slight center zoom so ROYAL VIP reads clearly on small home-screen icons.
ICON_ZOOM = 1.16

# Dark purple aligned with the logo chip background.
MASKABLE_BG = (36, 8, 48)


def _prepare_logo(source: Image.Image, zoom: float = ICON_ZOOM) -> Image.Image:
    rgb = source.convert("RGB")
    width, height = rgb.size
    crop_side = int(min(width, height) / zoom)
    left = (width - crop_side) // 2
    top = (height - crop_side) // 2
    return rgb.crop((left, top, left + crop_side, top + crop_side))


def _fit_square(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def _maskable_square(image: Image.Image, size: int) -> Image.Image:
    """Android maskable safe zone on logo-matched background."""
    canvas = Image.new("RGB", (size, size), MASKABLE_BG)
    inner = int(size * 0.86)
    fitted = image.resize((inner, inner), Image.Resampling.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(fitted, (offset, offset))
    return canvas


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source logo: {SOURCE}")

    source = _prepare_logo(Image.open(SOURCE))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    _fit_square(source, 512).save(OUT_DIR / "icon-512.png", format="PNG", optimize=True)
    _fit_square(source, 192).save(OUT_DIR / "icon-192.png", format="PNG", optimize=True)
    _fit_square(source, 180).save(OUT_DIR / "apple-touch-icon.png", format="PNG", optimize=True)
    _maskable_square(source, 512).save(
        OUT_DIR / "icon-512-maskable.png", format="PNG", optimize=True
    )

    print(f"Generated PWA icons in {OUT_DIR} (zoom={ICON_ZOOM}x)")


if __name__ == "__main__":
    main()
