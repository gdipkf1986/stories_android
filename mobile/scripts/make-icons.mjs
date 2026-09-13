// 生成 stories 的应用图标（纯 Node 实现 PNG 编码，无第三方依赖）
// 用法：node scripts/make-icons.mjs
// 产物（覆盖到 assets/）：
//   icon.png                       主图标（知乎蓝底 + 白色胶囊“信息流”符号）
//   android-icon-foreground.png    自适应图标前景（透明底白胶囊）
//   android-icon-monochrome.png    Android 13+ 单色主题图标
//   splash-icon.png                启动屏图标（透明底白胶囊）
//   favicon.png                    Web favicon
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BLUE = [0, 132, 255]; // 知乎蓝 #0084ff
const WHITE = [255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

// ---------- 最小 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let off = 0;
  for (let y = 0; y < size; y++) {
    raw[off++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
      raw[off++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 图形：三条左对齐圆角长条（信息流/时间线符号） ----------
// 坐标为 0~1 的比例值；胶囊 = 到线段的距离 ≤ r
const BARS = [
  { cy: 0.375, x0: 0.29, x1: 0.71 },
  { cy: 0.5, x0: 0.29, x1: 0.605 },
  { cy: 0.625, x0: 0.29, x1: 0.685 },
];
const R = 0.041;

function inCapsule(x, y, size, bar) {
  const ax = (bar.x0 + R) * size;
  const bx = (bar.x1 - R) * size;
  const cy = bar.cy * size;
  const r = R * size;
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax)) / ((bx - ax) ** 2 || 1)));
  const px = ax + t * (bx - ax);
  return (x - px) ** 2 + (y - cy) ** 2 <= r * r;
}

/** bg：符号外像素；fg：符号像素 */
function iconPixel(x, y, size, bg, fg) {
  for (const bar of BARS) {
    if (inCapsule(x, y, size, bar)) return fg;
  }
  return bg;
}

// ---------- 产出各尺寸 ----------
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');

// 1. 主图标：蓝底白符号（商店 / 桌面）
writeFileSync(
  join(assets, 'icon.png'),
  encodePng(1024, (x, y) => iconPixel(x, y, 1024, [...BLUE, 255], [...WHITE, 255])),
);

// 2+3. 自适应图标前景 / 单色图标：透明底白符号
const foreground = encodePng(1024, (x, y) => iconPixel(x, y, 1024, TRANSPARENT, [...WHITE, 255]));
writeFileSync(join(assets, 'android-icon-foreground.png'), foreground);
writeFileSync(join(assets, 'android-icon-monochrome.png'), foreground);

// 4. 启动屏图标：透明底白符号（app.json 里配蓝底）
writeFileSync(
  join(assets, 'splash-icon.png'),
  encodePng(512, (x, y) => iconPixel(x, y, 512, TRANSPARENT, [...WHITE, 255])),
);

// 5. favicon
writeFileSync(
  join(assets, 'favicon.png'),
  encodePng(48, (x, y) => iconPixel(x, y, 48, [...BLUE, 255], [...WHITE, 255])),
);

console.log('✅ icons written to assets/ (icon, adaptive fg/mono, splash, favicon)');
