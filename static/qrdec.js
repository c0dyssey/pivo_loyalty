"use strict";
/* Компактный декодер QR (версии 1-6, коррекция M, байтовый режим) — ровно то, что выдаёт наш генератор.
   Без внешних библиотек. API: QRDec.decode({data: RGBA, width, height}) -> строка | null */
(function (root) {
  // ---- поле Галуа
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const gdiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
  const peval = (p, x) => { let y = 0, xp = 1; for (let i = 0; i < p.length; i++) { y ^= gmul(p[i], xp); xp = gmul(xp, x); } return y; }; // p[0] — свободный член

  // ---- Рид-Соломон: коррекция ошибок. cw: [данные..., ec...]
  function rsCorrect(cw, nsym) {
    const n = cw.length, S = new Array(nsym).fill(0);
    let bad = false;
    for (let j = 0; j < nsym; j++) { let y = 0; const a = EXP[j]; for (let i = 0; i < n; i++) y = gmul(y, a) ^ cw[i]; S[j] = y; if (y) bad = true; }
    if (!bad) return cw;
    // Берлекэмп-Мэсси
    let C = [1], B = [1], L = 0, m = 1, b = 1;
    const addShift = (c, bb, coef, sh) => { const r = new Array(Math.max(c.length, bb.length + sh)).fill(0); for (let i = 0; i < c.length; i++) r[i] = c[i]; for (let i = 0; i < bb.length; i++) r[i + sh] ^= gmul(coef, bb[i]); return r; };
    for (let k = 0; k < nsym; k++) {
      let d = S[k]; for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, S[k - i]);
      if (d === 0) { m++; continue; }
      if (2 * L <= k) { const T = C.slice(); C = addShift(C, B, gdiv(d, b), m); L = k + 1 - L; B = T; b = d; m = 1; }
      else { C = addShift(C, B, gdiv(d, b), m); m++; }
    }
    while (C.length > 1 && C[C.length - 1] === 0) C.pop();
    if (C.length - 1 !== L || L * 2 > nsym) return null;
    const pos = [];
    for (let k = 0; k < n; k++) if (peval(C, EXP[(255 - k) % 255]) === 0) pos.push(k);
    if (pos.length !== L) return null;
    const omega = new Array(nsym).fill(0);
    for (let i = 0; i < nsym; i++) for (let j = 0; j <= i && j < C.length; j++) omega[i] ^= gmul(C[j], S[i - j]);
    const dC = []; for (let j = 1; j < C.length; j += 2) dC[j - 1] = C[j]; // формальная производная
    for (let j = 0; j < dC.length; j++) if (dC[j] === undefined) dC[j] = 0;
    const out = cw.slice();
    for (const k of pos) {
      const xi = EXP[(255 - k) % 255], num = gmul(EXP[k], peval(omega, xi)), den = peval(dC, xi);
      if (!den) return null;
      out[n - 1 - k] ^= gdiv(num, den);
    }
    for (let j = 0; j < nsym; j++) { let y = 0; const a = EXP[j]; for (let i = 0; i < n; i++) y = gmul(y, a) ^ out[i]; if (y) return null; }
    return out;
  }

  // ---- таблицы (как в генераторе): версия -> [всего слов, ec на блок, блоков, данных в блоке]
  const M = { 1: [26, 10, 1, 16], 2: [44, 16, 1, 28], 3: [70, 26, 1, 44], 4: [100, 18, 2, 32], 5: [134, 24, 2, 43], 6: [172, 16, 4, 27] };
  const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const FORMATS = [];
  for (let data = 0; data < 32; data++) { let d = data << 10; for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10); FORMATS.push(((data << 10) | d) ^ 0x5412); }
  const pop = (x) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };

  function funcMask(size, ver) {
    const f = new Uint8Array(size * size);
    const set = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) f[r * size + c] = 1; };
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) set(r, c);
    for (let r = 0; r < 9; r++) for (let c = size - 8; c < size; c++) set(r, c);
    for (let r = size - 8; r < size; r++) for (let c = 0; c < 9; c++) set(r, c);
    for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
    if (ver >= 2) { const p = ALIGN[ver]; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(p + dr, p + dc); }
    return f;
  }

  // ---- декодирование сетки модулей (grid[r*size+c] = 1 тёмный)
  function decodeGrid(grid, size) {
    const ver = (size - 17) / 4; if (!M[ver]) return null;
    const at = (r, c) => grid[r * size + c];
    const c1 = (i) => (i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : [size - 15 + i, 8]);
    const c2 = (i) => (i < 8 ? [8, size - i - 1] : i === 8 ? [8, 7] : [8, 14 - i]);
    let w1 = 0, w2 = 0;
    for (let i = 0; i < 15; i++) { const a = c1(i), b = c2(i); w1 |= at(a[0], a[1]) << i; w2 |= at(b[0], b[1]) << i; }
    let best = -1, bd = 99;
    for (const w of [w1, w2]) for (let d = 0; d < 32; d++) { const h = pop(w ^ FORMATS[d]); if (h < bd) { bd = h; best = d; } }
    if (bd > 3 || (best >> 3) !== 0) return null; // только уровень M
    const mask = MASKS[best & 7], fm = funcMask(size, ver);
    const total = M[ver][0] * 8, bits = [];
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < size; k++) {
        const r = up ? size - 1 - k : k;
        for (const c of [col, col - 1]) if (!fm[r * size + c] && bits.length < total) bits.push(at(r, c) ^ (mask(r, c) ? 1 : 0));
      }
      up = !up;
    }
    const cw = []; for (let i = 0; i + 7 < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    const [, ecn, nb, dper] = M[ver], blocks = [], ecs = [];
    for (let b = 0; b < nb; b++) { blocks.push([]); ecs.push([]); }
    let idx = 0;
    for (let i = 0; i < dper; i++) for (let b = 0; b < nb; b++) blocks[b].push(cw[idx++]);
    for (let i = 0; i < ecn; i++) for (let b = 0; b < nb; b++) ecs[b].push(cw[idx++]);
    const data = [];
    for (let b = 0; b < nb; b++) { const fixed = rsCorrect(blocks[b].concat(ecs[b]), ecn); if (!fixed) return null; for (let i = 0; i < dper; i++) data.push(fixed[i]); }
    let bs = ""; for (const v of data) bs += v.toString(2).padStart(8, "0");
    if (bs.slice(0, 4) !== "0100") return null;
    const len = parseInt(bs.slice(4, 12), 2), bytes = [];
    if (12 + len * 8 > bs.length) return null;
    for (let i = 0; i < len; i++) bytes.push(parseInt(bs.slice(12 + i * 8, 20 + i * 8), 2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return null; }
  }

  // ---- бинаризация
  function gray(img) {
    const { data, width: w, height: h } = img, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    // сглаживание 3x3 против шума матрицы камеры (иначе светлые кольца угловых квадратов рвутся)
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = x > 0 ? x - 1 : x, b = x < w - 1 ? x + 1 : x; t[y * w + x] = (g[y * w + a] + g[y * w + x] + g[y * w + b]) / 3; }
    for (let y = 0; y < h; y++) { const a = y > 0 ? y - 1 : y, b = y < h - 1 ? y + 1 : y; for (let x = 0; x < w; x++) o[y * w + x] = (t[a * w + x] + t[y * w + x] + t[b * w + x]) / 3; }
    return o;
  }
  function otsu(g, w, h) {
    const hist = new Array(256).fill(0); for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, mx = 0, th = 128; const tot = g.length;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > mx) { mx = v; th = t; } }
    const bin = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) bin[i] = g[i] <= th ? 1 : 0; return bin;
  }
  function local(g, w, h, s) {
    const W = w + 1, I = new Int32Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; } }
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - s), y1 = Math.min(h, y + s + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - s), x1 = Math.min(w, x + s + 1);
        const sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        bin[y * w + x] = g[y * w + x] * (x1 - x0) * (y1 - y0) < sum * 0.9 ? 1 : 0;
      }
    }
    return bin;
  }

  // ---- поиск трёх угловых квадратов
  function ratioOk(c) {
    let t = 0; for (const v of c) { if (!v) return false; t += v; }
    if (t < 7) return false;
    const u = t / 7, tol = u * 0.65;
    return Math.abs(c[0] - u) < tol && Math.abs(c[1] - u) < tol && Math.abs(c[2] - 3 * u) < 3 * tol && Math.abs(c[3] - u) < tol && Math.abs(c[4] - u) < tol;
  }
  function crossV(bin, w, h, cx, cy) {
    if (!bin[cy * w + cx]) return null;
    const c = [0, 0, 0, 0, 0]; let y = cy;
    while (y >= 0 && bin[y * w + cx]) { c[2]++; y--; } if (y < 0) return null;
    while (y >= 0 && !bin[y * w + cx]) { c[1]++; y--; } if (y < 0) return null;
    while (y >= 0 && bin[y * w + cx]) { c[0]++; y--; }
    y = cy + 1;
    while (y < h && bin[y * w + cx]) { c[2]++; y++; } if (y >= h) return null;
    while (y < h && !bin[y * w + cx]) { c[3]++; y++; } if (y >= h) return null;
    while (y < h && bin[y * w + cx]) { c[4]++; y++; }
    if (!ratioOk(c)) return null;
    return { y: y - c[4] - c[3] - c[2] / 2, t: c[0] + c[1] + c[2] + c[3] + c[4] };
  }
  function crossH(bin, w, cx, cy) {
    if (!bin[cy * w + cx]) return null;
    const c = [0, 0, 0, 0, 0]; let x = cx; const row = cy * w;
    while (x >= 0 && bin[row + x]) { c[2]++; x--; } if (x < 0) return null;
    while (x >= 0 && !bin[row + x]) { c[1]++; x--; } if (x < 0) return null;
    while (x >= 0 && bin[row + x]) { c[0]++; x--; }
    x = cx + 1;
    while (x < w && bin[row + x]) { c[2]++; x++; } if (x >= w) return null;
    while (x < w && !bin[row + x]) { c[3]++; x++; } if (x >= w) return null;
    while (x < w && bin[row + x]) { c[4]++; x++; }
    if (!ratioOk(c)) return null;
    return { x: x - c[4] - c[3] - c[2] / 2, t: c[0] + c[1] + c[2] + c[3] + c[4] };
  }
  function findFinders(bin, w, h) {
    const cands = [];
    for (let y = 0; y < h; y++) {
      let st = 0, c = [0, 0, 0, 0, 0];
      for (let x = 0; x < w; x++) {
        const dark = bin[y * w + x] === 1;
        if (dark === (st % 2 === 0)) { c[st]++; continue; }
        if (st === 0 && c[0] === 0) continue;
        if (st === 4) {
          if (ratioOk(c)) {
            const cx = Math.floor(x - c[4] - c[3] - c[2] / 2);
            const v = crossV(bin, w, h, cx, y);
            if (v) {
              const cy = Math.floor(v.y), hh = crossH(bin, w, cx, cy);
              if (hh) {
                const px = hh.x, py = v.y, sz = (v.t + hh.t) / 14;
                let f = cands.find((q) => Math.abs(q.x - px) < q.s * 1.2 && Math.abs(q.y - py) < q.s * 1.2);
                if (f) { f.x = (f.x * f.n + px) / (f.n + 1); f.y = (f.y * f.n + py) / (f.n + 1); f.s = (f.s * f.n + sz) / (f.n + 1); f.n++; }
                else cands.push({ x: px, y: py, s: sz, n: 1 });
              }
            }
          }
          c = [c[2], c[3], c[4], 1, 0]; st = 3;
        } else { st++; c[st] = 1; }
      }
    }
    return cands;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function pickTriple(cands) {
    let pool = cands.filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
    if (pool.length < 3) pool = cands.slice().sort((a, b) => b.n - a.n).slice(0, 8);
    let best = null;
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
      const t = [pool[i], pool[j], pool[k]], sz = t.map((q) => q.s);
      if (Math.max(...sz) / Math.min(...sz) > 1.8) continue;
      for (let o = 0; o < 3; o++) {
        const A = t[o], B = t[(o + 1) % 3], Cc = t[(o + 2) % 3];
        const d1 = dist(A, B), d2 = dist(A, Cc), hy = dist(B, Cc);
        const sc = Math.abs(d1 - d2) / Math.max(d1, d2) + Math.abs(hy * hy - (d1 * d1 + d2 * d2)) / (hy * hy);
        if (sc < 0.45 && (!best || sc < best.sc)) best = { sc, tl: A, a: B, b: Cc };
      }
    }
    if (!best) return null;
    let { tl, a, b } = best;
    const cross = (a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x);
    return cross > 0 ? { tl, tr: a, bl: b } : { tl, tr: b, bl: a };
  }

  // гомография по 4 точкам (src -> dst), h33 = 1
  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
    }
    for (let i = 0; i < 8; i++) {
      let p = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-9) return null;
      [A[i], A[p]] = [A[p], A[i]];
      for (let r = 0; r < 8; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < 9; c++) A[r][c] -= f * A[i][c]; }
    }
    return A.map((row, i) => row[8] / row[i]).concat([1]);
  }
  function sample(bin, w, h, Hm, dim) {
    const grid = new Uint8Array(dim * dim), offs = [[0, 0], [-0.22, 0], [0.22, 0], [0, -0.22], [0, 0.22]];
    for (let r = 0; r < dim; r++) for (let c = 0; c < dim; c++) {
      let votes = 0;
      for (const [dx, dy] of offs) {
        const u = c + 0.5 + dx, v = r + 0.5 + dy, d = Hm[6] * u + Hm[7] * v + 1;
        const px = Math.round((Hm[0] * u + Hm[1] * v + Hm[2]) / d), py = Math.round((Hm[3] * u + Hm[4] * v + Hm[5]) / d);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        votes += bin[py * w + px];
      }
      grid[r * dim + c] = votes >= 3 ? 1 : 0;
    }
    return grid;
  }
  const BR_OFFS = (() => { const o = []; for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) o.push([i * 0.25, j * 0.25]); return o.sort((p, q) => Math.hypot(...p) - Math.hypot(...q)); })();

  function tryBin(bin, w, h) {
    const cands = findFinders(bin, w, h);
    if (cands.length < 3) return null;
    const T = pickTriple(cands); if (!T) return null;
    const modsz = (T.tl.s + T.tr.s + T.bl.s) / 3, d = (dist(T.tl, T.tr) + dist(T.tl, T.bl)) / 2;
    const raw = d / modsz + 7, base = Math.round((raw - 17) / 4) * 4 + 17;
    for (const dim of [base, base - 4, base + 4]) {
      if (dim < 21 || dim > 41) continue;
      const m = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], [dim - 3.5, dim - 3.5]];
      const br = { x: T.tr.x + T.bl.x - T.tl.x, y: T.tr.y + T.bl.y - T.tl.y };
      for (const [ox, oy] of BR_OFFS) {
        const Hm = homography(m, [[T.tl.x, T.tl.y], [T.tr.x, T.tr.y], [T.bl.x, T.bl.y], [br.x + ox * modsz, br.y + oy * modsz]]);
        if (!Hm) continue;
        const res = decodeGrid(sample(bin, w, h, Hm, dim), dim);
        if (res) return res;
      }
    }
    return null;
  }

  function decode(img) {
    const { width: w, height: h } = img, g = gray(img);
    const tries = [() => local(g, w, h, Math.max(8, Math.round(Math.min(w, h) / 8))), () => otsu(g, w, h),
      () => local(g, w, h, Math.max(8, Math.round(Math.min(w, h) / 3))), () => local(g, w, h, Math.max(6, Math.round(Math.min(w, h) / 20)))];
    for (const t of tries) { const r = tryBin(t(), w, h); if (r) return r; }
    return null;
  }
  root.QRDec = { decode };
})(typeof window !== "undefined" ? window : globalThis);
