# Changelog

All notable changes to `@lunaar/mcp-server` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

Each release should:
1. Add a `## [x.y.z] - YYYY-MM-DD` section with the bumped version.
2. Group changes under `Added` / `Changed` / `Fixed` / `Removed`.
3. Tag in git (`git tag v0.1.1 && git push --tags`) — the GitHub Actions
   release workflow picks the tag up and publishes to npm automatically.

## [Unreleased]

## [0.2.0] - 2026-05-04
### Changed
- **Manifest-driven tool registration.** Tool definitions (name, description,
  JSON Schema, REST transport, enum integer mappings, polling expectations,
  result formatting) now live in a single JSON manifest fetched from
  `https://api.lunaarvision.com/v1/mcp/manifest.json` at startup.
- New endpoints or extended enums on the Lunaar Public API surface no longer
  require a server release — the npm package picks up changes on its next
  startup, or after the on-disk cache expires (24 h TTL).

### Added
- Three-tier manifest loader: live HTTP fetch → on-disk cache (per-platform
  XDG-style location) → bundled fallback (shipped with the npm tarball as a
  publish-time snapshot of the live manifest). The server boots successfully
  even when the host is offline on first run.
- Generic execution engine (`engine.ts`) that handles every transport shape —
  multipart create + poll, JSON create + poll, GET snapshot, sync POST,
  upscale (sync-or-poll), and paginated list — driven entirely by the
  manifest entry's `transport` and `result` blocks.
- `LUNAAR_MCP_MANIFEST_URL` env var to point at staging or self-hosted
  manifests (default: `https://api.lunaarvision.com/v1/mcp/manifest.json`).
- Build-time snapshot script (`scripts/snapshot-fallback.mjs`) that bakes the
  live manifest into `dist/manifest.fallback.json` whenever `npm run build`
  runs. Fail-soft: when the live URL is unreachable (e.g. CI sandbox), it
  falls back to a checked-in seed.

### Removed
- Hand-written `src/tools.ts` and `src/client.ts`. Their roles are subsumed
  by the manifest + engine pair.

## [0.1.0] - 2026-05-04
### Added
- Initial scaffold with 11 MCP tools wrapping the Lunaar Public API:
  `lunaar_sketch_to_render`, `lunaar_studio_tryon`, `lunaar_studio_poses`,
  `lunaar_jewelry_tryon`, `lunaar_glasses_tryon`, `lunaar_body_estimation`,
  `lunaar_image_to_3d`, `lunaar_model_to_ar`, `lunaar_upscale`,
  `lunaar_get_operation`, `lunaar_list_operations`.
- Stdio transport with full enum-string ↔ integer mapping for every endpoint.
- Polling helper that waits for terminal status (default 180 s; 240 s for
  Image-to-3D) before returning the final asset URL(s) inline.
- Failure handling: surfaces the user-facing Turkish error verbatim plus the
  refund total so the model has the context it needs to apologise without
  inventing details.
- Validation errors flow through as structured `validationErrors` text the
  model can read field-by-field.
