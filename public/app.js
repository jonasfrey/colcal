/**
 * colcal — UI wiring and Three.js preview.
 *
 * Application state is exactly the project schema (see PROJECT SCHEMA below), so saving
 * is a straight JSON.stringify of the state and loading is the reverse.
 *
 * PROJECT SCHEMA (stored as ./projects/<name>.json on the server)
 * --------------------------------------------------------------
 * {
 *   "name": "my-calibration-v1",
 *   "params": {
 *     "swatchSize": 6,        // swatch footprint in mm (square)
 *     "swatchGap": 0,         // gap between swatches inside a square, mm
 *     "squareGap": 0,         // gap between the six squares, mm
 *     "layerHeight": 0.1,     // all thicknesses snap to multiples of this, mm
 *     "colors": {
 *       "c1": "#ff0000", "c2": "#00ff00", "c3": "#0000ff",
 *       "base": "#cfcfcf"     // embossed labels
 *     }
 *   },
 *   "squares": [              // the six-square definition; regenerable from params
 *     {
 *       "id": "single-c1", "label": "R", "kind": "single",
 *       "gridCol": 0, "gridRow": 0,       // position in the 3x2 plate layout
 *       "cells": [
 *         { "row": 0, "col": 0, "id": "R1C1",
 *           "recipe": [ { "color": "c1", "thickness": 0.1 } ] },   // bottom -> top
 *         { "row": 0, "col": 1, "id": "R1C2", "recipe": null }     // null = empty cell
 *       ]
 *     }
 *   ]
 * }
 *
 * `squares` is kept in the file so a saved project reproduces byte-identical geometry
 * even if the recipe generator later changes. It is regenerated from params whenever the
 * layer height changes (the only parameter recipes depend on) or on "New".
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  buildGeometry,
  buildSquares,
  COLOR_LABELS,
  DEFAULT_PARAMS,
  normalizeParams,
  swatchCounts,
} from "./model.js";

import { buildLegend, download, exportSTL, exportThreeMF, THREEMF_MODE } from "./exporters.js";

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  name: "my-calibration-v1",
  params: structuredClone(DEFAULT_PARAMS),
  squares: null, // built on boot
};

/** Latest built geometry — shared by the preview and all three exporters. */
let geometry = null;

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = kind;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/** Numeric parameters, in UI order. `step` doubles as the input's granularity. */
const NUMERIC_PARAMS = [
  { key: "swatchSize", label: "Swatch footprint", unit: "mm", min: 1, max: 30, step: 0.5 },
  { key: "swatchGap", label: "Gap between swatches", unit: "mm", min: 0, max: 20, step: 0.5 },
  { key: "squareGap", label: "Gap between squares", unit: "mm", min: 0, max: 50, step: 1 },
  { key: "layerHeight", label: "Layer height", unit: "mm", min: 0.02, max: 0.4, step: 0.01 },
];

const COLOR_PARAMS = [
  { key: "c1", label: `Color 1 (${COLOR_LABELS.c1})` },
  { key: "c2", label: `Color 2 (${COLOR_LABELS.c2})` },
  { key: "c3", label: `Color 3 (${COLOR_LABELS.c3})` },
  { key: "base", label: "Labels" },
];

function buildControls() {
  const numeric = $("numericParams");
  for (const p of NUMERIC_PARAMS) {
    const label = document.createElement("label");
    label.className = "field";
    label.innerHTML = `<span>${p.label} (${p.unit})</span>`;
    const input = document.createElement("input");
    input.type = "number";
    input.id = `param-${p.key}`;
    Object.assign(input, { min: p.min, max: p.max, step: p.step });
    input.addEventListener("change", () => {
      const previousLayerHeight = state.params.layerHeight;
      state.params[p.key] = Number(input.value);
      state.params = normalizeParams(state.params);
      syncInputs();
      // Recipes depend only on the layer height; regenerate them when it moves.
      if (state.params.layerHeight !== previousLayerHeight) {
        state.squares = buildSquares(state.params);
      }
      rebuild();
    });
    label.appendChild(input);
    numeric.appendChild(label);
  }

  const colors = $("colorParams");
  for (const p of COLOR_PARAMS) {
    const label = document.createElement("label");
    label.className = "field";
    label.innerHTML = `<span>${p.label}</span>`;
    const input = document.createElement("input");
    input.type = "color";
    input.id = `color-${p.key}`;
    input.addEventListener("input", () => {
      state.params.colors[p.key] = input.value;
      rebuild();
    });
    label.appendChild(input);
    colors.appendChild(label);
  }

  $("modeHint").textContent = `3MF export mode: ${THREEMF_MODE}. ` +
    "STL is a colorless single-solid fallback.";
}

