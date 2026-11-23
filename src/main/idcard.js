'use strict';
// Reading the PDF417 barcode on the back of the Syrian ID card.
//
// Observed content: Windows-1256 (Arabic) text, fields separated by '#':
//   first name # family name # father # mother # "<birth place> <d-m-yyyy>" # national number (11 digits) # <binary data>
// Only the readable fields are used; the binary part (signature/photo/encrypted data) is ignored.

const fs = require('fs');

/* eslint-disable max-len */
const CP1256 = '€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈگ‘’“”•–—ک™ڑ›œ‌‍ں ،¢£¤¥¦§¨©ھ«¬­®¯°±²³´µ¶·¸¹؛»¼½¾؟ہءآأؤإئابةتثجحخدذرزسشصض×طظعغـفقكàلâمنهوçèéêëىيîïًٌٍَôُِ÷ّùْûü‎‏ے';
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
/* eslint-enable max-len */

const CP1252_REV = new Map([...CP1252].map((c, i) => [c, 0x80 + i]));

function decode1256(bytes) {
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP1256[b - 0x80];
  return s;
}

/** Text typed by a scanner in keyboard mode, where each byte became a Latin character. Returns bytes or null. */
function latinTextToBytes(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (CP1252_REV.has(ch)) out.push(CP1252_REV.get(ch));
    else if (c <= 0xff) out.push(c);
    else return null;
  }
  return out;
}

function toIsoDate(d, m, y) {
  const dd = Number(d); const mm = Number(m); const yy = Number(y);
  if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yy >= 1900 && yy <= 2100)) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const clean = s => String(s || '').replace(/[\u0000-\u001f‌-‏]/g, '').replace(/\s+/g, ' ').trim();
const hasArabic = s => /[ء-ي]/.test(s);

/** Parses the decoded text (fields separated by '#'). Returns null if it does not look like an ID card. */
function parseFields(text) {
  const parts = String(text).split('#');
  if (parts.length < 6) return null;
  const [first, family, father, mother, birth, nid] = parts.slice(0, 6).map(clean);
  const nationalId = (nid.match(/\d{11}/) || [''])[0];
  if (!nationalId || !(hasArabic(first) || hasArabic(family))) return null;
  let birthPlace = birth;
  let birthDate = '';
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(birth) || /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(birth);
  if (m) {
    birthDate = m[1].length === 4 ? toIsoDate(m[3], m[2], m[1]) : toIsoDate(m[1], m[2], m[3]);
    birthPlace = clean(birth.replace(m[0], ''));
  }
  return {
    first_name: first,
    family_name: family,
    full_name: clean(`${first} ${family}`),
    father_name: father,
    mother_name: mother,
    birth_place: birthPlace,
    birth_date: birthDate,
    national_id: nationalId,
  };
}

/** Raw barcode bytes (photo decoding, COM-port scanner). */
function parseBytes(bytes) {
  return parseFields(decode1256(Uint8Array.from(bytes)));
}

/**
 * Text received from a scanner in keyboard mode. Depending on the scanner settings the Arabic text
 * arrives either correctly, or as Latin characters (one per byte). Both are handled.
 */
function parseScannedText(text) {
  if (!text) return null;
  const direct = parseFields(text);
  if (direct) return direct;
  const bytes = latinTextToBytes(text);
  return bytes ? parseBytes(bytes) : null;
}

// ------------------------------------------------------------------ photo decoding
let zxing = null;
async function reader() {
  if (!zxing) {
    zxing = require('zxing-wasm/reader');
    // load the WebAssembly file from disk: the program must work offline
    const wasmFile = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    zxing.setZXingModuleOverrides({ wasmBinary: fs.readFileSync(wasmFile) });
  }
  return zxing;
}

function toGray(rgba) {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  return g;
}

/** Contrast stretch + threshold, returns RGBA. */
function binarize(rgba, threshold) {
  const g = toGray(rgba);
  let lo = 255; let hi = 0;
  for (const v of g) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(rgba.length);
  for (let j = 0, i = 0; j < g.length; j++, i += 4) {
    const v = ((g[j] - lo) * 255) / span >= threshold ? 255 : 0;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return out;
}

/**
 * Decodes the ID barcode from a photo.
 * @param {(width: number) => {data: Uint8ClampedArray, width: number, height: number}} render
 *        returns the image as RGBA resized to the given width (Electron nativeImage in the app)
 * @param {number} originalWidth
 * @returns {Promise<{fields: object|null, bytes: number[]}|null>}
 */
async function decodeImage(render, originalWidth) {
  const z = await reader();
  // small to large: photos of a whole card are often large, close-ups of the barcode are small and blurry
  const widths = [...new Set([originalWidth, 1600, 2400, 3200, 4200, 5000]
    .filter(w => w >= 400 && w <= Math.max(5000, originalWidth)))].sort((a, b) => a - b);
  const opts = { formats: ['PDF417'], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 1 };
  for (const w of widths) {
    let img;
    try { img = await render(w); } catch (_) { continue; }
    const variants = [img.data, binarize(img.data, 128), binarize(img.data, 100), binarize(img.data, 150)];
    for (const data of variants) {
      try {
        const res = await z.readBarcodesFromImageData({ data, width: img.width, height: img.height, colorSpace: 'srgb' }, opts);
        if (res.length && res[0].isValid) {
          const bytes = Array.from(res[0].bytes);
          return { fields: parseBytes(bytes), bytes };
        }
      } catch (_) {
        // the decoder can fail on very large images; reset it and keep trying other sizes
        try { z.purgeZXingModule(); } catch (__) { /* ignore */ }
      }
    }
  }
  return null;
}

module.exports = { parseFields, parseBytes, parseScannedText, decode1256, latinTextToBytes, decodeImage };
