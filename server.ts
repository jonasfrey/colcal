/**
 * colcal — multi-color filament calibration print generator (Deno server).
 *
 * RUN:
 *   deno task start
 * which is exactly:
 *   deno run --allow-net --allow-read=./public,./projects --allow-write=./projects server.ts
 *
 * Permission flags:
 *   --allow-net                        HTTP server on port 8000 (override: `... -- --port 9000`)
 *   --allow-read=./public,./projects   static frontend + saved projects
 *   --allow-write=./projects           create ./projects and write project files
 *
 * WHERE PROJECTS LIVE:
 *   ./projects/<name>.json — one file per project, created on demand. The directory is
 *   created at startup if missing.
 *
 * API:
 *   GET    /api/projects        -> { projects: [{ name, size, modified }] }
 *   GET    /api/projects/:name  -> the stored project JSON
 *   PUT    /api/projects/:name  -> body = project JSON; saves/overwrites; { ok, name }
 *   DELETE /api/projects/:name  -> { ok, name }
 *
 * Everything else is served statically from ./public ("/" -> ./public/index.html).
 * Model generation, 3D preview and 3MF/STL export all happen client-side; the server
 * only does persistence, which keeps it tiny and dependency-free (standard library only).
 */

/**
 * Port comes from `--port <n>` on the command line rather than an env var, so the run
 * command needs no --allow-env:  deno task start -- --port 9000
 */
const portFlag = Deno.args.indexOf("--port");
const PORT = portFlag >= 0 ? Number(Deno.args[portFlag + 1]) || 8008 : 8008;
const PROJECTS_DIR = "./projects";
const PUBLIC_DIR = "./public";

/** Max size we accept for a project payload (a project is small JSON; guards against abuse). */
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;

// Ensure the projects directory exists before serving anything.
await Deno.mkdir(PROJECTS_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Sanitize the :name path segment.
 *
 * Directory traversal defence: we do NOT try to "clean" a hostile name (../, absolute
 * paths, NUL bytes, Windows drive letters, unicode look-alikes). We accept only a strict
 * whitelist of characters and reject everything else, so the value can never escape
 * ./projects. A trailing ".json" is stripped so both "foo" and "foo.json" address the
 * same project.
 *
 * @returns the bare project name, or null if the input is not acceptable.
 */
function sanitizeProjectName(raw: string): string | null {
  let name = decodeURIComponent(raw ?? "").trim();
  if (name.toLowerCase().endsWith(".json")) name = name.slice(0, -5);
  if (name.length === 0 || name.length > 64) return null;
  // Letters, digits, dot, dash, underscore and space only — and never a leading dot
  // (which would allow ".." or hidden files).
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) return null;
  if (name.includes("..")) return null;
  return name;
}

function projectPath(name: string): string {
  return `${PROJECTS_DIR}/${name}.json`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ *
 * API handlers
 * ------------------------------------------------------------------ */

/** GET /api/projects — list saved project files. */
async function listProjects(): Promise<Response> {
  const projects: Array<{ name: string; size: number; modified: string | null }> = [];
  for await (const entry of Deno.readDir(PROJECTS_DIR)) {
    if (!entry.isFile || !entry.name.toLowerCase().endsWith(".json")) continue;
    const name = entry.name.slice(0, -5);
    let size = 0;
    let modified: string | null = null;
    try {
      const st = await Deno.stat(`${PROJECTS_DIR}/${entry.name}`);
      size = st.size;
      modified = st.mtime ? st.mtime.toISOString() : null;
    } catch {
      // Raced with a delete — just report what we know.
    }
    projects.push({ name, size, modified });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return json({ projects });
}

/** GET /api/projects/:name — load one project's JSON. */
async function loadProject(name: string): Promise<Response> {
  try {
    const text = await Deno.readTextFile(projectPath(name));
    // Served verbatim: the file is the source of truth for the project.
    return new Response(text, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return json({ error: `no such project: ${name}` }, 404);
    }
    throw err;
  }
}

/** PUT /api/projects/:name — save/overwrite a project's JSON. */
async function saveProject(name: string, req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_PROJECT_BYTES) {
    return json({ error: "project too large" }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "body is not valid JSON" }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "project must be a JSON object" }, 400);
  }
  // Keep the stored `name` in sync with the file it lives in.
  const project = { ...(parsed as Record<string, unknown>), name };
  await Deno.writeTextFile(projectPath(name), JSON.stringify(project, null, 2));
  return json({ ok: true, name });
}

/** DELETE /api/projects/:name — delete a project. */
async function deleteProject(name: string): Promise<Response> {
  try {
    await Deno.remove(projectPath(name));
    return json({ ok: true, name });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return json({ error: `no such project: ${name}` }, 404);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

async function serveStatic(pathname: string): Promise<Response> {
  // "/" -> index.html
  let rel = pathname === "/" ? "/index.html" : pathname;
  // Reject anything that could climb out of ./public.
  if (rel.includes("..") || rel.includes("\0")) return new Response("Not found", { status: 404 });
  rel = decodeURIComponent(rel);
  if (rel.includes("..")) return new Response("Not found", { status: 404 });

  const path = `${PUBLIC_DIR}${rel}`;
  try {
    const data = await Deno.readFile(path);
    const dot = rel.lastIndexOf(".");
    const type = dot >= 0 ? MIME[rel.slice(dot).toLowerCase()] : undefined;
    return new Response(data, {
      headers: {
        "content-type": type ?? "application/octet-stream",
        // No caching: this is a local dev tool, always serve fresh code.
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  try {
    if (pathname === "/api/projects" || pathname === "/api/projects/") {
      if (req.method === "GET") return await listProjects();
      return json({ error: "method not allowed" }, 405);
    }

    if (pathname.startsWith("/api/projects/")) {
      const segment = pathname.slice("/api/projects/".length);
      // A nested path (foo/bar) is never a valid project name.
      if (segment.includes("/")) return json({ error: "invalid project name" }, 400);
      const name = sanitizeProjectName(segment);
      if (!name) return json({ error: "invalid project name" }, 400);

      switch (req.method) {
        case "GET":
          return await loadProject(name);
        case "PUT":
          return await saveProject(name, req);
        case "DELETE":
          return await deleteProject(name);
        default:
          return json({ error: "method not allowed" }, 405);
      }
    }

    if (pathname.startsWith("/api/")) return json({ error: "unknown endpoint" }, 404);

    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return await serveStatic(pathname);
  } catch (err) {
    console.error("unhandled error:", err);
    return json({ error: "internal error" }, 500);
  }
}

console.log(`colcal running at http://localhost:${PORT}/  (projects in ${PROJECTS_DIR}/)`);
Deno.serve({ port: PORT }, handler);