/** Push state -> inputs (after load, or after normalization clamped a value). */
function syncInputs() {
  for (const p of NUMERIC_PARAMS) $(`param-${p.key}`).value = state.params[p.key];
  for (const p of COLOR_PARAMS) $(`color-${p.key}`).value = state.params.colors[p.key];
  $("projectName").value = state.name;
}

/* ------------------------------------------------------------------ *
 * Three.js scene
 * ------------------------------------------------------------------ */

const view = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101216);

// Z-up, matching the model coordinates (and what slicers expect).
const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(140, -160, 130);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20242c, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.6, -1, 1.4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-1, 0.7, 0.5);
scene.add(fill);

// Build plate reference grid, rotated into the XY plane.
const grid = new THREE.GridHelper(400, 40, 0x3a4150, 0x252a33);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.01;
scene.add(grid);

/** Holds the generated meshes; cleared and rebuilt on every change. */
const modelRoot = new THREE.Group();
scene.add(modelRoot);

function clearModel() {
  for (const child of [...modelRoot.children]) {
    child.geometry?.dispose();
    child.material?.dispose();
    modelRoot.remove(child);
  }
}

/** Turn one color group's triangle soup into a flat-shaded mesh. */
function meshForGroup(group) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(group.verts, 3));
  geom.setIndex(group.tris);
  // Un-index so each face gets its own normal — shared box corners would otherwise
  // average into smooth, unreadable shading.
  const flat = geom.toNonIndexed();
  geom.dispose();
  flat.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(group.colorHex),
    roughness: 0.62,
    metalness: 0.03,
  });
  return new THREE.Mesh(flat, material);
}

let framedOnce = false;

/** Point the camera at the whole plate (only automatically on first build / New). */
function frameModel() {
  const { width, depth, height } = geometry.bounds;
  const radius = Math.hypot(width, depth) * 0.8;
  const target = new THREE.Vector3(0, 0, height / 2);
  controls.target.copy(target);
  camera.position.set(radius * 0.85, -radius * 1.05, radius * 0.85 + height);
  camera.near = Math.max(0.1, radius / 200);
  camera.far = radius * 40;
  camera.updateProjectionMatrix();
  controls.update();
}

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ *
 * Rebuild: state -> geometry -> preview + stats
 * ------------------------------------------------------------------ */

function rebuild() {
  geometry = buildGeometry(state.params, state.squares);

  clearModel();
  for (const group of geometry.groups) {
    if (group.tris.length === 0) continue;
    modelRoot.add(meshForGroup(group));
  }

  if (!framedOnce) {
    frameModel();
    framedOnce = true;
  }
  updateStats();
  updateColorLegend();
}

function updateStats() {
  const counts = swatchCounts(state.squares);
  const b = geometry.bounds;
  const boxes = geometry.groups.reduce((n, g) => n + g.boxes, 0);
  const tris = geometry.groups.reduce((n, g) => n + g.tris.length / 3, 0);

  const rows = counts.per.map((c) => `<tr><td>${c.label}</td><td>${c.count}</td></tr>`);
  rows.push(`<tr class="total"><td>swatches</td><td>${counts.total}</td></tr>`);
  rows.push(
    `<tr><td>plate</td><td>${b.width} × ${b.depth} mm</td></tr>`,
    `<tr><td>max height</td><td>${b.height} mm</td></tr>`,
    `<tr><td>boxes / triangles</td><td>${boxes} / ${tris}</td></tr>`,
  );
  $("stats").innerHTML = rows.join("");
}

function updateColorLegend() {
  $("legendSwatches").innerHTML = geometry.groups
    .filter((g) => g.tris.length > 0)
    .map((g) => `<div><i style="background:${g.colorHex}"></i>${g.name}</div>`)
    .join("");
}

/* ------------------------------------------------------------------ *
 * Project persistence (the JSON API)
 * ------------------------------------------------------------------ */

