"""Generate 3 fresh logo concepts for Shahjahan Download Manager (v2).

Concept 1: Orbit Arrow — gradient circle badge, orbit ring, bold white arrow.
Concept 2: Triple Chevron — three stacked gradient chevrons (speed), transparent.
Concept 3: Hex Bolt — gradient hexagon badge, white lightning bolt + download tray.
"""
import cairosvg
from PIL import Image, ImageDraw

OUT = "/home/hatch/workspace/download-manager/electron/build"
GRAD = """<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient>"""

CONCEPTS = {
    "concept1-orbit": f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>{GRAD}</defs>
<ellipse cx="256" cy="256" rx="262" ry="112" fill="none" stroke="url(#g)" stroke-width="16" transform="rotate(-24 256 256)"/>
<circle cx="493" cy="150" r="20" fill="#22d3ee"/>
<circle cx="256" cy="256" r="208" fill="url(#g)"/>
<path d="M 226 108 h 60 v 152 h 52 L 256 412 L 174 260 h 52 Z" fill="#ffffff"/>
</svg>""",
    "concept2-chevrons": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<path d="M 110 118 L 256 258 L 402 118" fill="none" stroke="#a855f7" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M 110 208 L 256 348 L 402 208" fill="none" stroke="#5b83f5" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M 110 298 L 256 438 L 402 298" fill="none" stroke="#22d3ee" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
</svg>""",
    "concept3-hexbolt": f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>{GRAD}</defs>
<polygon points="256,26 455,141 455,371 256,486 57,371 57,141" fill="url(#g)"/>
<polygon points="302,108 198,272 250,272 208,410 332,238 276,238" fill="#ffffff"/>
<rect x="206" y="428" width="100" height="20" rx="10" fill="#ffffff"/>
</svg>""",
}

for name, svg in CONCEPTS.items():
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/{name}.png",
                     output_width=1024, output_height=1024, background_color="transparent")
    print("made", name)

# Comparison sheet: 3 columns x 2 rows (dark row, white row), each cell has
# the logo large + a 64/48/32/16px size row underneath.
CELL_W, CELL_H = 600, 340
sheet = Image.new("RGB", (CELL_W * 3, CELL_H * 2), (11, 11, 17))
draw = ImageDraw.Draw(sheet)
names = ["concept1-orbit", "concept2-chevrons", "concept3-hexbolt"]
labels = ["1  Orbit Arrow", "2  Triple Chevron", "3  Hex Bolt"]
for col, name in enumerate(names):
    logo = Image.open(f"{OUT}/{name}.png").convert("RGBA")
    for row, bg in enumerate([(11, 11, 17), (255, 255, 255)]):
        x0, y0 = col * CELL_W, row * CELL_H
        sheet.paste(bg, (x0, y0, x0 + CELL_W, y0 + CELL_H))
        big = logo.resize((190, 190), Image.LANCZOS)
        sheet.paste(big, (x0 + (CELL_W - 190) // 2, y0 + 18), big)
        sx = x0 + (CELL_W - (64 + 48 + 32 + 16 + 30)) // 2
        for size in (64, 48, 32, 16):
            small = logo.resize((size, size), Image.LANCZOS)
            sheet.paste(small, (sx, y0 + 250), small)
            sx += size + 10
        draw.text((x0 + 20, y0 + CELL_H - 28), labels[col], fill=(200, 200, 200) if row == 0 else (90, 90, 90))
sheet.save(f"{OUT}/logo-preview-v2.png")
print("sheet:", sheet.size)
