/**
 * 把 resources/icon.png（256×256）包成一个 Windows .ico。
 * Vista 之后的 ICO 允许直接内嵌 PNG，所以只要拼一个 22 字节的目录头就够了，
 * 不需要任何图像库，也不需要装 Visual Studio。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'resources', 'icon.png');
const dst = path.join(root, 'resources', 'icon.ico');

const png = fs.readFileSync(src);

// 只认 PNG 签名，顺便读出宽高（IHDR 从第 16 字节开始，宽高各 4 字节大端）
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件：' + src);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== height) throw new Error(`图标必须是正方形，现在是 ${width}×${height}`);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // 只放一张图

const entry = Buffer.alloc(16);
entry.writeUInt8(width >= 256 ? 0 : width, 0); // 0 表示 256
entry.writeUInt8(height >= 256 ? 0 : height, 1);
entry.writeUInt8(0, 2); // 调色板颜色数
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // 图像数据字节数
entry.writeUInt32LE(22, 12); // 图像数据偏移 = 6 + 16

fs.writeFileSync(dst, Buffer.concat([header, entry, png]));
console.log(`ICO_OK ${dst} ${width}x${height} png=${png.length}B ico=${fs.statSync(dst).size}B`);
