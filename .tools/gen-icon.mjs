/**
 * 应用图标生成器（0.9.0）：纯 Node、零依赖，手写「软件光栅化 + PNG 编码」。
 *
 * 设计：圆角矩形底板（圆角 22%）+ 自上而下品牌蓝渐变 + 顶部内高光 + 柔和外投影，
 * 中心是两张略微错落、带 10°~15° 透视倾斜的白色卡片，右下角挂一个米黄「索引节点」
 * 和小连线，象征「知识卡片 + 灵感索引」。
 *
 * 产物：
 *   resources/icon.png     512×512（窗口图标 / extraResources）
 *   resources/icon.ico     16/24/32/48/64/128/256 多尺寸（Windows 快捷方式/任务栏）
 *   resources/tray.png     32×32 简化版（托盘，运行时缩到 16）
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

/** 圆角矩形有符号距离场（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 线段胶囊距离（用于小节点之间的连线） */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t) - r;
}

function rotatePoint(x, y, cx, cy, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/* ------------------------------------------------------------------ */
/* 图标绘制                                                            */
/* ------------------------------------------------------------------ */

const PLATE_TOP = [79, 143, 255];
const PLATE_BOTTOM = [41, 82, 204];
const PLATE_LIGHT = [128, 178, 255];
const AMBER = [255, 199, 92];
const AMBER_DEEP = [246, 168, 56];
const CARD_TOP = [255, 255, 255];
const CARD_BOTTOM = [228, 237, 255];

/**
 * @param {number} size 目标边长（px）
 * @param {{shadow?:boolean, margin?:number, transparency?:number}} opts
 */
function render(size, opts = {}) {
  const shadow = opts.shadow !== false;
  const margin = opts.margin ?? (shadow ? 0.055 : 0.02);
  const ss = Math.max(2, Math.min(8, Math.floor(2048 / size)));
  const S = size * ss;
  const buf = new Float32Array(S * S * 4); // straight alpha, rgb 0..255

  const cx = S / 2;
  const cy = S / 2;
  const plateW = S * (1 - margin * 2);
  const plateH = plateW;
  const hw = plateW / 2;
  const hh = plateH / 2;
  const radius = plateW * 0.22;
  const topY = cy - hh;

  // 卡片几何：两张错落叠放的卡片，约 12° 倾斜；小尺寸时拉开两张卡的距离，
  // 因为 16px 下只剩几个像素，重叠太多会糊成一块白。
  const tiny = size <= 32;
  const boost = tiny ? 1.02 : 1;
  const cardW = plateW * 0.44 * boost;
  const cardH = plateW * 0.56 * boost;
  const cardR = plateW * 0.055 * boost;
  const back = tiny
    ? { x: cx - plateW * 0.175, y: cy - plateW * 0.155, deg: -24, scale: 0.84 }
    : { x: cx - plateW * 0.115, y: cy - plateW * 0.095, deg: -19, scale: 0.92 };
  const front = tiny
    ? { x: cx + plateW * 0.075, y: cy + plateW * 0.065, deg: -6, scale: 0.98 }
    : { x: cx + plateW * 0.06, y: cy + plateW * 0.05, deg: -8, scale: 1 };

  // 索引节点：右下角一颗米黄圆点 + 一条细连线 + 上侧小点
  const node = { x: cx + plateW * 0.245, y: cy + plateW * 0.245, r: plateW * (tiny ? 0.095 : 0.072) };
  const nodeSmall = { x: cx + plateW * 0.235, y: cy + plateW * (tiny ? 0.125 : 0.115), r: plateW * (tiny ? 0.042 : 0.032) };
  const link = { ax: node.x, ay: node.y - node.r * 0.4, bx: nodeSmall.x, by: nodeSmall.y, r: plateW * 0.016 };

  const blend = (x, y, rgb, alpha) => {
    if (alpha <= 0) return;
    const i = (y * S + x) * 4;
    const da = buf[i + 3];
    const a = clamp01(alpha);
    const out = a + da * (1 - a);
    if (out <= 0) return;
    buf[i] = (rgb[0] * a + buf[i] * da * (1 - a)) / out;
    buf[i + 1] = (rgb[1] * a + buf[i + 1] * da * (1 - a)) / out;
    buf[i + 2] = (rgb[2] * a + buf[i + 2] * da * (1 - a)) / out;
    buf[i + 3] = out;
  };

  for (let py = 0; py < S; py += 1) {
    for (let px = 0; px < S; px += 1) {
      const x = px + 0.5;
      const y = py + 0.5;
      const sdPlate = sdRoundRect(x, y, cx, cy, hw, hh, radius);

      // 1) 柔和外投影：底板垂直下移一点，向外扩散
      if (shadow) {
        const sdShadow = sdRoundRect(x, y, cx, cy + plateW * 0.035, hw * 0.97, hh * 0.97, radius * 0.97);
        const d = Math.max(sdShadow, 0) / (plateW * 0.05);
        const a = 0.3 * Math.exp(-d * d);
        if (a > 0.002) blend(px, py, [17, 36, 86], a);
      }

      // 2) 底板
      if (sdPlate <= 0.5) {
        const t = clamp01((y - topY) / plateH);
        let color = mix(PLATE_TOP, PLATE_BOTTOM, smoothstep(0, 0.96, t));
        // 左上角光源：整体提亮一点
        const lightD = Math.hypot(x - (cx - hw * 0.45), y - (topY + hh * 0.25)) / plateW;
        color = mix(color, PLATE_LIGHT, 0.22 * Math.exp(-lightD * lightD * 6));
        // 顶部 1px 内高光带
        const dIn = -sdPlate;
        const topWeight = clamp01(1 - (y - topY) / (plateH * 0.55));
        const ring = 0.42 * Math.exp(-((dIn / (plateW * 0.012)) ** 2)) * topWeight;
        color = mix(color, [255, 255, 255], ring);
        // 底部内侧轻微压暗，增加厚度
        const bottomWeight = clamp01((y - (cy + hh * 0.55)) / (plateH * 0.45));
        color = mix(color, [24, 48, 120], 0.14 * bottomWeight);
        const cov = clamp01(0.5 - sdPlate);
        blend(px, py, color, cov);
      }

      // 3) 卡片投影（落在底板上）
      if (sdPlate < 0) {
        const [fx, fy] = rotatePoint(x + plateW * 0.012, y + plateW * 0.03, front.x, front.y, -front.deg);
        const sdFrontShadow = sdRoundRect(fx, fy, front.x, front.y, (cardW * front.scale) / 2, (cardH * front.scale) / 2, cardR);
        const d = Math.max(sdFrontShadow, 0) / (plateW * 0.03);
        const a = 0.22 * Math.exp(-d * d);
        if (a > 0.002) blend(px, py, [22, 44, 110], a);
      }

      // 4) 后面那张卡片（后面这张压低亮度 + 白边，小尺寸才分得清两层）
      const [bx, by] = rotatePoint(x, y, back.x, back.y, -back.deg);
      const sdBack = sdRoundRect(bx, by, back.x, back.y, (cardW * back.scale) / 2, (cardH * back.scale) / 2, cardR);
      if (sdBack <= 0.6) {
        const t = clamp01((by - (back.y - (cardH * back.scale) / 2)) / (cardH * back.scale));
        let color = mix([250, 252, 255], [198, 214, 246], t * 0.85);
        // 卡边一圈提亮，给出「纸片厚度」
        color = mix(color, [255, 255, 255], 0.45 * Math.exp(-(((-sdBack) / (plateW * 0.006)) ** 2)));
        blend(px, py, color, clamp01(0.5 - sdBack));
      }

      // 5) 前面那张卡片
      const [fx2, fy2] = rotatePoint(x, y, front.x, front.y, -front.deg);
      const sdFront = sdRoundRect(fx2, fy2, front.x, front.y, (cardW * front.scale) / 2, (cardH * front.scale) / 2, cardR);
      if (sdFront <= 0.6) {
        const t = clamp01((fy2 - (front.y - cardH / 2)) / cardH);
        let color = mix(CARD_TOP, CARD_BOTTOM, t);
        // 卡片顶部也吃一点光
        color = mix(color, [255, 255, 255], 0.35 * Math.exp(-((( -sdFront) / (plateW * 0.01)) ** 2)));
        blend(px, py, color, clamp01(0.5 - sdFront));
      }

      // 6) 米黄索引节点 + 连线（画在卡片上方，右下角露出来）
      const sdLink = sdSegment(x, y, link.ax, link.ay, link.bx, link.by, link.r);
      if (sdLink <= 0.5) blend(px, py, AMBER_DEEP, 0.92 * clamp01(0.5 - sdLink));
      const sdNode = Math.hypot(x - node.x, y - node.y) - node.r;
      if (sdNode <= 0.5) {
        const t = clamp01((y - (node.y - node.r)) / (node.r * 2));
        const color = mix(AMBER, AMBER_DEEP, t);
        blend(px, py, color, clamp01(0.5 - sdNode));
      }
      const sdSmall = Math.hypot(x - nodeSmall.x, y - nodeSmall.y) - nodeSmall.r;
      if (sdSmall <= 0.5) blend(px, py, AMBER, 0.95 * clamp01(0.5 - sdSmall));
    }
  }

  // 下采样（按 alpha 加权，避免边缘发黑）
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const sa = buf[i + 3];
          r += buf[i] * sa;
          g += buf[i + 1] * sa;
          b += buf[i + 2] * sa;
          a += sa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ICO 打包（多尺寸，PNG 内嵌，Vista+ 支持）                           */
/* ------------------------------------------------------------------ */

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dir.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

const t0 = Date.now();
const iconPng = encodePng(512, 512, render(512));
fs.writeFileSync(path.join(resDir, 'icon.png'), iconPng);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoEntries = icoSizes.map((size) => ({ size, png: encodePng(size, size, render(size, { margin: 0.02 })) }));
fs.writeFileSync(path.join(resDir, 'icon.ico'), makeIco(icoEntries));

const trayPng = encodePng(32, 32, render(32, { margin: 0.015, shadow: false }));
fs.writeFileSync(path.join(resDir, 'tray.png'), trayPng);

// 16/32 是否还认得出：拼一张预览图给眼睛看
function previewSheet() {
  const W = 1240;
  const H = 620;
  const img = new Uint8Array(W * H * 4);
  const put = (x0, y0, size, pixels, bg) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const si = (y * size + x) * 4;
        const a = pixels[si + 3] / 255;
        const di = ((y0 + y) * W + (x0 + x)) * 4;
        img[di] = Math.round(pixels[si] * a + bg[0] * (1 - a));
        img[di + 1] = Math.round(pixels[si + 1] * a + bg[1] * (1 - a));
        img[di + 2] = Math.round(pixels[si + 2] * a + bg[2] * (1 - a));
        img[di + 3] = 255;
      }
    }
  };
  const fill = (y0, y1, bg) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        img[i] = bg[0];
        img[i + 1] = bg[1];
        img[i + 2] = bg[2];
        img[i + 3] = 255;
      }
    }
  };
  fill(0, H / 2, [245, 247, 252]);
  fill(H / 2, H, [20, 24, 36]);
  const sizes = [16, 24, 32, 48, 64, 128];
  for (const [row, bg] of [
    [0, [245, 247, 252]],
    [H / 2, [20, 24, 36]]
  ]) {
    let x = 24;
    for (const size of sizes) {
      const y = row + Math.round((H / 2 - size) / 2) - 40;
      put(x, y, size, render(size, { margin: 0.02 }), bg);
      x += size + 26;
    }
    const big = render(256, { margin: 0.02 });
    put(W - 256 - 24, row + Math.round((H / 2 - 256) / 2), 256, big, bg);
    const tray32 = render(32, { margin: 0.015, shadow: false });
    put(24, row + H / 2 - 40, 32, tray32, bg);
  }
  return encodePng(W, H, img);
}
fs.writeFileSync(path.join(root, '.tools', 'icon-preview.png'), previewSheet());

console.log(
  `ICON_OK icon.png=${iconPng.length}B ico=${fs.statSync(path.join(resDir, 'icon.ico')).size}B tray=${trayPng.length}B ${Date.now() - t0}ms`
);
