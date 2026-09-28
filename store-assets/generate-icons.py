"""Export browser icons from the supplied ADO Lens artwork (requires Pillow)."""

from pathlib import Path

from PIL import Image


ASSETS = Path(__file__).resolve().parent
SOURCE = ASSETS / "source" / "ado-lens-logo.png"
OUTPUT = ASSETS / "icons"
SIZES = (16, 32, 48, 96, 128)


def main() -> None:
    artwork = Image.open(SOURCE).convert("RGBA")
    alpha = artwork.getchannel("A")
    visible = alpha.point(lambda value: value if value >= 8 else 0)
    artwork.putalpha(visible)
    bounds = visible.getbbox()
    if bounds is None:
        raise ValueError(f"No visible artwork in {SOURCE}")
    artwork = artwork.crop(bounds)

    OUTPUT.mkdir(exist_ok=True)
    for size in SIZES:
        # Chrome's 128 px store icon calls for a 96 px mark with 16 px margins.
        mark_size = round(size * (0.75 if size == 128 else 0.9))
        scale = min(mark_size / artwork.width, mark_size / artwork.height)
        width = round(artwork.width * scale)
        height = round(artwork.height * scale)
        mark = artwork.resize((width, height), Image.Resampling.LANCZOS)
        icon = Image.new("RGBA", (size, size))
        icon.alpha_composite(mark, ((size - width) // 2, (size - height) // 2))
        icon.save(OUTPUT / f"icon-{size}.png", optimize=True)


if __name__ == "__main__":
    main()
