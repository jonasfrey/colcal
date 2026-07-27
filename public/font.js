/**
 * Tiny single-stroke vector font.
 *
 * Why hand-rolled: embossed labels must exist as real geometry in the exported 3MF/STL,
 * and we don't want a CDN font file (Three.js TextGeometry needs one) as a hard runtime
 * dependency. Each glyph is a list of polylines on a unit box (x in 0..0.6, y in 0..1);
 * the model builder extrudes every segment into a thin raised bar.
 *
 * Curves are approximated with short straight segments — plenty at 3-5mm cap height.
 */

/** Advance width per character, as a multiple of the cap height. */
export const ADVANCE = 0.8;

/** glyph -> array of polylines; a polyline is a flat list of [x,y] points. */
const GLYPHS = {
  " ": [],
  "-": [[[0.1, 0.5], [0.5, 0.5]]],
  ".": [[[0.25, 0], [0.35, 0]]],
  "A": [[[0, 0], [0.3, 1], [0.6, 0]], [[0.13, 0.42], [0.47, 0.42]]],
  "B": [[[0, 0], [0, 1], [0.42, 1], [0.6, 0.85], [0.6, 0.65], [0.42, 0.5], [0, 0.5]], [
    [0.42, 0.5],
    [0.6, 0.35],
    [0.6, 0.15],
    [0.42, 0],
    [0, 0],
  ]],
  "C": [[[0.6, 0.82], [0.45, 1], [0.15, 1], [0, 0.82], [0, 0.18], [0.15, 0], [0.45, 0], [
    0.6,
    0.18,
  ]]],
  "D": [[[0, 0], [0, 1], [0.38, 1], [0.6, 0.78], [0.6, 0.22], [0.38, 0], [0, 0]]],
  "E": [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
  "F": [[[0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.45, 0.5]]],
  "G": [[
    [0.6, 0.82],
    [0.45, 1],
    [0.15, 1],
    [0, 0.82],
    [0, 0.18],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.18],
    [0.6, 0.45],
    [0.32, 0.45],
  ]],
  "H": [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
  "I": [[[0.3, 0], [0.3, 1]], [[0.12, 1], [0.48, 1]], [[0.12, 0], [0.48, 0]]],
  "J": [[[0.6, 1], [0.6, 0.2], [0.45, 0], [0.15, 0], [0, 0.2]]],
  "K": [[[0, 0], [0, 1]], [[0.6, 1], [0, 0.48], [0.6, 0]]],
  "L": [[[0, 1], [0, 0], [0.6, 0]]],
  "M": [[[0, 0], [0, 1], [0.3, 0.55], [0.6, 1], [0.6, 0]]],
  "N": [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
  "O": [[
    [0, 0.18],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.18],
    [0.6, 0.82],
    [0.45, 1],
    [0.15, 1],
    [0, 0.82],
    [0, 0.18],
  ]],
  "P": [[[0, 0], [0, 1], [0.42, 1], [0.6, 0.85], [0.6, 0.65], [0.42, 0.5], [0, 0.5]]],
  "Q": [[
    [0, 0.18],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.18],
    [0.6, 0.82],
    [0.45, 1],
    [0.15, 1],
    [0, 0.82],
    [0, 0.18],
  ], [[0.36, 0.26], [0.62, 0]]],
  "R": [[[0, 0], [0, 1], [0.42, 1], [0.6, 0.85], [0.6, 0.65], [0.42, 0.5], [0, 0.5]], [[0.3, 0.5], [
    0.6,
    0,
  ]]],
  "S": [[
    [0.6, 0.85],
    [0.45, 1],
    [0.15, 1],
    [0, 0.85],
    [0, 0.65],
    [0.15, 0.5],
    [0.45, 0.5],
    [0.6, 0.35],
    [0.6, 0.15],
    [0.45, 0],
    [0.15, 0],
    [0, 0.15],
  ]],
  "T": [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
  "U": [[[0, 1], [0, 0.18], [0.15, 0], [0.45, 0], [0.6, 0.18], [0.6, 1]]],
  "V": [[[0, 1], [0.3, 0], [0.6, 1]]],
  "W": [[[0, 1], [0.15, 0], [0.3, 0.6], [0.45, 0], [0.6, 1]]],
  "X": [[[0, 0], [0.6, 1]], [[0, 1], [0.6, 0]]],
  "Y": [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
  "Z": [[[0, 1], [0.6, 1], [0, 0], [0.6, 0]]],
  "0": [[
    [0, 0.18],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.18],
    [0.6, 0.82],
    [0.45, 1],
    [0.15, 1],
    [0, 0.82],
    [0, 0.18],
  ], [[0.08, 0.22], [0.52, 0.78]]],
  "1": [[[0.08, 0.78], [0.3, 1], [0.3, 0]], [[0.1, 0], [0.5, 0]]],
  "2": [[[0, 0.82], [0.15, 1], [0.45, 1], [0.6, 0.82], [0.6, 0.66], [0, 0], [0.6, 0]]],
  "3": [[[0, 1], [0.6, 1], [0.26, 0.56]], [[0.26, 0.56], [0.6, 0.4], [0.6, 0.16], [0.45, 0], [
    0.15,
    0,
  ], [0, 0.16]]],
  "4": [[[0.45, 0], [0.45, 1], [0, 0.3], [0.6, 0.3]]],
  "5": [[[0.6, 1], [0, 1], [0, 0.56], [0.42, 0.56], [0.6, 0.4], [0.6, 0.16], [0.45, 0], [0.15, 0], [
    0,
    0.16,
  ]]],
  "6": [[
    [0.5, 1],
    [0.2, 1],
    [0, 0.72],
    [0, 0.16],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.16],
    [0.6, 0.34],
    [0.45, 0.5],
    [0.16, 0.5],
    [0, 0.34],
  ]],
  "7": [[[0, 1], [0.6, 1], [0.2, 0]]],
  "8": [[
    [0.16, 0.5],
    [0, 0.34],
    [0, 0.16],
    [0.15, 0],
    [0.45, 0],
    [0.6, 0.16],
    [0.6, 0.34],
    [0.44, 0.5],
    [0.16, 0.5],
    [0.03, 0.64],
    [0.03, 0.86],
    [0.17, 1],
    [0.43, 1],
    [0.57, 0.86],
    [0.57, 0.64],
    [0.44, 0.5],
  ]],
  "9": [[
    [0.1, 0],
    [0.4, 0],
    [0.6, 0.28],
    [0.6, 0.84],
    [0.45, 1],
    [0.15, 1],
    [0, 0.84],
    [0, 0.66],
    [0.15, 0.5],
    [0.44, 0.5],
    [0.6, 0.66],
  ]],
};

