"""Logo concepts v3: totally different designs AND colors (no violet-cyan).

1. Sunset Rocket — rocket diving down, ember orange -> pink, flame + speed streaks.
2. Golden Folder — amber/gold folder with a white arrow landing inside it.
3. Comet Arrow — diagonal down-right arrow, teal -> lime, with motion trails.
"""
import cairosvg
from PIL import Image, ImageDraw

OUT = "/home/hatch/workspace/download-manager/electron/build"

CONCEPTS = {
    "concept4-rocket": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#ff7a18"/><stop offset="1" stop-color="#ff2e63"/>
</linearGradient></defs>
<path d="M 256 128 C 236 92 236 58 256 26 C 276 58 276 92 256 128 Z" fill="#fbbf24"/>
<path d="M 256 148 C 246 122 246 102 256 84 C 266 102 266 122 256 148 Z" fill="#fff7ed"/>
<path d="M 196 296 C 150 316 128 366 126 410 C 160 400 188 370 198 330 Z" fill="#e11d48"/>
<path d="M 316 296 C 362 316 384 366 386 410 C 352 400 324 370 314 330 Z" fill="#e11d48"/>
<path d="M 256 420 C 230 380 196 342 196 250 C 196 180 220 132 256 132 C 292 132 316 180 316 250 C 316 342 282 380 256 420 Z" fill="url(#g)"/>
<circle cx="256" cy="244" r="36" fill="#ffffff"/>
<circle cx="256" cy="244" r="20" fill="#ff7a18"/>
<line x1="132" y1="220" x2="132" y2="300" stroke="#ff7a18" stroke-width="18" stroke-linecap="round" opacity="0.55"/>
<line x1="380" y1="220" x2="380" y2="300" stroke="#ff2e63" stroke-width="18" stroke-linecap="round" opacity="0.55"/>
</svg>""",
    "concept5-folder": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f97316"/>
</linearGradient></defs>
<path d="M 76 172 Q 76 140 108 140 L 212 140 L 242 176 L 436 176 Q 466 176 466 206 L 466 380 Q 466 410 436 410 L 106 410 Q 76 410 76 380 Z" fill="#d97706"/>
<path d="M 76 212 Q 76 190 98 190 L 444 190 Q 466 190 466 212 L 466 380 Q 466 410 436 410 L 106 410 Q 76 410 76 380 Z" fill="url(#g)"/>
<rect x="228" y="88" width="56" height="150" rx="18" fill="#ffffff"/>
<polygon points="168,228 344,228 256,344" fill="#ffffff"/>
</svg>""",
    "concept6-comet": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#84cc16"/>
</linearGradient></defs>
<line x1="66" y1="146" x2="118" y2="198" stroke="#14b8a6" stroke-width="22" stroke-linecap="round" opacity="0.45"/>
<line x1="118" y1="62" x2="170" y2="114" stroke="#84cc16" stroke-width="22" stroke-linecap="round" opacity="0.35"/>
<g transform="rotate(-45 256 256)">
<rect x="228" y="90" width="56" height="200" rx="20" fill="url(#g)"/>
<polygon points="166,280 346,280 256,420" fill="url(#g)"/>
</g>
</svg>""",
}

for name, svg in CONCEPTS.items():
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/{name}.png",
                     output_width=1024, output_height=1024, background_color="transparent")
    print("made", name)

CELL_W, CELL_H = 600, 340
sheet = Image.new("RGB", (CELL_W * 3, CELL_H * 2), (11, 11, 17))
draw = ImageDraw.Draw(sheet)
names = ["concept4-rocket", "concept5-folder", "concept6-comet"]
labels = ["1  Sunset Rocket", "2  Golden Folder", "3  Comet Arrow"]
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
sheet.save(f"{OUT}/logo-preview-v3.png")
print("sheet:", sheet.size)
