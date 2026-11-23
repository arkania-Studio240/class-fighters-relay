"use strict";
/**
 * Generador de códigos QR (sin dependencias). Modo bytes, corrección de errores M, versiones 1 a 9
 * (hasta 180 bytes: de sobra para el enlace de amigo). Devuelve una matriz de módulos que el
 * juego dibuja como cuadraditos.
 *
 *   const { encode } = require("./qr");
 *   encode("https://...")  ->  { size: 29, rows: ["1010...", ...] }   ("1" = módulo oscuro)
 */

// Por versión (1..9): [bytes de corrección por bloque, [[cantidad de bloques, bytes de datos], ...]]
const BLOCKS_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];
const MAX_VERSION = 9;

// --- Campo de Galois GF(256), polinomio 0x11D ---
const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly; // coeficientes de mayor a menor grado (el primero es 1)
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

function dataCapacity(version) {
  const [, groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function pickVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    // 4 bits de modo + 8 de longitud + datos
    if (Math.ceil((4 + 8 + byteLength * 8) / 8) <= dataCapacity(v)) return v;
  }
  throw new Error("Texto demasiado largo para el QR");
}

function buildCodewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Reparte en bloques, calcula la corrección y entrelaza.
  const [ecLen, groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
    }
  }
  const result = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) result.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) result.push(b.ec[i]);
  return result;
}

class Matrix {
  constructor(version) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFunctionPatterns(m, version) {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) m.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = ALIGN[version];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.setFunction(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(m, 0); // reserva la zona (se vuelve a dibujar con la máscara elegida)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFunction(a, b, dark);
      m.setFunction(b, a, dark);
    }
  }
}

function drawFormat(m, mask) {
  const size = m.size;
  const data = (0 << 3) | mask; // nivel M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, bit(i));
  m.setFunction(8, size - 8, true);
}

function drawCodewords(m, codewords) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && MASKS[mask](x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

function penalty(m) {
  const size = m.size;
  let score = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  };
  line((a, b) => m.modules[a][b]);
  line((a, b) => m.modules[b][a]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.modules[y][x];
      if (c === m.modules[y][x + 1] && c === m.modules[y + 1][x] && c === m.modules[y + 1][x + 1]) score += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  const finderLike = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        let ok = true;
        for (let k = 0; k < 7 && ok; k++) ok = get(a, b + k) === pattern[k];
        if (!ok) continue;
        const light = (i) => i < 0 || i >= size || !get(a, i);
        if ([b - 4, b - 3, b - 2, b - 1].every(light) || [b + 7, b + 8, b + 9, b + 10].every(light)) score += 40;
      }
    }
  };
  finderLike((a, b) => m.modules[a][b]);
  finderLike((a, b) => m.modules[b][a]);
  let dark = 0;
  for (const row of m.modules) for (const c of row) if (c) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function encode(text) {
  const bytes = Buffer.from(String(text), "utf8");
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { size: best.size, rows: best.modules.map((row) => row.map((c) => (c ? "1" : "0")).join("")) };
}

module.exports = { encode };
