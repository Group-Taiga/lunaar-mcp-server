#!/usr/bin/env node
/**
 * Snapshot the live manifest into `dist/manifest.fallback.json` so the
 * published npm tarball boots even when the user's first run has no network.
 *
 * Runs as part of `npm run build`. Failure is non-fatal: we log a warning and
 * continue with whatever fallback already exists in dist/, so a CI machine
 * that can't reach api.lunaarvision.com (e.g. PR builds inside a sandbox)
 * still produces a working artifact.
 */

import { writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.LUNAAR_MCP_MANIFEST_URL ?? "https://api.lunaarvision.com/v1/mcp/manifest.json";
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "dist", "manifest.fallback.json");
const seed = resolve(here, "..", "src", "manifest.fallback.seed.json");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(dirname(target), { recursive: true });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed.version !== "1") throw new Error(`unexpected manifest version ${parsed.version}`);
    await writeFile(target, JSON.stringify(parsed, null, 2), "utf8");
    process.stderr.write(`[snapshot-fallback] wrote ${target} from ${URL} (${parsed.tools.length} tools)\n`);
    return;
  } catch (err) {
    process.stderr.write(`[snapshot-fallback] live fetch failed: ${err.message}\n`);
  }

  // Fallback to seed file checked into the repo, if present.
  if (await exists(seed)) {
    await copyFile(seed, target);
    process.stderr.write(`[snapshot-fallback] used seed ${seed}\n`);
    return;
  }

  // Otherwise leave whatever previous fallback was there. As a last resort,
  // write an empty-ish placeholder so the loader gives a clean error rather
  // than ENOENT.
  if (!(await exists(target))) {
    const placeholder = { version: "1", baseUrl: "https://api.lunaarvision.com", tools: [] };
    await writeFile(target, JSON.stringify(placeholder, null, 2), "utf8");
    process.stderr.write(`[snapshot-fallback] wrote empty placeholder (no live fetch, no seed)\n`);
  }
}

main();
