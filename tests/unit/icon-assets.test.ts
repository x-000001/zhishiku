/**
 * 0.9.0 视觉门面：应用图标资源自检。
 *
 * 图标不是手点出来的，是 `.tools/gen-icon.mjs` 用软件光栅器画出来的（纯 Node、零依赖）。
 * 这里守住三件事，防止以后改生成脚本时把交付物改坏：
 *   ① `resources/icon.png` 是 512 的方图，四角透明（底板是圆角矩形），底板不是纯色平涂；
 *   ② `resources/icon.ico` 里真的打包了 16 / 24 / 32 / 48 / 64 / 128 / 256 七档
 *      （Windows 任务栏、开始菜单、文件属性、Alt+Tab 各取各的，少一档就会糊）；
 *   ③ `resources/tray.png` 是 32 的小图标，托盘缩到 16 也还有足够的不透明像素。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const resources = path.join(process.cwd(), 'resources');

interface Png {
  width: number;
  height: number;
  /** 非交错、8 bit、RGBA 的原始像素（filter 0/1/2/3/4 全部反解过） */
  pixels: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 只解我们自己生成的 PNG：8 bit RGBA、非交错、filter 0；顺带兼容其它 filter 以便将来换编码器 */
function decodePng(buf: Buffer): Png {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  sig.forEach((value, index) => expect(buf[index]).toBe(value));

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      expect(data[9]).toBe(6); // RGBA
      expect(data[12]).toBe(0); // 非交错
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(stride * height);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? out[x - 4] : 0;
      const up = prev[x];
      const upLeft = x >= 4 ? prev[x - 4] : 0;
      const value = line[x];
      out[x] =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : filter === 4
                  ? value + paeth(left, up, upLeft)
                  : 0;
    }
    prev = out;
  }
  return { width, height, pixels };
}

function px(png: Png, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2], png.pixels[i + 3]];
}

const iconPng = decodePng(fs.readFileSync(path.join(resources, 'icon.png')));
const trayPng = decodePng(fs.readFileSync(path.join(resources, 'tray.png')));

describe('应用图标（0.9.0 视觉门面）', () => {
  it('icon.png 是 512×512 的方图', () => {
    expect(iconPng.width).toBe(512);
    expect(iconPng.height).toBe(512);
  });

  it('四角透明（圆角矩形底板，不是铺满的方块）', () => {
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511]
    ]) {
      expect(px(iconPng, x, y)[3]).toBe(0);
    }
    // 左右中线靠上的位置必须是不透明底板（说明圆角没把整块吃掉）
    expect(px(iconPng, 256, 256)[3]).toBe(255);
  });

  it('底板是品牌蓝，中心图形是白色（不是纯色平涂）', () => {
    const plate = px(iconPng, 120, 380); // 左下角：底板
    expect(plate[2]).toBeGreaterThan(plate[0]); // 蓝 > 红
    expect(plate[3]).toBeGreaterThan(240);
    const white = px(iconPng, 256, 250);
    expect(white[0]).toBeGreaterThan(235);
    expect(white[1]).toBeGreaterThan(235);
    expect(white[2]).toBeGreaterThan(235);
  });

  it('底板有自上而下的渐变（顶部比底部亮）', () => {
    const top = px(iconPng, 256, 70);
    const bottom = px(iconPng, 256, 442);
    expect(top[2]).toBeGreaterThan(bottom[2] + 20);
  });

  it('图标里能看见品牌点缀色（米黄/亮黄的小节点）', () => {
    let amber = 0;
    for (let y = 0; y < iconPng.height; y += 2) {
      for (let x = 0; x < iconPng.width; x += 2) {
        const [r, g, b, a] = px(iconPng, x, y);
        if (a > 200 && r > 225 && g > 150 && g < 215 && b < 130) amber++;
      }
    }
    // 节点在 512 画布里大约 40px 直径 → 抽样步长 2，几百个点是下限
    expect(amber).toBeGreaterThan(200);
  });
});

describe('Windows 多尺寸 ico', () => {
  const ico = fs.readFileSync(path.join(resources, 'icon.ico'));

  it('是 ICO 容器（type=1）且至少打包 7 档尺寸', () => {
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(7);
  });

  it('包含 16 / 24 / 32 / 48 / 64 / 128 / 256，每档都是尺寸正确的 PNG', () => {
    const count = ico.readUInt16LE(4);
    const sizes = new Set<number>();
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const width = ico[entry] === 0 ? 256 : ico[entry];
      const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1];
      const size = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(width).toBe(height);
      expect(offset + size).toBeLessThanOrEqual(ico.length);
      const payload = ico.subarray(offset, offset + size);
      // PNG-in-ICO：每档自己就是一张 PNG
      expect(payload.toString('ascii', 1, 4)).toBe('PNG');
      const embedded = decodePng(payload);
      expect(embedded.width).toBe(width);
      expect(embedded.height).toBe(height);
      sizes.add(width);
    }
    for (const size of [16, 24, 32, 48, 64, 128, 256]) expect(sizes.has(size)).toBe(true);
  });

  it('小尺寸不是把 256 那张硬缩（16px 里仍有一块明显的浅色图形）', () => {
    const count = ico.readUInt16LE(4);
    let entry16 = -1;
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      if (ico[entry] === 16) entry16 = entry;
    }
    expect(entry16).toBeGreaterThan(0);
    const size = ico.readUInt32LE(entry16 + 8);
    const offset = ico.readUInt32LE(entry16 + 12);
    const small = decodePng(ico.subarray(offset, offset + size));
    let light = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b, a] = px(small, x, y);
        if (a > 180 && r > 200 && g > 200 && b > 200) light++;
      }
    }
    // 20 个点 ≈ 8% 面积：足够看清「两张卡片」的轮廓，又不至于糊成整块白
    expect(light).toBeGreaterThan(20);
    expect(light).toBeLessThan(160);
  });
});

describe('托盘图标', () => {
  it('tray.png 是 32×32 透明底', () => {
    expect(trayPng.width).toBe(32);
    expect(trayPng.height).toBe(32);
    expect(px(trayPng, 0, 0)[3]).toBe(0);
  });

  it('缩到 16 也还有足够的不透明像素（任务栏小图标能看清）', () => {
    // 按 2×2 块模拟缩到 16：任意一块里只要有一个不透明像素就算「看得见」
    let visible = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const a =
          px(trayPng, x * 2, y * 2)[3] +
          px(trayPng, x * 2 + 1, y * 2)[3] +
          px(trayPng, x * 2, y * 2 + 1)[3] +
          px(trayPng, x * 2 + 1, y * 2 + 1)[3];
        if (a > 120) visible++;
      }
    }
    expect(visible).toBeGreaterThan(90);
  });
});
