/**
 * colcal — model generation.
 *
 * Two responsibilities, deliberately kept separate:
 *
 *   1. buildSquares(params)  -> the *recipes*: six squares of 5x5 cells, each cell either
 *                               empty or an ordered stack of {color, thickness} layers.
 *                               Pure data, no geometry. This is what gets stored in the
 *                               project JSON and what the legend export describes.
 *
 *   2. buildGeometry(params, squares) -> raw triangle meshes, grouped by color, ready for
 *                               both the Three.js preview and the 3MF/STL exporters.
 *
 * All dimensions are millimetres. Z is up (matching what slicers expect). There is no
 * base plate: swatches and embossed labels sit directly on the build plate at z = 0.
 */

import { textSegments } from "./font.js";

/* ------------------------------------------------------------------ *
 * Tweakable parameters — all UI-editable. These are the defaults.
 * ------------------------------------------------------------------ */

export const DEFAULT_PARAMS = {
  swatchSize: 6, // swatch footprint, mm (square: 6 x 6)
  swatchGap: 0, // gap between swatches inside a square, mm
  squareGap: 0, // gap between the six squares, mm
  layerHeight: 0.1, // every thickness is snapped to a multiple of this, mm
  colors: {
    c1: "#ff0000", // filament 1 (default red)   -> single-colour square "R"
    c2: "#00ff00", // filament 2 (default green) -> single-colour square "G"
    c3: "#0000ff", // filament 3 (default blue)  -> single-colour square "B"
    base: "#cfcfcf", // the embossed labels (4th filament / whatever is loaded first).
    // Not one of the three test colors.
  },
};

/** The three test-color keys, in order. */
export const COLOR_KEYS = ["c1", "c2", "c3"];

/** Default single-letter names shown on the single-color squares. */
export const COLOR_LABELS = { c1: "R", c2: "G", c3: "B" };

/** Grid is always 5x5 — the counts in the spec (25/24/48) depend on it. */
const GRID = 5;

/** Single-color square runs 1..25 layer-heights => 0.1 .. 2.5mm at the default 0.1mm. */
const SINGLE_MAX_STEPS = GRID * GRID;

/** Combo squares only ever use 1 or 2 layer-heights per layer (0.1 / 0.2mm by default). */
const COMBO_STEPS = [1, 2];

/* ------------------------------------------------------------------ *
 * Params handling
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** Snap a thickness to a whole number of layer heights (never below one layer). */
export function snapToLayer(value, layerHeight) {
  const steps = Math.max(1, Math.round(value / layerHeight));
  return round4(steps * layerHeight);
}

/** Number coercion that survives undefined/""/NaN from hand-edited JSON or empty inputs. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce anything project-shaped into a complete, sane parameter set. */
export function normalizeParams(input = {}) {
  const p = { ...DEFAULT_PARAMS, ...input };
  const layerHeight = clamp(num(p.layerHeight, DEFAULT_PARAMS.layerHeight) || 0.1, 0.02, 1);
  return {
    swatchSize: clamp(num(p.swatchSize, DEFAULT_PARAMS.swatchSize) || 6, 1, 50),
    swatchGap: clamp(num(p.swatchGap, DEFAULT_PARAMS.swatchGap), 0, 50),
    squareGap: clamp(num(p.squareGap, DEFAULT_PARAMS.squareGap), 0, 100),
    layerHeight: round4(layerHeight),
    colors: { ...DEFAULT_PARAMS.colors, ...(input.colors || {}) },
  };
}

/* ------------------------------------------------------------------ *
 * 1. Recipe generation — one small function per square type.
 *    The counts are asserted at the end of buildSquares().
 * ------------------------------------------------------------------ */

/**
 * Single-color square: 25 swatches, thickness 1..25 layer heights
 * (0.1 -> 2.5mm at the default layer height), row-major.
 * A single-color swatch is ONE solid box — not split into layers.
 */
function singleColorRecipes(colorKey, layerHeight) {
  const recipes = [];
  for (let n = 1; n <= SINGLE_MAX_STEPS; n++) {
    recipes.push([{ color: colorKey, thickness: round4(n * layerHeight) }]);
  }
  return recipes; // 25
}

/**
 * Two-color square: 24 combos (the 25th cell stays empty).
 *
 *   3 unordered color pairs           (c1c2, c1c3, c2c3)
 *   x 2 stacking orders               (A on bottom, B on bottom)
 *   x 2 bottom thicknesses            (1 or 2 layer heights)
 *   x 2 top thicknesses               (1 or 2 layer heights)
 *   = 3 x 8 = 24
 */
