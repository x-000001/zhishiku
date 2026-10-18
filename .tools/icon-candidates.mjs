/**
 * 图标方案候选稿（0.9.x 重设计，仅出图给眼睛验收，不写 resources）。
 *
 * 方案 B「微光节点」：近黑 squircle 底板 + 白色节点矩阵（四角 + 中心），中心节点是唯一一处
 *   极光亮蓝；隐喻「海量数据里亮起来的那一点」。
 * 方案 C「无尽折叠」：近黑底板 + 两片互成 90° 的白色半圆「折面」，接缝处留一道窄缝和一粒
 *   极小极光蓝，隐喻「同一件事的两个面向折到一起」。
 *
 * 输出到 .tools/icon-candidates/：B-512.png / C-512.png / sheet.png（1:1 多尺寸 + 16px 放大）
 * 运行：node .tools/icon-candidates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'icon-candidates');
fs.mkdirSync(outDir, { recursive: true });

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 光栅化小工具 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 半圆（D 形）SDF：flat 轴方向 'up' 表示平边在下、鼓包朝上；rc 是平边两角的圆角 */
function sdHalfDisc(px, py, cx, cy, radius, dir, rc) {
  const dx = px - cx;
  const dy = py - cy;
  const circle = Math.hypot(dx, dy) - radius;
  let flat;
  if (dir === 'up') flat = py - cy;
  else if (dir === 'down') flat = cy - py;
  else if (dir === 'left') flat = px - cx;
  else flat = cx - px;
  if (rc <= 0) return Math.max(circle, flat);
  // 圆滑地把半平面和圆求交（只软化相交处的角）
  const h = clamp01(0.5 - (0.5 * (flat - circle)) / rc);
  const d = lerp(flat, circle, h) - rc * h * (1 - h);
  return d;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/* ---------------- 颜色 ---------------- */

const PLATE = [10, 11, 16];
const PLATE_EDGE = [24, 26, 34];
const WHITE = [255, 255, 255];
const AURORA = [94, 231, 230];
const AURORA_DEEP = [52, 211, 235];

/* ---------------- 两个候选方案 ---------------- */

/**
 * 方案 B：微光节点。
 * 5 个节点（四角 + 中心）构成矩阵骨架，中心节点是唯一一处极光色。
 * 小尺寸时把点加粗、间距拉开（tiny），否则 16px 会糊成一团白。
 */
function renderNode(size) {
  const ss = size <= 32 ? 8 : 4;
  const N = size * ss;
  const buf = new Uint8Array(size * size * 4);
  const margin = 0.085 * N;
  const plateW = N - margin * 2;
  const cx = N / 2;
  const cy = N / 2;
  const plateR = plateW * 0.22;
  const tiny = size <= 32;
  const dotR = plateW * (tiny ? 0.115 : 0.095);
  const step = plateW * (tiny ? 0.27 : 0.245);

  const accum = new Float32Array(size * size * 4);
  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const px = sx + 0.5;
      const py = sy + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const dPlate = sdRoundRect(px, py, cx, cy, plateW / 2, plateW / 2, plateR);
      const plateA = clamp01(0.5 - dPlate);
      if (plateA > 0) {
        // 近黑底 + 极其微弱的顶部内发光（材质感，不是渐变装饰）
        const t = clamp01((py - (cy - plateW / 2)) / plateW);
        let col = mix(PLATE_EDGE, PLATE, smoothstep(0, 0.35, t));
        const inner = Math.max(0, -dPlate);
        const glow = 1 - smoothstep(0, plateW * 0.16, inner);
        col = mix(col, [40, 44, 58], glow * 0.35 * (1 - t) * 0.5);
        r = col[0];
        g = col[1];
        b = col[2];
        a = plateA;
      }

      // 节点：四角 + 中心。中心是极光色
      const pts = [
        [-step, -step, false],
        [step, -step, false],
        [-step, step, false],
        [step, step, false],
        [0, 0, true]
      ];
      for (const [ox, oy, accent] of pts) {
        const rr = accent ? dotR * 1.18 : dotR;
        const d = sdCircle(px, py, cx + ox, cy + oy, rr);
        const cover = clamp01(0.5 - d);
        if (cover <= 0) continue;
        const dotCol = accent ? mix(AURORA, AURORA_DEEP, smoothstep(0.2, -0.6, d)) : WHITE;
        r = lerp(r, dotCol[0], cover);
        g = lerp(g, dotCol[1], cover);
        b = lerp(b, dotCol[2], cover);
        a = Math.max(a, cover * (accent ? 1 : 0.98));
      }

      const idx = (sy * ss) * ss * 0 + 0;
      void idx;
      // 累加到目标像素（超采样盒式平均，带 alpha）
      const dx = Math.floor(sx / ss);
      const dy = Math.floor(sy / ss);
      const o = (dy * size + dx) * 4;
      accum[o] += r * a;
      accum[o + 1] += g * a;
      accum[o + 2] += b * a;
      accum[o + 3] += a;
    }
  }

  const per = ss * ss;
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    const alpha = accum[o + 3] / per;
    if (alpha <= 0.0001) {
      buf[o] = 0;
      buf[o + 1] = 0;
      buf[o + 2] = 0;
      buf[o + 3] = 0;
      continue;
    }
    buf[o] = Math.round(accum[o] / per / alpha);
    buf[o + 1] = Math.round(accum[o + 1] / per / alpha);
    buf[o + 2] = Math.round(accum[o + 2] / per / alpha);
    buf[o + 3] = Math.round(clamp01(alpha) * 255);
  }
  return buf;
}