/** Mirrors the server-side sanitizer so bad names are caught before the round trip. */
function validName(name) {
  const n = String(name ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(n) && n.length <= 64 ? n : null;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page; fall through with body = null.
  }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

async function refreshProjectList(selected = state.name) {
  try {
    const { projects } = await api("/api/projects");
    const select = $("projectList");
    select.innerHTML = '<option value="">— saved projects —</option>' +
      projects.map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
    if (projects.some((p) => p.name === selected)) select.value = selected;
  } catch (err) {
    setStatus(`Could not list projects: ${err.message}`, "error");
  }
}

function currentProject() {
  return { name: state.name, params: state.params, squares: state.squares };
}

async function save(name) {
  const clean = validName(name);
  if (!clean) {
    setStatus("Invalid project name: use letters, digits, space, . _ - (max 64).", "error");
    return;
  }
  try {
    state.name = clean;
    await api(`/api/projects/${encodeURIComponent(clean)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(currentProject()),
    });
    syncInputs();
    await refreshProjectList(clean);
    setStatus(`Saved “${clean}” to ./projects/${clean}.json`, "ok");
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, "error");
  }
}

async function load(name) {
  if (!name) {
    setStatus("Pick a project from the dropdown first.", "error");
    return;
  }
  try {
    const project = await api(`/api/projects/${encodeURIComponent(name)}`);
    state.name = project.name ?? name;
    state.params = normalizeParams(project.params ?? {});
    // Prefer the stored squares so a project reproduces exactly what it was saved with;
    // fall back to regenerating if the file predates them or is hand-trimmed.
    state.squares = Array.isArray(project.squares) && project.squares.length === 6
      ? project.squares
      : buildSquares(state.params);
    syncInputs();
    rebuild();
    setStatus(`Loaded “${state.name}”.`, "ok");
  } catch (err) {
    setStatus(`Load failed: ${err.message}`, "error");
  }
}

async function remove(name) {
  if (!name) {
    setStatus("Pick a project from the dropdown first.", "error");
    return;
  }
  if (!confirm(`Delete project “${name}”? This removes ./projects/${name}.json.`)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refreshProjectList();
    setStatus(`Deleted “${name}”.`, "ok");
  } catch (err) {
    setStatus(`Delete failed: ${err.message}`, "error");
  }
}

function newProject() {
  if (!confirm("Discard the current unsaved model and start a new project?")) return;
  state.name = "untitled";
  state.params = structuredClone(DEFAULT_PARAMS);
  state.squares = buildSquares(state.params);
  syncInputs();
  rebuild();
  frameModel();
  setStatus("New project with default parameters.", "ok");
}

/* ------------------------------------------------------------------ *
 * Export handlers
 * ------------------------------------------------------------------ */

function fileBase() {
  return (validName(state.name) ?? "calibration").replace(/\s+/g, "_");
}

function exportModel3MF() {
  download(exportThreeMF(geometry.groups, state.name), `${fileBase()}.3mf`);
  setStatus(`Exported ${fileBase()}.3mf — ${THREEMF_MODE}.`, "ok");
}

function exportModelSTL() {
  download(exportSTL(geometry.groups), `${fileBase()}.stl`);
  setStatus(`Exported ${fileBase()}.stl (single solid, no color information).`, "ok");
}

function exportLegend() {
  const legend = buildLegend(state.name, state.params, geometry);
  const blob = new Blob([JSON.stringify(legend, null, 2)], { type: "application/json" });
  download(blob, `${fileBase()}-legend.json`);
  setStatus(`Exported legend for ${legend.swatches.length} swatches.`, "ok");
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildControls();
state.squares = buildSquares(state.params);
syncInputs();
resize();
rebuild();
animate();
refreshProjectList();

$("btnSave").addEventListener("click", () => save($("projectName").value));
$("btnSaveAs").addEventListener("click", () => {
  const name = prompt("Save as (project name):", state.name);
  if (name !== null) save(name);
});
$("btnNew").addEventListener("click", newProject);
$("btnLoad").addEventListener("click", () => load($("projectList").value));
$("btnDelete").addEventListener("click", () => remove($("projectList").value));
$("btnRefresh").addEventListener("click", () => refreshProjectList());
$("projectName").addEventListener("change", () => {
  const clean = validName($("projectName").value);
  if (clean) state.name = clean;
  else setStatus("Invalid project name: letters, digits, space, . _ - only.", "error");
});
$("projectList").addEventListener("dblclick", () => load($("projectList").value));

$("btn3mf").addEventListener("click", exportModel3MF);
$("btnStl").addEventListener("click", exportModelSTL);
$("btnLegend").addEventListener("click", exportLegend);
