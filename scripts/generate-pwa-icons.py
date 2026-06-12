"""Generate temporary branded PWA icons for Royal VIP (replace with final assets later)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "icons"

BACKGROUND = (7, 3, 10)
AMBER = (217, 119, 6)
AMBER_LIGHT = (251, 191, 36)
PURPLE = (88, 28, 135)


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_icon(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), BACKGROUND + (255,))
    draw = ImageDraw.Draw(image)

    inset = max(8, size // 16)
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=max(16, size // 8),
        fill=(10, 6, 18, 255),
        outline=AMBER + (220,),
        width=max(2, size // 64),
    )

    crown_y = size * 0.18
    crown_w = size * 0.52
    crown_x = (size - crown_w) / 2
    draw.polygon(
        [
            (crown_x, crown_y + crown_w * 0.35),
            (crown_x + crown_w * 0.2, crown_y),
            (crown_x + crown_w * 0.35, crown_y + crown_w * 0.22),
            (crown_x + crown_w * 0.5, crown_y),
            (crown_x + crown_w * 0.65, crown_y + crown_w * 0.22),
            (crown_x + crown_w * 0.8, crown_y),
            (crown_x + crown_w, crown_y + crown_w * 0.35),
            (crown_x + crown_w, crown_y + crown_w * 0.55),
            (crown_x, crown_y + crown_w * 0.55),
        ],
        fill=AMBER_LIGHT + (255,),
        outline=AMBER + (255,),
    )

    font = _load_font(max(28, size // 5))
    label = "RV"
    bbox = draw.textbbox((0, 0), label, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) / 2, size * 0.58 - text_h / 2),
        label,
        fill=(255, 255, 255, 255),
        font=font,
    )

    accent_r = max(4, size // 40)
    draw.ellipse(
        (size * 0.12, size * 0.12, size * 0.12 + accent_r * 2, size * 0.12 + accent_r * 2),
        fill=PURPLE + (180,),
    )
    draw.ellipse(
        (
            size * 0.82 - accent_r * 2,
            size * 0.16,
            size * 0.82,
            size * 0.16 + accent_r * 2,
        ),
        fill=AMBER + (160,),
    )

    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    draw_icon(192).save(OUT_DIR / "icon-192.png", format="PNG")
    draw_icon(512).save(OUT_DIR / "icon-512.png", format="PNG")
    draw_icon(180).save(OUT_DIR / "apple-touch-icon.png", format="PNG")
    print(f"Wrote icons to {OUT_DIR}")


if __name__ == "__main__":
    main()
