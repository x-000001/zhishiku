/**
 * 应用图标生成器（0.9.1，「无尽折叠」方案）：纯 Node、零依赖，手写「SDF 光栅化 + PNG 编码」。
 *
 * 设计：近黑 squircle 底板（#0A0B10，上面一条 1px 的极弱内高光）+ 两个白色圆环咬合成 ∞
 * + 正中心一粒极光蓝（#5EE7E6）。
 *
 * 为什么不用位图缩放：所有尺寸都从同一套 SDF 几何原生渲染（覆盖率抗锯齿），
 * 16/24/32px 另外跑 8× 超采样，避免小尺寸出现锯齿或被糊成一团灰。
 *
 * 小尺寸专版（≤32px，代码里自动切换）：
 *   - 环壁 0.118W → 0.132W（16px 下环壁约 2px）
 *   - 环半径 0.246W → 0.268W、两环中心距 ±0.184W → ±0.196W（16px 下仍留约 2px 的环孔）
 *   - 中心极光点 0.033W → 0.042W（16px 下至少 1 个实心像素）
 *   - 圆心落在半像素网格上，左右两侧灰度对称
 *
 * 产物：
 *   resources/icon.png     512×512（窗口图标 / extraResources）
 *   resources/icon.ico     16/24/32/48/64/128/256 七档（Windows 快捷方式 / 任务栏）
 *   resources/tray.png     32×32（托盘，运行时缩到 16）
 *   .tools/icon-preview.png 多尺寸对照图（只供肉眼验收，不进 resources）
 *
 * 重新生成：node .tools/gen-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const resDir = path.join(root, 'resources');

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

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
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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

/* ------------------------------------------------------------------ */
/* 光栅化小工具                                                        */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** 圆角矩形有符号距离场（<0 在内部）。用半宽/半高/圆角半径描述 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 圆环的有符号距离场 */
function sdRing(px, py, cx, cy, radius, halfStroke) {
  return Math.abs(Math.hypot(px - cx, py - cy) - radius) - halfStroke;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/* ------------------------------------------------------------------ */
/* 调色板                                                              */
/* ------------------------------------------------------------------ */

const PLATE = [10, 11, 16]; // #0A0B10
const PLATE_TOP_GLOW = [255, 255, 255];
const WHITE = [255, 255, 255];
const AURORA = [94, 231, 230]; // #5EE7E6

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

/**
 * 渲染一张图标。
 * @param {number} size 目标边长（像素）
 * @param {{ margin?: number, tinyGeometry?: boolean }} [opts]
 *   margin: 底板四周留白比例（对外透明边），默认 0.085
 *   tinyGeometry: 强制使用小尺寸几何（托盘图标用，因为运行时还要缩到 16px）
 */
function render(size, opts = {}) {
  const marginRatio = opts.margin ?? 0.06;
  // 小尺寸多超采样，保证边缘不发毛
  const ss = size <= 32 ? 8 : 4;
  const N = size * ss;
  const buf = new Uint8Array(size * size * 4);
  const accum = new Float32Array(size * size * 4);

  const margin = marginRatio * N;
  const plateW = N - margin * 2;
  const cx = N / 2;
  const cy = N / 2;
  const tiny = opts.tinyGeometry ?? size <= 32;

  // 半像素对齐：圆心落在 0.5 像素网格上（超采样下是 0.5*ss 网格），左右完全对称
  const snap = (value) => Math.round(value * ss) / ss;
  const ringCx = snap(cx);

  const plateR = plateW * (tiny ? 0.235 : 0.22);
  // 图形整体略收一点，四周给底板留呼吸感（否则环会贴到板边）
  const ringR = plateW * (tiny ? 0.235 : 0.22);
  const halfStroke = (plateW * (tiny ? 0.115 : 0.1)) / 2;
  const offset = plateW * (tiny ? 0.196 : 0.206);
  const accentR = plateW * (tiny ? 0.038 : 0.03);
  // 顶部内高光只占极窄一条（约 1 个目标像素）
  const glowH = Math.max(1, 1.2 * ss);

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
        let col = PLATE;
        // 顶部一条极弱内高光（inset 0 1px 1px rgba(255,255,255,0.15) 的等价实现）
        const topEdge = cy - plateW / 2;
        const glowT = clamp01((py - topEdge) / glowH);
        if (py < topEdge + glowH) {
          const alpha = 0.15 * (1 - glowT) * (1 - glowT);
          col = mix(col, PLATE_TOP_GLOW, alpha);
        }
        r = col[0];
        g = col[1];
        b = col[2];
        a = plateA;
      }

      // 两个环取并集，重叠处连成 ∞ 的腰
      const dLeft = sdRing(px, py, ringCx - offset, cy, ringR, halfStroke);
      const dRight = sdRing(px, py, ringCx + offset, cy, ringR, halfStroke);
      const cover = clamp01(0.5 - Math.min(dLeft, dRight));
      if (cover > 0) {
        r = lerp(r, WHITE[0], cover);
        g = lerp(g, WHITE[1], cover);
        b = lerp(b, WHITE[2], cover);
        a = Math.max(a, cover);
      }

      // 正中一粒极光
      const accentCover = clamp01(0.5 - sdCircle(px, py, ringCx, cy, accentR));
      if (accentCover > 0) {
        r = lerp(r, AURORA[0], accentCover);
        g = lerp(g, AURORA[1], accentCover);
        b = lerp(b, AURORA[2], accentCover);
        a = Math.max(a, accentCover);
      }

      const di = Math.floor(sy / ss);
      const dj = Math.floor(sx / ss);
      const o = (di * size + dj) * 4;
      accum[o] += r * a;
      accum[o + 1] += g * a;
      accum[o + 2] += b * a;
      accum[o + 3] += a;
    }
  }

  // 盒式降采样：先把颜色按 alpha 加权平均，再还原直通 alpha
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

