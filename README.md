# colcal — multi-color filament calibration print generator

A small Deno web app that generates a six-square multi-color filament calibration test print, lets
you tweak the parameters live in a 3D preview, saves/loads projects as JSON files on disk, and
exports the model as `.3mf` (or `.stl`).

## Run

```
deno task start
```

which is exactly:

```
deno run --allow-net --allow-read=./public,./projects --allow-write=./projects server.ts
```

Then open <http://localhost:8000/>. To use another port:

```
deno task start -- --port 9000
```

### Permission flags

| Flag                               | Why                                         |
| ---------------------------------- | ------------------------------------------- |
| `--allow-net`                      | the HTTP server                             |
| `--allow-read=./public,./projects` | serve the frontend, read saved projects     |
| `--allow-write=./projects`         | create `./projects` and write project files |

Three.js is loaded from a CDN (unpkg) via an import map, so the browser needs internet access on
first load.

## Where projects are stored

`./projects/<name>.json` — one file per project, created on demand; the directory is created at
startup if missing. Names are restricted to letters, digits, space, `.`, `_` and `-` (max 64 chars);
the server rejects anything else, so a project name can never escape the directory.

### API

| Method   | Path                  | Purpose                              |
| -------- | --------------------- | ------------------------------------ |
| `GET`    | `/api/projects`       | list saved projects                  |
| `GET`    | `/api/projects/:name` | load one project's JSON              |
| `PUT`    | `/api/projects/:name` | save/overwrite (body = project JSON) |
| `DELETE` | `/api/projects/:name` | delete                               |

Everything else is served statically from `./public`.

## Project JSON schema

```jsonc
{
  "name": "my-calibration-v1",
  "params": {
    "swatchSize": 6, // swatch footprint in mm (square)
    "swatchGap": 0, // gap between swatches inside a square, mm
    "squareGap": 0, // gap between the six squares, mm
    "layerHeight": 0.1, // all thicknesses snap to multiples of this, mm
    "colors": {
      "c1": "#ff0000",
      "c2": "#00ff00",
      "c3": "#0000ff",
      "base": "#cfcfcf" // embossed labels (4th filament)
    }
  },
  "squares": [
    {
      "id": "single-c1",
      "label": "R",
      "kind": "single",
      "gridCol": 0,
      "gridRow": 0, // position in the 3x2 plate layout
      "cells": [
        { "row": 0, "col": 0, "id": "R1C1", "recipe": [{ "color": "c1", "thickness": 0.1 }] }, // ordered bottom -> top
        { "row": 0, "col": 1, "id": "R1C2", "recipe": null } // null = empty cell
      ]
    }
    // ... six squares total
  ]
}
```

`squares` is stored so a saved project reproduces identical geometry later. It is regenerated from
`params` when the layer height changes (the only parameter the recipes depend on) and on **New**.

## The model

Six 5×5 grids of raised swatches, laid out 3×2. There is no base plate — swatches and
labels sit directly on the build plate:

```
R          G          B          <- one square per filament color
2-COLOR    3-COLOR A  3-COLOR B
```

| Square        | Swatches             | Enumeration                                                                   |
| ------------- | -------------------- | ----------------------------------------------------------------------------- |
| R / G / B     | 25 each              | one solid box, thickness 1…25 layer heights (0.1 → 2.5 mm at 0.1)             |
| 2-COLOR       | 24 (25th cell empty) | 3 color pairs × 2 stacking orders × 2 bottom × 2 top thicknesses (0.1/0.2 mm) |
| 3-COLOR A + B | 25 + 23 = 48         | 6 orderings (3!) × 8 thickness patterns (each layer 0.1 or 0.2 mm)            |

**147 swatches total.** Each square is embossed with its identifier plus 1–5 row indices (left) and
column indices (below), so a physical swatch maps back to a cell — cell `R3C4` is row 3, column 4.

At the defaults (no gaps between swatches or squares) the layout is ~110 × 84 mm and 2.5 mm tall.

## Export

- **`.3mf` (primary)** — **one object per color, face-colored via a 3MF colorgroup** (the
  3MF materials extension): one `<m:colorgroup>` with one color per filament, one
  `<object>` per filament with every triangle pointing at its color index, and one build
  item per object so the parts import aligned. Bambu Studio (2.5+) parses exactly this
  "face coloring" data and shows its color-matching dialog on import — use
  **File → Import → Import 3MF/STL/…** (or drag the file in), not "Open as project".
  (`<basematerials>` is *not* parsed by Bambu Studio, which is why the previous export
  came in grey.) PrusaSlicer/OrcaSlicer read colorgroups too. The active mode is stated
  in the UI.
- **`.stl` (fallback)** — binary, single solid, no color information.
- **Legend JSON** — every swatch position (`square`, row, column, mm coordinates) mapped to its
  ordered recipe of `{color, hex, thickness_mm}`.

All three run client-side from the same triangle data the preview renders.

## Files

| File                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `server.ts`           | Deno HTTP server: static files + project persistence API |
| `deno.json`           | tasks and the exact run command                          |
| `public/index.html`   | UI shell + import map                                    |
| `public/app.js`       | UI wiring, Three.js preview, project load/save           |
| `public/model.js`     | recipe enumeration and geometry generation               |
| `public/exporters.js` | 3MF (incl. a minimal ZIP writer), STL, legend            |
| `public/font.js`      | single-stroke vector font for the embossed labels        |
# colcal
