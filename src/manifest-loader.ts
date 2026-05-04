/**
 * Three-tier manifest loader: live HTTP fetch → on-disk cache → bundled fallback.
 *
 * Why each layer:
 *   1. Live  — picks up new tools / enum values immediately, no SDK release needed.
 *   2. Cache — survives transient network blips (corporate VPN, captive Wi-Fi) and
 *              keeps cold-start latency low after the first run.
 *   3. Fallback — the snapshot baked into the npm tarball at publish time guarantees
 *              the server boots even on first run with no network.
 *
 * The model never sees this dance: by the time the SDK calls `tools/list` we
 * have a manifest in hand from one of the three layers, and we tag the source
 * in the server's MCP instructions for transparency.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Manifest, ManifestLoadResult } from "./manifest-types.js";

const DEFAULT_MANIFEST_URL = "https://api.lunaarvision.com/v1/mcp/manifest.json";
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
/** How long an on-disk cache entry is considered fresh. After this we still keep
 *  using it as fallback if live fetch fails, but a fresh fetch is preferred. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheFile {
  fetchedAt: string;
  manifest: Manifest;
}

export async function loadManifest(opts?: {
  url?: string;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
}): Promise<ManifestLoadResult> {
  const url = opts?.url ?? process.env.LUNAAR_MCP_MANIFEST_URL ?? DEFAULT_MANIFEST_URL;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const cachePaths = resolveCachePaths();

  // 1. Live fetch — best-effort; failures fall through to cache + fallback.
  try {
    const live = await fetchLive(url, fetchImpl, opts?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    await persistCache(cachePaths, live).catch(() => {
      /* cache write failures are non-fatal — the user-visible path still worked */
    });
    return { manifest: live, source: "live", fetchedAt: new Date().toISOString() };
  } catch (err) {
    process.stderr.write(`[lunaar-mcp] live manifest fetch failed: ${(err as Error).message}\n`);
  }

  // 2. Disk cache — useful when the live URL is briefly unreachable.
  try {
    const cached = await readCache(cachePaths.file);
    if (cached) {
      return { manifest: cached.manifest, source: "cache", fetchedAt: cached.fetchedAt };
    }
  } catch (err) {
    process.stderr.write(`[lunaar-mcp] cache read failed: ${(err as Error).message}\n`);
  }

  // 3. Bundled fallback — ships with the npm tarball, guarantees first-run success.
  const fallback = await readFallback();
  if (fallback) {
    return { manifest: fallback, source: "fallback", fetchedAt: "bundled" };
  }

  throw new Error(
    "Lunaar MCP manifest is unavailable: live fetch failed, no on-disk cache, and no bundled fallback. " +
      "Either restore network access to the manifest URL or reinstall @lunaar/mcp-server."
  );
}

// ─── live ─────────────────────────────────────────────────────────────────────

async function fetchLive(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Manifest> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const json = (await res.json()) as Manifest;
    validateManifest(json);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ─── cache ────────────────────────────────────────────────────────────────────

interface CachePaths {
  dir: string;
  file: string;
}

function resolveCachePaths(): CachePaths {
  // Honour `XDG_CACHE_HOME` when present; otherwise platform-typical fallbacks.
  let root: string;
  if (process.env.XDG_CACHE_HOME) {
    root = join(process.env.XDG_CACHE_HOME, "lunaar-mcp");
  } else if (platform() === "win32") {
    root = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "lunaar-mcp");
  } else if (platform() === "darwin") {
    root = join(homedir(), "Library", "Caches", "lunaar-mcp");
  } else {
    root = join(homedir(), ".cache", "lunaar-mcp");
  }
  return { dir: root, file: join(root, "manifest.json") };
}

async function readCache(file: string): Promise<CacheFile | null> {
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as CacheFile;
  if (!parsed.fetchedAt || !parsed.manifest) return null;
  validateManifest(parsed.manifest);

  const age = Date.now() - new Date(parsed.fetchedAt).getTime();
  if (Number.isNaN(age)) return null;
  // We still return cache entries past TTL — they're only ever consulted after
  // a live fetch already failed, so a stale-but-valid manifest is better than
  // nothing. The TTL exists so we know to PREFER live when both succeed (live
  // path wins anyway because we try it first).
  return parsed;
}

async function persistCache(paths: CachePaths, manifest: Manifest): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  const body: CacheFile = { fetchedAt: new Date().toISOString(), manifest };
  await writeFile(paths.file, JSON.stringify(body, null, 2), "utf8");
}

// ─── bundled fallback ─────────────────────────────────────────────────────────

async function readFallback(): Promise<Manifest | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "manifest.fallback.json"),
    resolve(here, "..", "manifest.fallback.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Manifest;
      validateManifest(parsed);
      return parsed;
    }
  }
  return null;
}

// ─── validation ───────────────────────────────────────────────────────────────

function validateManifest(m: unknown): asserts m is Manifest {
  if (!m || typeof m !== "object") throw new Error("manifest is not an object");
  const obj = m as Record<string, unknown>;
  if (obj.version !== "1") throw new Error(`unsupported manifest version: ${String(obj.version)}`);
  if (typeof obj.baseUrl !== "string") throw new Error("manifest.baseUrl missing");
  if (!Array.isArray(obj.tools)) throw new Error("manifest.tools is not an array");
}

/**
 * Cache-suppressing variant — used by the build script that snapshots the live
 * manifest into the bundled fallback. Returns the raw JSON text for direct
 * write-out (preserving server-side formatting, ETag friendliness).
 */
export { CACHE_TTL_MS };
