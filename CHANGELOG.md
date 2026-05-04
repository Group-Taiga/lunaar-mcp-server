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