/** Width of a rendered string in mm, for a given cap height. */
export function textWidth(text, size) {
  if (!text.length) return 0;
  // Last glyph contributes its ink width (0.6) rather than a full advance.
  return (text.length - 1) * ADVANCE * size + 0.6 * size;
}

/**
 * Convert a string into flat line segments, ready to be extruded.
 *
 * @param {string} text     rendered upper-cased; unknown characters are skipped
 * @param {number} size     cap height in mm
 * @param {number} x        left edge of the text box (or see `align`)
 * @param {number} y        baseline (bottom of the cap box)
 * @param {"left"|"center"|"right"} align  horizontal alignment about `x`
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
 */
export function textSegments(text, size, x, y, align = "left") {
  const upper = String(text).toUpperCase();
  const w = textWidth(upper, size);
  let penX = x;
  if (align === "center") penX = x - w / 2;
  else if (align === "right") penX = x - w;

  const out = [];
  for (const ch of upper) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const polyline of glyph) {
        for (let i = 0; i < polyline.length - 1; i++) {
          const [ax, ay] = polyline[i];
          const [bx, by] = polyline[i + 1];
          out.push({
            x0: penX + ax * size,
            y0: y + ay * size,
            x1: penX + bx * size,
            y1: y + by * size,
          });
        }
      }
    }
    penX += ADVANCE * size;
  }
  return out;
}
