/**
 * colcal — client-side exporters: 3MF (primary), STL (fallback), legend JSON.
 *
 * Everything runs in the browser from the same triangle groups the preview renders, so
 * the server stays a pure persistence layer.
 *
 * ============================ 3MF NOTES (the fragile part) ============================
 *
 * A .3mf is a ZIP (OPC package) containing at minimum:
 *
 *   [Content_Types].xml     declares the MIME type of .rels and .model parts
 *   _rels/.rels             points at the root 3D model part
 *   3D/3dmodel.model        the actual XML model
 *
 * COLOR / OBJECT GROUPING — the part slicers disagree about.
 *
 * There are two ways to get color into a 3MF:
 *
 *   (a) The *materials extension*: a <basematerials> resource listing colored materials,
 *       with each <object> (or each triangle, via pid/p1 attributes) referencing one.
 *       Support is uneven: PrusaSlicer/OrcaSlicer/Bambu Studio read <basematerials> and
 *       map materials onto extruders, but per-triangle assignment is frequently dropped.
 *
 *   (b) One *object per color*, assembled into a single build item with <components>.
 *       Every slicer understands objects and components — the import shows up as one
 *       model made of N parts, each of which you can assign to an extruder/filament.
 *
 * We do BOTH, in the reliable combination:
 *   - one <object> per color (never per-triangle color), and
 *   - a <basematerials> resource so each object carries its display color, which lets
 *     slicers pre-assign filaments and makes the parts visually distinguishable.
 *   - a final <object type="model"> with <components> referencing every color object,
 *     so the whole plate arrives as ONE model with correctly aligned parts. Dropping the
 *     assembly would leave the user with N separate objects to re-align by hand.
 *
 * This is the "one object per color inside a single 3MF" mode, which is what the UI
 * reports as active. Coordinates are absolute (already positioned), so every component
 * uses an identity transform — no transform bugs possible.
 *
 * Units are millimetres (unit="millimeter" on <model>), matching the rest of the app.
 * ====================================================================================
 */

/* ------------------------------------------------------------------ *
 * Minimal ZIP writer (store / no compression).
 *
 * A 3MF's parts are small XML; skipping DEFLATE avoids pulling in a compression library
 * and every slicer reads stored entries fine.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a ZIP archive from [{ name, data: Uint8Array }] entries.
 * Layout: local headers + data, then the central directory, then the EOCD record.
 */
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (PK\x03\x04). Version 20, no flags, method 0 (store),
    // zeroed mtime/mdate — 3MF readers ignore timestamps.
    const local = [
      ...u32(0x04034B50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0), // mod time, mod date
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, entry.data);

    // Matching central directory record (PK\x01\x02).
    central.push({
      header: new Uint8Array([
        ...u32(0x02014B50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      nameBytes,
    });

    offset += local.length + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    chunks.push(c.header, c.nameBytes);
    centralSize += c.header.length + c.nameBytes.length;
  }

  // End of central directory (PK\x05\x06).
  chunks.push(
    new Uint8Array([
      ...u32(0x06054B50),
      ...u16(0),
      ...u16(0),
      ...u16(central.length),
      ...u16(central.length),
      ...u32(centralSize),
      ...u32(centralStart),
      ...u16(0),
    ]),
  );

  return new Blob(chunks, { type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" });
}

/* ------------------------------------------------------------------ *
 * 3MF
 * ------------------------------------------------------------------ */

const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** #rrggbb -> #RRGGBBFF (3MF display colors carry an alpha channel). */
function displayColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return `#${(m ? m[1] : "cccccc").toUpperCase()}FF`;
}

/** Coordinates: 4 decimals is well below printer resolution and keeps files small. */
const fmt = (v) => {
  const s = v.toFixed(4);
  return s.replace(/\.?0+$/, "") || "0";
};

/**
 * Serialize one color group as a <mesh>. Vertices are shared within a group; each box
 * contributes its own 8 vertices, so every box is an independently closed volume — which
 * is what slicers want when parts merely touch.
 */
function meshXml(group) {
  const v = group.verts;
  const t = group.tris;
  const out = ["<mesh><vertices>"];
  for (let i = 0; i < v.length; i += 3) {
    out.push(`<vertex x="${fmt(v[i])}" y="${fmt(v[i + 1])}" z="${fmt(v[i + 2])}"/>`);
  }
  out.push("</vertices><triangles>");
  for (let i = 0; i < t.length; i += 3) {
    out.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
  }
  out.push("</triangles></mesh>");
  return out.join("");
}

/**
 * Build the 3MF blob.
 *
 * @param {Array} groups   color groups from buildGeometry(); empty ones are skipped
 * @param {string} name    model name, embedded as metadata
 */
export function exportThreeMF(groups, name) {
  const used = groups.filter((g) => g.tris.length > 0);

  // --- resource ids -------------------------------------------------------
  // id 1  = the basematerials resource
  // id 2.. = one object per color
  // last  = the assembly object that <components>s them together
  const MATERIALS_ID = 1;
  const firstObjectId = 2;
  const assemblyId = firstObjectId + used.length;

  // <basematerials>: index i of this list is what an object references via pindex.
  const materials = used
    .map((g) => `<base name="${xmlEscape(g.name)}" displaycolor="${displayColor(g.colorHex)}"/>`)
    .join("");

  // One object per color. pid points at the basematerials resource, pindex at this
  // object's entry in it — that pairing is what gives the part its color in the slicer.
  const objects = used
    .map((g, i) =>
      `<object id="${firstObjectId + i}" type="model" pid="${MATERIALS_ID}" pindex="${i}" ` +
      `name="${xmlEscape(g.name)}">${meshXml(g)}</object>`
    )
    .join("");

  // The assembly. Identity transforms: component meshes are already in plate coordinates.
  const components = used
    .map((_, i) => `<component objectid="${firstObjectId + i}"/>`)
    .join("");

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
 <metadata name="Title">${xmlEscape(name)}</metadata>
 <metadata name="Application">colcal</metadata>
 <resources>
  <basematerials id="${MATERIALS_ID}">${materials}</basematerials>
  ${objects}
  <object id="${assemblyId}" type="model" name="${xmlEscape(name)}">
   <components>${components}</components>
  </object>
 </resources>
 <build>
  <item objectid="${assemblyId}"/>
 </build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model"
  Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const enc = new TextEncoder();
  // [Content_Types].xml must be the first entry in the archive (OPC requirement).
  return makeZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "3D/3dmodel.model", data: enc.encode(model) },
  ]);
}

