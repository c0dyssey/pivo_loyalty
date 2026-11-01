"""Минимальный генератор QR-кодов (без внешних библиотек).

Режим: байты (UTF-8), уровень коррекции M, версии 1-6 (до 106 байт).
Используется для QR-кода клиента; ссылка на сам сервер в QR не встраивается.
"""
import struct
import zlib

# версия: (всего кодовых слов, EC-слов на блок, блоков, данных в блоке)
_M = {
    1: (26, 10, 1, 16),
    2: (44, 16, 1, 28),
    3: (70, 26, 1, 44),
    4: (100, 18, 2, 32),
    5: (134, 24, 2, 43),
    6: (172, 16, 4, 27),
}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34]}

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _rs_gen(n):
    g = [1]
    for i in range(n):
        ng = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            ng[j] ^= c
            ng[j + 1] ^= _mul(c, _EXP[i])
        g = ng
    return g


def _rs_encode(data, n):
    gen = _rs_gen(n)
    res = list(data) + [0] * n
    for i in range(len(data)):
        c = res[i]
        if c:
            for j in range(1, len(gen)):
                res[i + j] ^= _mul(gen[j], c)
    return res[len(data):]


def _bch_format(data):
    d = data << 10
    g = 0x537
    for i in range(14, 9, -1):
        if (d >> i) & 1:
            d ^= g << (i - 10)
    return ((data << 10) | d) ^ 0x5412


def _build_codewords(payload, ver):
    total, ecn, nblocks, dper = _M[ver]
    cap = nblocks * dper
    bits = "0100" + format(len(payload), "08b") + "".join(format(b, "08b") for b in payload)
    bits += "0" * min(4, cap * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    data = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    k = 0
    while len(data) < cap:
        data.append(pad[k % 2])
        k += 1
    blocks = [data[i * dper:(i + 1) * dper] for i in range(nblocks)]
    ecs = [_rs_encode(b, ecn) for b in blocks]
    out = []
    for i in range(dper):
        for b in blocks:
            out.append(b[i])
    for i in range(ecn):
        for e in ecs:
            out.append(e[i])
    return out


def _mask_fn(m):
    return [
        lambda r, c: (r + c) % 2 == 0,
        lambda r, c: r % 2 == 0,
        lambda r, c: c % 3 == 0,
        lambda r, c: (r + c) % 3 == 0,
        lambda r, c: (r // 2 + c // 3) % 2 == 0,
        lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
        lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
        lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
    ][m]


def _penalty(mod):
    n = len(mod)
    score = 0
    for grid in (mod, [list(r) for r in zip(*mod)]):
        for row in grid:
            run = 1
            for i in range(1, n):
                if row[i] == row[i - 1]:
                    run += 1
                else:
                    if run >= 5:
                        score += run - 2
                    run = 1
            if run >= 5:
                score += run - 2
            s = "".join("1" if v else "0" for v in row)
            score += 40 * (s.count("10111010000") + s.count("00001011101"))
    for r in range(n - 1):
        for c in range(n - 1):
            if mod[r][c] == mod[r][c + 1] == mod[r + 1][c] == mod[r + 1][c + 1]:
                score += 3
    dark = sum(sum(1 for v in r if v) for r in mod)
    score += 10 * (abs(dark * 100 // (n * n) - 50) // 5)
    return score


def make_matrix(text):
    payload = text.encode("utf-8")
    ver = None
    for v in range(1, 7):
        if len(payload) <= _M[v][2] * _M[v][3] - 2:
            ver = v
            break
    if ver is None:
        raise ValueError("Слишком длинный текст для QR")
    size = 17 + 4 * ver
    mod = [[False] * size for _ in range(size)]
    res = [[False] * size for _ in range(size)]

    def finder(r0, c0):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = r0 + r, c0 + c
                if 0 <= rr < size and 0 <= cc < size:
                    res[rr][cc] = True
                    inside = 0 <= r <= 6 and 0 <= c <= 6
                    mod[rr][cc] = inside and (
                        r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4)
                    )

    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)
    for i in range(8, size - 8):
        mod[6][i] = mod[i][6] = (i % 2 == 0)
        res[6][i] = res[i][6] = True
    if ver >= 2:
        p = _ALIGN[ver][-1]
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                mod[p + dr][p + dc] = max(abs(dr), abs(dc)) != 1
                res[p + dr][p + dc] = True
    for i in range(9):
        res[8][i] = res[i][8] = True
    for i in range(8):
        res[8][size - 1 - i] = True
        res[size - 1 - i][8] = True
    res[size - 8][8] = True
    mod[size - 8][8] = True

    cw = _build_codewords(payload, ver)
    bits = []
    for b in cw:
        bits.extend((b >> (7 - i)) & 1 for i in range(8))
    bits.extend([0] * (0 if ver == 1 else 7))

    pos = []
    col, up = size - 1, True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if up else range(size)
        for r in rows:
            for c in (col, col - 1):
                if not res[r][c]:
                    pos.append((r, c))
        up = not up
        col -= 2

    best = None
    for m in range(8):
        f = _mask_fn(m)
        cand = [row[:] for row in mod]
        for i, (r, c) in enumerate(pos):
            v = bits[i] if i < len(bits) else 0
            cand[r][c] = bool(v ^ (1 if f(r, c) else 0))
        fb = _bch_format((0b00 << 3) | m)
        for i in range(15):
            v = bool((fb >> i) & 1)
            if i < 6:
                cand[i][8] = v
            elif i < 8:
                cand[i + 1][8] = v
            else:
                cand[size - 15 + i][8] = v
            if i < 8:
                cand[8][size - i - 1] = v
            elif i < 9:
                cand[8][15 - i - 1 + 1] = v
            else:
                cand[8][15 - i - 1] = v
        cand[size - 8][8] = True
        sc = _penalty(cand)
        if best is None or sc < best[0]:
            best = (sc, cand)
    return best[1]


def to_png(text, scale=10, border=4):
    mat = make_matrix(text)
    n = len(mat)
    w = (n + 2 * border) * scale
    rows = bytearray()
    for r in range(n + 2 * border):
        line = bytearray()
        for c in range(n + 2 * border):
            rr, cc = r - border, c - border
            dark = 0 <= rr < n and 0 <= cc < n and mat[rr][cc]
            line += (b"\x00" if dark else b"\xff") * scale
        for _ in range(scale):
            rows += b"\x00" + line

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, w, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def to_svg(text, border=4):
    mat = make_matrix(text)
    n = len(mat)
    d = []
    for r in range(n):
        for c in range(n):
            if mat[r][c]:
                d.append(f"M{c + border},{r + border}h1v1h-1z")
    t = n + 2 * border
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {t} {t}" shape-rendering="crispEdges">'
        f'<rect width="{t}" height="{t}" fill="#fff"/><path d="{"".join(d)}"/></svg>'
    )