/**
 * 方案 C：无尽折叠（双环交织）。
 * 两个加粗的圆环左右咬合，重量感压住 16px；环心负空间让它一眼就是「无限」符号。
 * 咬合处留一粒极光蓝，是唯一一处彩色。
 */
function renderFold(size) {
  const ss = size <= 32 ? 8 : 4;
  const N = size * ss;
  const buf = new Uint8Array(size * size * 4);
  const margin = 0.085 * N;
  const plateW = N - margin * 2;
  const cx = N / 2;
  const cy = N / 2;
  const plateR = plateW * 0.22;
  const tiny = size <= 32;
  const ringR = plateW * (tiny ? 0.268 : 0.246);
  const stroke = plateW * (tiny ? 0.132 : 0.118);
  const offset = plateW * (tiny ? 0.196 : 0.184);
  const halfStroke = stroke / 2;

  const accum = new Float32Array(size * size * 4);
  for (let sy = 0; sy < N; sy += 1) {
    for (let sx = 0; sx < N; sx += 1) {
      const px = sx + 0.5;
      const py = sy + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const dPlate = sdRoundRect(px, py, cx, cy, plateW / 2, plateW / 2, plateR);
      const plateA = clamp01(0.5 - dPlate);
      if (plateA > 0) {
        const t = clamp01((py - (cy - plateW / 2)) / plateW);
        const col = mix(PLATE_EDGE, PLATE, smoothstep(0, 0.35, t));
        r = col[0];
        g = col[1];
        b = col[2];
        a = plateA;
      }

      // 两个圆环的有符号距离，取并集（咬合）
      const dLeft = Math.abs(Math.hypot(px - (cx - offset), py - cy) - ringR) - halfStroke;
      const dRight = Math.abs(Math.hypot(px - (cx + offset), py - cy) - ringR) - halfStroke;
      const ring = Math.min(dLeft, dRight);
      const cover = clamp01(0.5 - ring);
      if (cover > 0) {
        r = lerp(r, WHITE[0], cover);
        g = lerp(g, WHITE[1], cover);
        b = lerp(b, WHITE[2], cover);
        a = Math.max(a, cover);
      }

      // 咬合正中的一粒极光
      const dAccent = sdCircle(px, py, cx, cy, plateW * (tiny ? 0.042 : 0.033));
      const accentCover = clamp01(0.5 - dAccent);
      if (accentCover > 0) {
        r = lerp(r, AURORA[0], accentCover);
        g = lerp(g, AURORA[1], accentCover);
        b = lerp(b, AURORA[2], accentCover);
        a = Math.max(a, accentCover);
      }

      const dx = Math.floor(sx / ss);
      const dy = Math.floor(sy / ss);
      const o = (dy * size + dx) * 4;
      accum[o] += r * a;
      accum[o + 1] += g * a;
      accum[o + 2] += b * a;
      accum[o + 3] += a;
    }
  }

  const per = ss * ss;
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    const alpha = accum[o + 3] / per;
    if (alpha <= 0.0001) {
      buf[o] = 0;
      buf[o + 1] = 0;
      buf[o + 2] = 0;
      buf[o + 3] = 0;
      continue;
    }
    buf[o] = Math.round(accum[o] / per / alpha);
    buf[o + 1] = Math.round(accum[o + 1] / per / alpha);
    buf[o + 2] = Math.round(accum[o + 2] / per / alpha);
    buf[o + 3] = Math.round(clamp01(alpha) * 255);
  }
  return buf;
}

