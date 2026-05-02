"""Generate extension icons - download arrow on gradient background."""
from PIL import Image, ImageDraw

def create_icon(size, path):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = max(1, size // 32)
    radius = size // 5

    # Background gradient: indigo to purple
    for y in range(margin, size - margin):
        t = (y - margin) / max(1, size - 2 * margin - 1)
        r = int(67 + (109 - 67) * t)
        g = int(56 + (40 - 56) * t)
        b = int(202 + (217 - 202) * t)
        draw.line([(margin, y), (size - margin, y)], fill=(r, g, b))

    # Rounded corners mask
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(
        [margin, margin, size - margin - 1, size - margin - 1],
        radius=radius, fill=255
    )
    img.putalpha(mask)

    # Subtle white highlight at top
    for y in range(margin, size // 3):
        alpha = int(25 * (1 - (y - margin) / max(1, size // 3 - margin)))
        if alpha > 0:
            draw.line([(margin + 2, y), (size - margin - 2, y)],
                       fill=(255, 255, 255, alpha))

    # Center circle
    cx, cy = size // 2, size // 2
    circle_r = int(size * 0.30)

    # Filled circle with subtle white
    draw.ellipse(
        [cx - circle_r, cy - circle_r, cx + circle_r, cy + circle_r],
        fill=(255, 255, 255, 35),
        outline=(255, 255, 255, 160),
        width=max(1, size // 40)
    )

    # Download arrow
    aw = max(2, size // 10)  # arrow line width
    mid_x = cx

    # Vertical line
    line_top = cy - circle_r + size // 6
    line_bottom = cy + size // 8
    draw.line([(mid_x, line_top), (mid_x, line_bottom)],
              fill='white', width=aw)

    # Arrowhead
    head_size = aw * 3
    head_y = line_bottom
    draw.polygon([
        (mid_x, head_y + head_size),
        (mid_x - head_size, head_y - head_size // 3),
        (mid_x + head_size, head_y - head_size // 3),
    ], fill='white')

    # Horizontal bar at bottom
    bar_w = head_size * 2
    bar_y = head_y + head_size + size // 20
    bar_h = max(2, size // 16)
    draw.rounded_rectangle(
        [mid_x - bar_w, bar_y, mid_x + bar_w, bar_y + bar_h],
        radius=bar_h // 2, fill='white'
    )

    img.save(path, 'PNG')
    print(f'  Created {path}  ({size}x{size})')


if __name__ == '__main__':
    import os
    icons_dir = r'e:\extention3\extension\icons'
    for size in [16, 48, 128]:
        create_icon(size, os.path.join(icons_dir, f'icon{size}.png'))
    print('Done.')