/** Human-readable description of the export mode, shown in the UI. */
export const THREEMF_MODE =
  "one object per color inside a single 3MF (components assembly + basematerials colors)";

/* ------------------------------------------------------------------ *
 * STL (binary) — fallback, colorless: all groups welded into one solid.
 * ------------------------------------------------------------------ */

export function exportSTL(groups) {
  let triCount = 0;
  for (const g of groups) triCount += g.tris.length / 3;

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  // 80-byte header is left zeroed (a leading "solid" would confuse ASCII detection).
  view.setUint32(80, triCount, true);

  let off = 84;
  for (const g of groups) {
    const v = g.verts;
    const t = g.tris;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const ax = v[a], ay = v[a + 1], az = v[a + 2];
      const bx = v[b], by = v[b + 1], bz = v[b + 2];
      const cx = v[c], cy = v[c + 1], cz = v[c + 2];
      // Facet normal from the CCW winding.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const wx = cx - ax, wy = cy - ay, wz = cz - az;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      for (const f of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
        view.setFloat32(off, f, true);
        off += 4;
      }
      view.setUint16(off, 0, true); // attribute byte count
      off += 2;
    }
  }
  return new Blob([buffer], { type: "model/stl" });
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

/**
 * Map every swatch position to its recipe, so a printed square can be read back.
 * Positions use the same 1-based row/column indices that are embossed on the plate.
 */
export function buildLegend(projectName, params, geometry) {
  return {
    project: projectName,
    generated: new Date().toISOString(),
    units: "mm",
    params,
    colors: params.colors,
    baseThickness_mm: params.baseThickness,
    note: "Row/column indices match the numbers embossed left of and below each square. " +
      "Recipes are ordered bottom-to-top; thicknesses exclude the shared base plate.",
    swatches: geometry.swatches.map((s) => ({
      square: s.square,
      squareLabel: s.squareLabel,
      cell: s.cell,
      row: s.row,
      col: s.col,
      position_mm: { x: s.centerX, y: s.centerY },
      totalThickness_mm: s.totalThickness,
      recipe: s.recipe.map((l) => ({
        color: l.color,
        hex: params.colors[l.color] ?? null,
        thickness_mm: l.thickness,
      })),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Download helper
 * ------------------------------------------------------------------ */

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
