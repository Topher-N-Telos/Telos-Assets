#!/usr/bin/env python3
"""Builds the deployable reference set (public/_refs) from the full-size masters in refs/.
Masters stay in the repo untouched; the copies are capped at 1536px on the long edge (JPEG q90) so each
generation call sends small, cheap inputs. Files in public/ are NEVER served to clients (the Worker only
serves whitelisted paths); only the Worker reads them, via the ASSETS binding."""
import os, sys
from PIL import Image
MAP = {
  'terra-nova':     {'face': 'face-closeup.png', 'body': 'base-body.png', 'look': 'studio-green-suit.jpg'},
  'umbra-seraphine':{'face': 'face-closeup.jpg', 'body': 'base-body.png', 'look': 'canon-presentation.jpg'},
  'solis-oryn':     {'face': 'face-closeup.png', 'body': 'base-body.png', 'look': 'canon-full-body.png'},
  'auris-aeon':     {'dragon-face': 'dragon-default-face-closeup.png', 'dragon-body': 'dragon-default-wide.png',
                     'human-face': 'rocco-face-closeup.png', 'human-body': 'rocco-base-body.png', 'human-look': 'rocco-full-body.png'},
}
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for d, roles in MAP.items():
    os.makedirs(f'{root}/public/_refs/{d}', exist_ok=True)
    for role, src in roles.items():
        im = Image.open(f'{root}/refs/{d}/{src}').convert('RGB')
        im.thumbnail((1536, 1536), Image.LANCZOS)
        out = f'{root}/public/_refs/{d}/{role}.jpg'
        im.save(out, 'JPEG', quality=90, optimize=True)
        print(out.replace(root + '/', ''), im.size, os.path.getsize(out) // 1024, 'KB')

# Garment-layer canvas: the body reference fitted into the exact 1024x1536 output canvas (padded with its own backdrop colour)
# so a generated garment layer and this image share ONE coordinate system.
CANVAS = {'terra-nova': 'base-body.png'}
for d, src in CANVAS.items():
    im = Image.open(f'{root}/refs/{d}/{src}').convert('RGB')
    w = 1024; h = round(im.height * w / im.width)
    im = im.resize((w, h), Image.LANCZOS)
    px = im.load(); edge = [px[x, y] for x in range(0, w, 16) for y in (0, 1, 2)]
    bg = tuple(sum(c[i] for c in edge) // len(edge) for i in range(3))
    canvas = Image.new('RGB', (1024, 1536), bg)
    canvas.paste(im, (0, (1536 - h) // 2))
    out = f'{root}/public/_refs/{d}/canvas.jpg'
    canvas.save(out, 'JPEG', quality=90, optimize=True)
    print(out.replace(root + '/', ''), canvas.size, 'bg', bg)