function twoColorRecipes(layerHeight) {
  const pairs = [["c1", "c2"], ["c1", "c3"], ["c2", "c3"]];
  const recipes = [];
  for (const [a, b] of pairs) {
    for (const [bottom, top] of [[a, b], [b, a]]) { // 2 stacking orders
      for (const bSteps of COMBO_STEPS) {
        for (const tSteps of COMBO_STEPS) {
          recipes.push([
            { color: bottom, thickness: round4(bSteps * layerHeight) },
            { color: top, thickness: round4(tSteps * layerHeight) },
          ]);
        }
      }
    }
  }
  return recipes; // 24
}

/** All 6 orderings (3!) of the three colors, in a stable order. */
function colorOrderings() {
  const out = [];
  for (const a of COLOR_KEYS) {
    for (const b of COLOR_KEYS) {
      if (b === a) continue;
      for (const c of COLOR_KEYS) {
        if (c === a || c === b) continue;
        out.push([a, b, c]);
      }
    }
  }
  return out; // 6
}

/**
 * Three-color combos: 48 total, spread over two 5x5 squares (48 of 50 cells).
 *
 *   6 orderings of the 3 colors (3!)
 *   x 8 thickness patterns      (each of the 3 layers is 1 or 2 layer heights: 2^3)
 *   = 48
 *
 * Enumeration is ordering-major, so square A holds orderings 1-3 plus the first cell of
 * ordering 4, and square B the remainder — see splitThreeColor().
 */
function threeColorRecipes(layerHeight) {
  const recipes = [];
  for (const ordering of colorOrderings()) {
    for (let pattern = 0; pattern < 8; pattern++) {
      // bit 2 = bottom layer, bit 1 = middle, bit 0 = top; 0 -> 1 step, 1 -> 2 steps.
      const steps = [(pattern >> 2) & 1, (pattern >> 1) & 1, pattern & 1].map((b) => b + 1);
      recipes.push(
        ordering.map((color, i) => ({ color, thickness: round4(steps[i] * layerHeight) })),
      );
    }
  }
  return recipes; // 48
}

/** Lay a flat recipe list out row-major into a 5x5 grid, padding with empty cells. */
function toCells(recipes) {
  const cells = [];
  for (let i = 0; i < GRID * GRID; i++) {
    const row = Math.floor(i / GRID);
    const col = i % GRID;
    cells.push({
      row,
      col,
      id: `R${row + 1}C${col + 1}`,
      recipe: recipes[i] ? recipes[i].map((l) => ({ ...l })) : null, // null = empty cell
    });
  }
  return cells;
}

/**
 * Build all six squares.
 *
 * Layout on the plate is 3 x 2:
 *   row 0:  R (c1)      G (c2)      B (c3)
 *   row 1:  2-COLOR     3-COLOR A   3-COLOR B
 *
 * @returns array of { id, label, kind, gridCol, gridRow, cells[] }
 */
export function buildSquares(params) {
  const { layerHeight } = normalizeParams(params);

  const three = threeColorRecipes(layerHeight);
  const threeA = three.slice(0, 25); // fills square A completely
  const threeB = three.slice(25); // 23 recipes -> 2 empty cells in square B

  const squares = [
    {
      id: "single-c1",
      label: COLOR_LABELS.c1,
      kind: "single",
      color: "c1",
      gridCol: 0,
      gridRow: 0,
      cells: toCells(singleColorRecipes("c1", layerHeight)),
    },
    {
      id: "single-c2",
      label: COLOR_LABELS.c2,
      kind: "single",
      color: "c2",
      gridCol: 1,
      gridRow: 0,
      cells: toCells(singleColorRecipes("c2", layerHeight)),
    },
    {
      id: "single-c3",
      label: COLOR_LABELS.c3,
      kind: "single",
      color: "c3",
      gridCol: 2,
      gridRow: 0,
      cells: toCells(singleColorRecipes("c3", layerHeight)),
    },
    {
      id: "two-color",
      label: "2-COLOR",
      kind: "two",
      gridCol: 0,
      gridRow: 1,
      cells: toCells(twoColorRecipes(layerHeight)),
    },
    {
      id: "three-color-a",
      label: "3-COLOR A",
      kind: "three",
      gridCol: 1,
      gridRow: 1,
      cells: toCells(threeA),
    },
    {
      id: "three-color-b",
      label: "3-COLOR B",
      kind: "three",
      gridCol: 2,
      gridRow: 1,
      cells: toCells(threeB),
    },
  ];

  // Verifiable against the spec: 25 + 25 + 25 + 24 + 25 + 23 = 147 swatches.
  const counts = squares.map((s) => s.cells.filter((c) => c.recipe).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 147) {
    console.warn(`colcal: expected 147 swatches, generated ${total} (${counts.join("+")})`);
  }
  return squares;
}

