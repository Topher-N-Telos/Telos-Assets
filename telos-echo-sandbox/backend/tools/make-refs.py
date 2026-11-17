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
