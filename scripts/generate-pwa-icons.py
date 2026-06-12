"""Generate PWA home-screen icons from the Royal VIP logo source image."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "icons"
SOURCE = ROOT / "public" / "icons" / "royal-vip-source.png"

# Dark navy aligned with the logo inner circle / player theme.
MASKABLE_BG = (7, 3, 10)


def _fit_square(image: Image.Image, size: int) -> Image.Image:
    return image.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)


def _maskable_square(image: Image.Image, size: int) -> Image.Image:
    """Android maskable safe zone (~80% center) on dark background."""
    canvas = Image.new("RGB", (size, size), MASKABLE_BG)
    inner = int(size * 0.8)
    fitted = image.convert("RGB").resize((inner, inner), Image.Resampling.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste(fitted, (offset, offset))
    return canvas


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source logo: {SOURCE}")

    source = Image.open(SOURCE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    _fit_square(source, 512).save(OUT_DIR / "icon-512.png", format="PNG", optimize=True)
    _fit_square(source, 192).save(OUT_DIR / "icon-192.png", format="PNG", optimize=True)
    _fit_square(source, 180).save(OUT_DIR / "apple-touch-icon.png", format="PNG", optimize=True)
    _maskable_square(source, 512).save(
        OUT_DIR / "icon-512-maskable.png", format="PNG", optimize=True
    )

    print(f"Generated PWA icons in {OUT_DIR}")


if __name__ == "__main__":
    main()