/** Per-square and total swatch counts, for the UI stats readout. */
export function swatchCounts(squares) {
  const per = squares.map((s) => ({
    id: s.id,
    label: s.label,
    count: s.cells.filter((c) => c.recipe).length,
  }));
  return { per, total: per.reduce((a, b) => a + b.count, 0) };
}

/* ------------------------------------------------------------------ *
 * 2. Geometry — plain triangle soup, grouped by color.
 *
 * Every group is { key, name, colorHex, verts: number[], tris: number[] } where verts is
 * a flat [x,y,z,...] array and tris a flat [i,j,k,...] index array. Both the preview and
 * the exporters consume exactly this, so what you see is what you export.
 * ------------------------------------------------------------------ */

function newGroup(key, name, colorHex) {
  return { key, name, colorHex, verts: [], tris: [], boxes: 0 };
}

/**
 * Push an axis-aligned box. Winding is CCW seen from outside (outward normals), which
 * both STL and 3MF require.
 */
function addBox(g, x0, y0, z0, x1, y1, z1) {
  const base = g.verts.length / 3;
  // 0-3 = bottom face corners CCW seen from +z, 4-7 = the same corners on top.
  g.verts.push(
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  );
  addBoxFaces(g, base);
  g.boxes++;
}

/** The 12 triangles of a box, given 8 vertices laid out as in addBox(). */
function addBoxFaces(g, b) {
  const f = (a, c, d) => g.tris.push(b + a, b + c, b + d);
  f(0, 3, 2);
  f(0, 2, 1); // bottom (-z)
  f(4, 5, 6);
  f(4, 6, 7); // top    (+z)
  f(0, 1, 5);
  f(0, 5, 4); // -y
  f(1, 2, 6);
  f(1, 6, 5); // +x
  f(2, 3, 7);
  f(2, 7, 6); // +y
  f(3, 0, 4);
  f(3, 4, 7); // -x
}

/**
 * Push an extruded line segment (a rotated box) — used for the embossed labels.
 * The segment is widened to `width` and its ends are extended by half the width so that
 * consecutive strokes of a glyph join without notches.
 */
function addStroke(g, x0, y0, x1, y1, z0, z1, width) {
  let dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  dx /= len;
  dy /= len;
  const h = width / 2;
  // Extend the ends so strokes overlap at joints.
  const ax = x0 - dx * h, ay = y0 - dy * h;
  const bx = x1 + dx * h, by = y1 + dy * h;
  // Left-hand normal.
  const nx = -dy * h, ny = dx * h;

  const base = g.verts.length / 3;
  // Same corner order as addBox: 4 bottom corners CCW seen from +z, then 4 on top.
  const quad = [[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]];
  for (const [x, y] of quad) g.verts.push(x, y, z0);
  for (const [x, y] of quad) g.verts.push(x, y, z1);
  addBoxFaces(g, base);
  g.boxes++;
}

/** Emboss a text label (a stack of strokes) onto the build plate. */
function addLabel(g, text, size, x, y, align, z0, z1, width) {
  for (const s of textSegments(text, size, x, y, align)) {
    addStroke(g, s.x0, s.y0, s.x1, s.y1, z0, z1, width);
  }
}

/** Derived layout numbers — everything on the plate is positioned from these. */
export function computeLayout(params) {
  const p = normalizeParams(params);
  const pitch = p.swatchSize + p.swatchGap; // swatch centre-to-centre
  const gridSpan = GRID * p.swatchSize + (GRID - 1) * p.swatchGap; // 38mm by default

  // Text sizes scale with the model so odd swatch sizes still produce readable labels.
  const idxSize = clamp(p.swatchSize * 0.5, 1.5, 5); // row/column index digits
  const labelPad = idxSize * 1.8; // strip left of / below each grid
  const titleSize = clamp(gridSpan / 11, 2, 8); // "3-COLOR A" etc.
  const titleH = titleSize * 1.6; // strip above each grid

  const cellW = labelPad + gridSpan;
  const cellH = labelPad + gridSpan + titleH;
  const margin = Math.max(2, p.squareGap / 2); // border around the whole layout

  const width = 2 * margin + 3 * cellW + 2 * p.squareGap;
  const depth = 2 * margin + 2 * cellH + p.squareGap;

  return {
    ...p,
    pitch,
    gridSpan,
    idxSize,
    labelPad,
    titleSize,
    titleH,
    cellW,
    cellH,
    margin,
    width,
    depth,
    // Labels are at least 2 layers tall so they survive slicing.
    embossHeight: Math.max(2 * p.layerHeight, 0.2),
    titleStroke: Math.max(0.45, titleSize * 0.14),
    idxStroke: Math.max(0.35, idxSize * 0.18),
  };
}

