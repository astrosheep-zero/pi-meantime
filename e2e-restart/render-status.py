"""Reconstruct the cells of the captured 140x48 PTY, preserving cursor rewrites.

This is a deterministic text rendering of a real terminal capture, not a browser
screenshot. Color/style are intentionally omitted; character positions remain.
"""
import json
import pathlib
import re
import sys
from wcwidth import wcwidth
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = ROOT / 'evidence' / 'restart' / sys.argv[1]
columns, lines = 140, 48
screen = [[' '] * columns for _ in range(lines)]
row = col = 0
saved = (0, 0)
raw = (DIR / 'tui-after-status.ansi').read_bytes().decode('utf-8', errors='replace')
csi = re.compile(r'\x1b\[([0-?]*)([ -/]*)([@-~])')
i = 0
while i < len(raw):
    char = raw[i]
    if char == '\x1b':
        if raw.startswith('\x1b]', i):
            end_bell, end_st = raw.find('\x07', i + 2), raw.find('\x1b\\', i + 2)
            ends = [(p, n) for p, n in [(end_bell, 1), (end_st, 2)] if p >= 0]
            if not ends:
                break
            pos, count = min(ends)
            i = pos + count
            continue
        match = csi.match(raw, i)
        if match:
            param, _, op = match.groups()
            values = [int(value or 0) for value in param.lstrip('?=>').split(';') if (value or '0').isdigit()]
            n = (values[0] or 1) if values else 1
            if op in ['H', 'f']:
                row = min(lines - 1, max(0, (values[0] if values else 1) - 1))
                col = min(columns - 1, max(0, (values[1] if len(values) > 1 else 1) - 1))
            elif op == 'A': row = max(0, row - n)
            elif op in ['B', 'e']: row = min(lines - 1, row + n)
            elif op in ['C', 'a']: col = min(columns - 1, col + n)
            elif op == 'D': col = max(0, col - n)
            elif op in ['G', '`']: col = min(columns - 1, n - 1)
            elif op == 'd': row = min(lines - 1, n - 1)
            elif op == 'E': row, col = min(lines - 1, row + n), 0
            elif op == 'F': row, col = max(0, row - n), 0
            elif op == 'J':
                mode = values[0] if values else 0
                if mode in [2, 3]: screen = [[' '] * columns for _ in range(lines)]
                elif mode == 0:
                    screen[row][col:] = [' '] * (columns - col)
                    for y in range(row + 1, lines): screen[y] = [' '] * columns
                elif mode == 1:
                    for y in range(row): screen[y] = [' '] * columns
                    screen[row][:col + 1] = [' '] * (col + 1)
            elif op == 'K':
                mode = values[0] if values else 0
                if mode == 2: screen[row] = [' '] * columns
                elif mode == 0: screen[row][col:] = [' '] * (columns - col)
                elif mode == 1: screen[row][:col + 1] = [' '] * (col + 1)
            elif op == 's': saved = (row, col)
            elif op == 'u': row, col = saved
            elif op == 'h' and param == '?1049':
                screen = [[' '] * columns for _ in range(lines)]; row = col = 0
            i = match.end()
            continue
        i += 2
        continue
    if char == '\r': col = 0
    elif char == '\n':
        row += 1
        if row >= lines: screen.pop(0); screen.append([' '] * columns); row = lines - 1
    elif char == '\b': col = max(0, col - 1)
    elif char == '\t': col = min(columns - 1, (col // 8 + 1) * 8)
    elif ord(char) >= 32:
        width = max(0, wcwidth(char))
        if col + width > columns:
            col = 0; row += 1
            if row >= lines: screen.pop(0); screen.append([' '] * columns); row = lines - 1
        if width:
            screen[row][col] = char
            if width == 2 and col + 1 < columns: screen[row][col + 1] = ''
            col += width
        elif col > 0: screen[row][col - 1] += char
    i += 1

text = '\n'.join(''.join(line).rstrip() for line in screen)
(DIR / 'status-screen.txt').write_text(text + '\n')
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 15)
cell_width, line_height = 10, 21
image = Image.new('RGB', (columns * cell_width + 32, lines * line_height + 66), '#151922')
draw = ImageDraw.Draw(image)
draw.text((16, 12), 'Captured Pi PTY after /bg status | 140x48 | reconstructed terminal cells', font=font, fill='#b9c7d9')
for y, line in enumerate(screen):
    for x, char in enumerate(line):
        if char.strip(): draw.text((16 + x * cell_width, 46 + y * line_height), char, font=font, fill='#eef2f8')
image.save(DIR / 'status-screen.png')
print(json.dumps({'text': str(DIR / 'status-screen.txt'), 'renderedCapture': str(DIR / 'status-screen.png')}))
