"""Draw the split-spark mark and render the PNG icon sizes with headless Chrome.

Run from the repo root: python3 scripts/make_icons.py
"""

import math
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SIZES = (16, 32, 48, 128)

CENTRE = 50.0
# (angle in degrees, length): uneven rays give the hand-drawn spark feel.
RAYS = [(-90, 44), (-58, 38), (-25, 45), (8, 40), (40, 46), (72, 37),
        (104, 44), (138, 39), (170, 45), (203, 38), (236, 43)]
BASE_HALF_WIDTH = 2.8
TIP_HALF_WIDTH = 5.8
LEFT_COLOUR = "#D97757"
RIGHT_COLOUR = "#6A9BCC"
# The right half slides down and out so the mark reads as "split", not as the Claude logo.
SPLIT_GAP = 4.0
RIGHT_OFFSET = (4.0, 11.0)
# Turns the spark so the cut runs between two rays instead of slicing one into slivers.
RAY_ROTATION = 16
# Shrink to leave room for the offset half inside the 100x100 box.
MARK_SCALE = 0.84


def ray_path(degrees: float, length: float) -> str:
    angle = math.radians(degrees + RAY_ROTATION)
    dx, dy = math.cos(angle), math.sin(angle)
    px, py = -dy, dx
    tip_x, tip_y = CENTRE + dx * length, CENTRE + dy * length
    a = (CENTRE + px * BASE_HALF_WIDTH, CENTRE + py * BASE_HALF_WIDTH)
    b = (CENTRE - px * BASE_HALF_WIDTH, CENTRE - py * BASE_HALF_WIDTH)
    ta = (tip_x + px * TIP_HALF_WIDTH, tip_y + py * TIP_HALF_WIDTH)
    tb = (tip_x - px * TIP_HALF_WIDTH, tip_y - py * TIP_HALF_WIDTH)
    return (f"M{a[0]:.2f} {a[1]:.2f}L{ta[0]:.2f} {ta[1]:.2f}"
            f"A{TIP_HALF_WIDTH} {TIP_HALF_WIDTH} 0 0 0 {tb[0]:.2f} {tb[1]:.2f}"
            f"L{b[0]:.2f} {b[1]:.2f}Z")


def build_svg() -> str:
    spark = "".join(ray_path(deg, length) for deg, length in RAYS)
    half_gap = SPLIT_GAP / 2
    dx, dy = RIGHT_OFFSET
    shift = (100 * (1 - MARK_SCALE)) / 2 - dx / 2, (100 * (1 - MARK_SCALE)) / 2 - dy / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <clipPath id="left"><rect x="0" y="0" width="{CENTRE - half_gap}" height="100"/></clipPath>
    <clipPath id="right"><rect x="{CENTRE + half_gap}" y="0" width="{CENTRE}" height="100"/></clipPath>
    <path id="spark" d="{spark}"/>
  </defs>
  <g transform="translate({shift[0]:.2f} {shift[1]:.2f}) scale({MARK_SCALE})">
    <use href="#spark" fill="{LEFT_COLOUR}" clip-path="url(#left)"/>
    <g transform="translate({dx} {dy})"><use href="#spark" fill="{RIGHT_COLOUR}" clip-path="url(#right)"/></g>
  </g>
</svg>
"""


def render_png(svg_path: Path, size: int, workdir: Path) -> None:
    page = workdir / f"icon-{size}.html"
    page.write_text(f'<body style="margin:0;background:transparent">'
                    f'<img src="{svg_path}" width="{size}" height="{size}" style="display:block">')
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
         "--default-background-color=00000000", f"--window-size={size},{size}",
         f"--screenshot={ICON_DIR / f'icon-{size}.png'}", page.as_uri()],
        check=True, capture_output=True,
    )


def main() -> None:
    svg_path = ICON_DIR / "mark.svg"
    svg_path.write_text(build_svg())
    with tempfile.TemporaryDirectory() as tmp:
        for size in SIZES:
            render_png(svg_path, size, Path(tmp))
    print(f"Wrote {svg_path.name} and {len(SIZES)} PNGs to {ICON_DIR}")


if __name__ == "__main__":
    main()
