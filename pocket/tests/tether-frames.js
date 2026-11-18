// Test screens for the Tether protocol (tests/tether.test.js, and the firmware's host test pocket/firmware/tests/tether_test.js),
// as RGB565 Uint16Array(57600). "ui" is a real FM-1 screen: Felucca's, from the technical report's figure.
const fs = require("fs"), path = require("path"), zlib = require("zlib");

// an 8-bit RGB or RGBA PNG, not interlaced (the figures are) -> RGB565
function png565(file) {
  const b = fs.readFileSync(file), idat = [];
  let w = 0, h = 0, ch = 3;
  for (let at = 8; at < b.length; ) {
    const n = b.readUInt32BE(at), type = b.toString("latin1", at + 4, at + 8), d = b.subarray(at + 8, at + 8 + n);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; if (d[8] !== 8 || d[12]) throw new Error("png: 8-bit, not interlaced"); }
    if (type === "IDAT") idat.push(d);
    at += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride), up = y ? px.subarray((y - 1) * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0, u = up ? up[x] : 0, c = up && x >= ch ? up[x - ch] : 0;
      const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
      row[x] = (src[x] + [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][f]) & 255;
    }
  }
  if (w !== 240 || h !== 240) throw new Error("png: not 240 x 240");
  const o = new Uint16Array(57600);
  for (let i = 0; i < o.length; i++) o[i] = ((px[i * ch] >> 3) << 11) | ((px[i * ch + 1] >> 2) << 5) | (px[i * ch + 2] >> 3);
  return o;
}

const rgb = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
function rect(f, x, y, w, h, c) { for (let j = y; j < y + h; j++) f.fill(c, j * 240 + x, j * 240 + x + w); }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 16); }

function frames() {
  const ui = png565(path.join(__dirname, "../../docs/paper/fig/felucca_lcd.png"));
  const scope = ui.slice(); // the next frame of its animation: the oscilloscope moved 3 px left, the tempo changed
  for (let y = 84; y < 206; y++) for (let x = 4; x < 233; x++) scope[y * 240 + x] = ui[y * 240 + x + 3];
  rect(scope, 112, 2, 30, 16, ui[0]);
  const text = new Uint16Array(57600), next = lcg(7); // 1-bit "glyphs" 8 x 16, 4 colours of text on a dark ground
  text.fill(rgb(10, 10, 30));
  const ink = [rgb(255, 255, 255), rgb(120, 220, 120), rgb(255, 170, 40), rgb(140, 140, 140)];
  for (let row = 0; row < 14; row++) for (let col = 0; col < 28; col++) {
    if (next() % 5 === 0) continue;
    const c = ink[row % 4];
    for (let y = 2; y < 14; y++) for (let x = 1; x < 7; x++) if (next() & 1) text[(row * 17 + y) * 240 + col * 8 + 8 + x] = c;
  }
  const black = new Uint16Array(57600), dark = black.slice(); // a few things change on a black screen
  rect(dark, 20, 20, 40, 10, rgb(255, 255, 255));
  rect(dark, 100, 200, 30, 4, rgb(0, 255, 0));
  for (let x = 0; x < 16; x++) dark[120 * 240 + 160 + x] = rgb(255, 0, 0);
  const noise = new Uint16Array(57600), r = lcg(1);
  for (let i = 0; i < noise.length; i++) noise[i] = r();
  return { ui, scope, text, black, dark, noise };
}

module.exports = { frames, png565 };