const DESIGNS = [
  { key: 'B', name: '微光节点', render: renderNode },
  { key: 'C', name: '无尽折叠', render: renderFold }
];

for (const design of DESIGNS) {
  fs.writeFileSync(path.join(outDir, `${design.key}-512.png`), encodePng(512, 512, design.render(512)));
}

/* ---------------- 验收拼图 ---------------- */

function composite(canvasW, canvasH, bg) {
  const rgba = new Uint8Array(canvasW * canvasH * 4);
  for (let i = 0; i < canvasW * canvasH; i += 1) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function blit(canvas, canvasW, canvasH, img, size, atX, atY) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = atX + x;
      const dy = atY + y;
      if (dx < 0 || dy < 0 || dx >= canvasW || dy >= canvasH) continue;
      const si = (y * size + x) * 4;
      const di = (dy * canvasW + dx) * 4;
      const alpha = img[si + 3] / 255;
      if (alpha <= 0) continue;
      canvas[di] = Math.round(img[si] * alpha + canvas[di] * (1 - alpha));
      canvas[di + 1] = Math.round(img[si + 1] * alpha + canvas[di + 1] * (1 - alpha));
      canvas[di + 2] = Math.round(img[si + 2] * alpha + canvas[di + 2] * (1 - alpha));
    }
  }
}

/** 最近邻放大（用来看 16px 真实像素） */
function zoomNE(img, size, factor) {
  const out = new Uint8Array(size * factor * size * factor * 4);
  for (let y = 0; y < size * factor; y += 1) {
    for (let x = 0; x < size * factor; x += 1) {
      const si = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4;
      const di = (y * size * factor + x) * 4;
      out[di] = img[si];
      out[di + 1] = img[si + 1];
      out[di + 2] = img[si + 2];
      out[di + 3] = img[si + 3];
    }
  }
  return out;
}

const SIZES = [128, 64, 48, 32, 24, 16];
const SHEET_W = 1180;
const SHEET_H = 760;
const sheet = composite(SHEET_W, SHEET_H, [237, 239, 244]);
// 深色区块
for (let y = 380; y < SHEET_H; y += 1) {
  for (let x = 0; x < SHEET_W; x += 1) {
    const di = (y * SHEET_W + x) * 4;
    sheet[di] = 16;
    sheet[di + 1] = 17;
    sheet[di + 2] = 22;
  }
}

DESIGNS.forEach((design, row) => {
  const baseY = row * 380 + 24;
  let x = 24;
  // 128 主图
  const big = design.render(128);
  blit(sheet, SHEET_W, SHEET_H, big, 128, x, baseY + 40);
  x += 150;
  // 1:1 小尺寸
  for (const size of SIZES) {
    const img = design.render(size);
    const y = baseY + 40 + Math.round((128 - size) / 2);
    blit(sheet, SHEET_W, SHEET_H, img, size, x, y);
    x += size + 18;
  }
  // 16px 放大 8 倍（最近邻）
  const small = zoomNE(design.render(16), 16, 8);
  blit(sheet, SHEET_W, SHEET_H, small, 128, x + 8, baseY + 40);
});

fs.writeFileSync(path.join(outDir, 'sheet.png'), encodePng(SHEET_W, SHEET_H, sheet));

console.log('CANDIDATES_OK', DESIGNS.map((d) => `${d.key}=${d.name}`).join(' '));
