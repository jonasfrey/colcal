Build a small web app served by a Deno web server that generates multi-color filament calibration
test prints, lets me tweak parameters through a UI, saves/loads projects as JSON files on disk, and
exports each model as a .3mf file.

Architecture

A Deno HTTP server (use Deno.serve) that: Serves a single-page frontend (HTML + JS; Three.js via CDN
for the 3D preview and export). Exposes a small JSON API for project persistence: GET /api/projects
— list saved project files. GET /api/projects/:name — load one project's JSON. PUT
/api/projects/:name — save/overwrite a project's JSON. DELETE /api/projects/:name — delete a
project. Stores projects as individual .json files in a local ./projects/ directory (create it if
missing). Use the Deno file APIs (Deno.readTextFile, Deno.writeTextFile, Deno.readDir, Deno.mkdir).
Sanitize the :name path segment to prevent directory traversal. Include a deno.json with tasks (e.g.
deno task start) and the exact run command with needed flags (--allow-net, --allow-read,
--allow-write scoped to ./projects). State the run command in a comment at the top. Keep it minimal:
no framework required, standard library only. One server file plus the served frontend (frontend can
be one HTML file with inline JS, or a couple of static files — your call, but keep it simple).

Project JSON schema

A project captures everything needed to regenerate a model. Define and document a schema roughly
like:

json { "name": "my-calibration-v1", "params": { "swatchSize": 6, "swatchGap": 0, "squareGap": 0,
"layerHeight": 0.1, "colors": { "c1": "#ff0000", "c2": "#00ff00", "c3":
"#0000ff" } }, "squares": [ /* the six-square definition, see below */ ] }

Loading a project restores all params and the model; saving writes current UI state to a .json. The
UI needs: a project name field, Save, Save As, Load (dropdown of existing projects from the API),
and New. This is what lets me generate and keep multiple distinct calibration models.

The model — six squares (core spec):

Six square grids of raised swatches sitting directly on the build plate (no base plate).
Each swatch is a stack of colored layers; each layer thickness is a multiple of the layer
height. 3 configurable filament colors (default red, green, blue).

Three single-color squares, one per color: each a 5×5 grid (25 swatches), thickness 0.1 → 2.5mm in
0.1mm steps. A single-color swatch is one solid box (don't split into layers). One two-color square:
5×5 grid, 24 combos (25th cell empty). The 24 = 3 color pairs × 8 each, where each pair's 8 = 2
stacking orders × {0.1, 0.2mm} bottom × {0.1, 0.2mm} top. Each swatch = 2 stacked colored boxes. Two
three-color squares: together 48 combos across two 5×5 grids (48 of 50 cells). The 48 = 6 orderings
of the 3 colors (3!) × 8 thickness patterns (each of 3 layers is 0.1 or 0.2mm). Each swatch = 3
stacked colored boxes.

Total 147 swatches. Arrange the six squares in a 3×2 layout with the configurable
square-gap between them.

Layer / thickness rules

Layer height default 0.1mm, configurable; snap all thicknesses to multiples of it. Stacks sit
directly on the build plate. Single-color square max 2.5mm; combo layers
use 0.1/0.2mm.

Tweakable UI parameters (defaults): swatch footprint (6×6mm), gap between swatches (0mm), gap
between squares (0mm), layer height (0.1mm), the 3 colors (hex pickers).
Live 3D preview with orbit controls updates on any change.

Labels & legend

Emboss a small identifier next to each square ("R", "G", "B", "2-color", "3-color A", "3-color B")
plus row/column indices, so a physical swatch maps back to a cell. "Export legend" button downloads
a JSON mapping each swatch position → its recipe (ordered list of {color, thickness_mm}).

Export

Primary: export .3mf. Group swatch boxes by color so a slicer (Bambu Studio / OrcaSlicer /
PrusaSlicer) opens the model with parts assigned to distinct colors/objects. If the 3MF color
extension is unreliable, instead export one object per color inside a single 3MF and state in the UI
which mode is active. Fallback: plain STL export button too. Comment the 3MF export code thoroughly
— color/object grouping is the fragile part. Export can happen client-side (Three.js) or via a
server endpoint — your choice; if server-side, add an /api/export route. Client-side is fine and
keeps the server simple.

Implementation notes

Put layer height, swatch size, gaps as clearly-commented constants/state. Generate
each square's recipes with a small readable function per square type (single, two-color,
three-color) so the enumeration is verifiable against the counts (25, 25, 25, 24, 48). Use
BoxGeometry per colored box, grouped by color for export. Provide clear README-style comments: how
to run the Deno server, where projects are stored, and the permission flags.

Before finalizing 3MF export defaults, if it changes your approach, ask which slicer I use;
otherwise default to one-object-per-color inside a single 3MF.