/* ------------------------------------------------------------------ */
/* ICO 容器（PNG-in-ICO）                                              */
/* ------------------------------------------------------------------ */

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0; // palette
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bpp
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)]);
}

/* ------------------------------------------------------------------ */
/* 出图                                                                */
/* ------------------------------------------------------------------ */

const iconPng = encodePng(512, 512, render(512));
fs.writeFileSync(path.join(resDir, 'icon.png'), iconPng);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoEntries = icoSizes.map((size) => ({ size, png: encodePng(size, size, render(size, { margin: 0.03 })) }));
fs.writeFileSync(path.join(resDir, 'icon.ico'), makeIco(icoEntries));

// 托盘：Windows 实际按 16px 显示，所以直接用「小尺寸几何」并加大白量
const trayPng = encodePng(32, 32, render(32, { margin: 0.012, tinyGeometry: true }));
fs.writeFileSync(path.join(resDir, 'tray.png'), trayPng);

/* ------------------------------------------------------------------ */
/* 预览拼图：眼睛验收 16/24/32px 到底糊不糊                            */
/* ------------------------------------------------------------------ */

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

/** 最近邻放大，用来看 16px 的真实像素 */
function zoomNearest(img, size, factor) {
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

const SHEET_W = 1180;
const SHEET_H = 470;
const light = [237, 239, 244];
const dark = [16, 17, 22];
const sheet = composite(SHEET_W, SHEET_H, light);
// 下半区换成深色背景，检查深色任务栏下的可读性
for (let y = 250; y < SHEET_H; y += 1) {
  for (let x = 0; x < SHEET_W; x += 1) {
    const i = (y * SHEET_W + x) * 4;
    sheet[i] = dark[0];
    sheet[i + 1] = dark[1];
    sheet[i + 2] = dark[2];
  }
}

const sizes = [128, 64, 48, 32, 24, 16];
for (const [row, baseY] of [0, 250].entries()) {
  let x = 26;
  const big = render(128);
  blit(sheet, SHEET_W, SHEET_H, big, 128, x, baseY + 34);
  x += 152;
  for (const size of sizes) {
    const img = render(size);
    const y = baseY + 34 + Math.round((128 - size) / 2);
    blit(sheet, SHEET_W, SHEET_H, img, size, x, y);
    x += size + 20;
  }
  // 16px 放大 8 倍（最近邻），看真实像素
  const small = zoomNearest(render(16), 16, 8);
  blit(sheet, SHEET_W, SHEET_H, small, 128, x + 10, baseY + 34);
}

fs.writeFileSync(path.join(root, '.tools', 'icon-preview.png'), encodePng(SHEET_W, SHEET_H, sheet));

console.log(
  `ICON_OK icon.png=${iconPng.length}B ico=${fs.statSync(path.join(resDir, 'icon.ico')).size}B tray=${trayPng.length}B`
);
