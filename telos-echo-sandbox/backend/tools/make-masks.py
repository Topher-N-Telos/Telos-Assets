#!/usr/bin/env python3
"""Dev-time tool (not run by the Worker): builds the wardrobe edit masks for a character from its registration canvas.
Needs `pip install rembg` (downloads a person-segmentation model once). Output PNGs are RGBA at canvas size:
alpha 0 = the model MAY repaint, alpha 255 = locked. Zones are bands of the body silhouette, grown a little so loose clothing has room."""
import sys, os, numpy as np, cv2
from PIL import Image
from rembg import new_session, remove
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARS = {'terra-nova': {'top': (415, 870, 28), 'bottom': (640, 1290, 26), 'onepiece': (415, 1290, 28), 'shoes': (1265, 1405, 14)}}
sess = new_session('u2net_human_seg')
for d, zones in CHARS.items():
    im = Image.open(f'{root}/public/_refs/{d}/canvas.jpg').convert('RGB'); w, h = im.size
    body = (np.array(remove(im, session=sess, only_mask=True)) > 128).astype(np.uint8)
    for name, (y0, y1, grow) in zones.items():
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1))
        m = cv2.dilate(body, k); band = np.zeros_like(m); band[y0:y1] = 1; m = m * band
        a = np.where(m > 0, 0, 255).astype(np.uint8)
        rgba = np.dstack([np.zeros((h, w, 3), np.uint8), a])
        out = f'{root}/public/_refs/{d}/mask-{name}.png'
        Image.fromarray(rgba, 'RGBA').save(out, optimize=True)
        print(out.replace(root + '/', ''), 'editable %', round(100 * (a == 0).mean(), 1))