/**
 * Build the whole model.
 *
 * @returns {{groups: Array, layout: object, swatches: Array, bounds: object}}
 *   groups   — one per color key present (base, c1, c2, c3); this grouping is exactly
 *              what the 3MF exporter turns into one object per color.
 *   swatches — flat list with world positions + recipes, used by the legend export.
 */
export function buildGeometry(params, squares) {
  const L = computeLayout(params);
  const baseTop = 0; // no base plate — everything sits directly on the build plate

  // One group per filament. Order matters only for display.
  const groups = {
    base: newGroup("base", "Labels", L.colors.base),
    c1: newGroup("c1", `Color 1 (${COLOR_LABELS.c1})`, L.colors.c1),
    c2: newGroup("c2", `Color 2 (${COLOR_LABELS.c2})`, L.colors.c2),
    c3: newGroup("c3", `Color 3 (${COLOR_LABELS.c3})`, L.colors.c3),
  };

  // Centre the model on the origin in XY (slicers drop it on the plate centre).
  const ox = -L.width / 2;
  const oy = -L.depth / 2;

  const swatches = [];
  let maxZ = baseTop;

  for (const square of squares) {
    // Square origin. gridRow 0 is the top (higher Y) row of the 3x2 arrangement.
    const cellX = ox + L.margin + square.gridCol * (L.cellW + L.squareGap);
    const cellY = oy + L.margin + (1 - square.gridRow) * (L.cellH + L.squareGap);
    const gridX0 = cellX + L.labelPad;
    const gridY0 = cellY + L.labelPad;

    // Square title, centred above the grid.
    addLabel(
      groups.base,
      square.label,
      L.titleSize,
      gridX0 + L.gridSpan / 2,
      gridY0 + L.gridSpan + L.titleH * 0.25,
      "center",
      baseTop,
      baseTop + L.embossHeight,
      L.titleStroke,
    );

    // Column indices 1..5 below the grid, row indices 1..5 to its left.
    for (let i = 0; i < GRID; i++) {
      const cx = gridX0 + i * L.pitch + L.swatchSize / 2;
      addLabel(
        groups.base,
        String(i + 1),
        L.idxSize,
        cx,
        cellY + (L.labelPad - L.idxSize) / 2,
        "center",
        baseTop,
        baseTop + L.embossHeight,
        L.idxStroke,
      );
      // Row i counts downwards from the top of the grid.
      const cy = gridY0 + (GRID - 1 - i) * L.pitch + L.swatchSize / 2;
      addLabel(
        groups.base,
        String(i + 1),
        L.idxSize,
        cellX + L.labelPad / 2,
        cy - L.idxSize / 2,
        "center",
        baseTop,
        baseTop + L.embossHeight,
        L.idxStroke,
      );
    }

    // --- the swatches -----------------------------------------------------
    for (const cell of square.cells) {
      if (!cell.recipe || cell.recipe.length === 0) continue;
      const x0 = gridX0 + cell.col * L.pitch;
      const y0 = gridY0 + (GRID - 1 - cell.row) * L.pitch;
      const x1 = x0 + L.swatchSize;
      const y1 = y0 + L.swatchSize;

      // Stack the layers bottom-up. One BoxGeometry-equivalent box per colored layer,
      // pushed into that color's group — which is what makes per-color export possible.
      let z = baseTop;
      for (const layer of cell.recipe) {
        const g = groups[layer.color];
        if (!g) continue; // unknown color key in a hand-edited project: skip it
        const t = Math.max(layer.thickness, 0);
        if (t <= 0) continue;
        addBox(g, x0, y0, z, x1, y1, z + t);
        z += t;
      }
      maxZ = Math.max(maxZ, z);

      swatches.push({
        square: square.id,
        squareLabel: square.label,
        row: cell.row + 1, // 1-based, matching the embossed indices
        col: cell.col + 1,
        cell: cell.id,
        centerX: round4((x0 + x1) / 2),
        centerY: round4((y0 + y1) / 2),
        recipe: cell.recipe.map((l) => ({ ...l })),
        totalThickness: round4(z - baseTop),
      });
    }
  }

  return {
    groups: Object.values(groups),
    layout: L,
    swatches,
    bounds: {
      width: round4(L.width),
      depth: round4(L.depth),
      height: round4(maxZ),
    },
  };
}
