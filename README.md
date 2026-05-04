# @lunaar/mcp-server

Model Context Protocol server for the [Lunaar Public API](https://platform.lunaarvision.com). Lets Claude, Cursor, Windsurf and any other MCP-compatible host use Lunaar's AI building blocks — sketch-to-render, virtual try-on, jewelry / glasses compositing, body measurement extraction, image-to-3D, AR viewer publishing, upscaling — as native tools, all called by name from chat.

## Quick install

You'll need an API key. Sign up at [platform.lunaarvision.com](https://platform.lunaarvision.com) → **API Keys → New key** and copy the `lk_live_…` value once.

### Claude Desktop / Claude Code

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) — or the equivalent on Windows / Linux:

```json
{
  "mcpServers": {
    "lunaar": {
      "command": "npx",
      "args": ["-y", "@lunaar/mcp-server"],
      "env": {
        "LUNAAR_API_KEY": "lk_live_REPLACE_ME"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or `Settings → Features → Model Context Protocol`):

```json
{
  "mcpServers": {
    "lunaar": {
      "command": "npx",
      "args": ["-y", "@lunaar/mcp-server"],
      "env": { "LUNAAR_API_KEY": "lk_live_REPLACE_ME" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "lunaar": {
      "command": "npx",
      "args": ["-y", "@lunaar/mcp-server"],
      "env": { "LUNAAR_API_KEY": "lk_live_REPLACE_ME" }
    }
  }
}
```

Restart the host after editing config. The Lunaar tools should appear in the tool picker / `/mcp` list.

## Tools exposed

| Tool | Use it for | Cost |
|---|---|---|
| `lunaar_sketch_to_render` | Convert an interior / exterior / kitchen sketch to a photoreal render. | 15 credits |
| `lunaar_studio_tryon` | Virtual try-on. Modes: `single_item`, `combo`, `layer`, `summer`. | 10-15 credits |
| `lunaar_studio_poses` | Generate alternate-pose variants (Front / Side45 / Side90 / Back) of a previously rendered Studio item. | 10 / pose |
| `lunaar_jewelry_tryon` | Composite a jewelry product onto a model or display surface. 4 display modes. | 10-15 credits |
| `lunaar_glasses_tryon` | Drop a pair of glasses onto a face with anatomy-aware fit. | 10 credits |
| `lunaar_body_estimation` | Pull anatomical measurements from a single full-body photo. | 10 credits |
| `lunaar_image_to_3d` | Generate a GLB 3D model + spinning preview video from a product photo. | 20 credits |
| `lunaar_model_to_ar` | Upload an existing GLB / USDZ and get a public AR-viewer URL. | 5 credits |
| `lunaar_upscale` | Re-render a previously completed `/v1/ai/*` operation at higher resolution. | 5 credits |
| `lunaar_get_operation` | Inspect any operation by id (use this when a long-running tool times out before the AI finishes). | free |
| `lunaar_list_operations` | Recent operations for the current API key, with status and credit usage. | free |

## How long-running operations are handled

Most calls reach `Completed` within 30-90 seconds and the tool returns the final asset URL inline. For Image-to-3D (~3 minutes) the wrapper polls up to 4 minutes; if the host's tool-execution budget is shorter and the operation hasn't finished, the tool returns the `operationId` and the model can call `lunaar_get_operation` to pick the result up later.

Failed runs surface the user-friendly error message (Turkish, by design — same string Lunaar's product UI shows end users) and the credit refund total.

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `LUNAAR_API_KEY` | yes | — | Your `lk_live_…` key. Always set via the host config's `env` block — never commit. |
| `LUNAAR_BASE_URL` | no | `https://api.lunaarvision.com` | Override only for staging or self-hosted gateway environments. |

## Development

```bash
git clone https://github.com/Group-Taiga/lunaar-mcp-server.git
cd lunaar-mcp-server
npm install
npm run build
LUNAAR_API_KEY=lk_live_... node dist/index.js
```

`npm run dev` re-compiles on save. To test the binary against an MCP host locally, point the host config at the absolute path of the built `dist/index.js`.

## Releasing

Releases are driven by **git tags + GitHub Actions** — never publish from a
laptop once the npm automation token is configured. The flow:

```bash
# bump in package.json + create matching tag in one go
npm version patch        # 0.1.0 → 0.1.1   (or minor / major)
git push --follow-tags   # pushes both the bump commit AND the v0.1.1 tag
```

The `Release` workflow in `.github/workflows/release.yml` picks up the tag,
runs `npm ci && npm run build`, publishes with `npm publish --access public
--provenance` (npm provenance signs the package against the GitHub commit),
and creates a GitHub Release with auto-generated notes.

### One-time CI setup

1. **Generate a granular automation token on npm:**
   - https://www.npmjs.com/settings/<your-user>/tokens → **Generate New Token → Granular Access Token**.
   - Permissions → **Packages and scopes**: `Read and write` for `@lunaar/mcp-server`.
   - **Bypass 2FA:** ON (CI cannot prompt for OTP).
   - Expiration: 1 year is a sensible balance.

2. **Store it as the repo secret `NPM_TOKEN`:**
   - https://github.com/Group-Taiga/lunaar-mcp-server/settings/secrets/actions → **New repository secret** → name `NPM_TOKEN`.

3. **First end-to-end run:** push a no-op patch tag (`npm version patch && git push --follow-tags`). Watch the Release workflow run; if it goes green and the new version appears on https://www.npmjs.com/package/@lunaar/mcp-server, the pipeline is wired up.

After that, every future release is just `npm version <type> && git push --follow-tags`.

### Version bump conventions

- **patch** (`0.1.0 → 0.1.1`) — bug fixes, doc tweaks, new optional tool params, internal refactors.
- **minor** (`0.1.x → 0.2.0`) — new tools, new required params (rare — prefer optional), enum value additions, bumped polling timeouts.
- **major** (`0.x → 1.0`, then `1.x → 2.x`) — removed tools, renamed args, removed/renamed enum values, breaking schema changes.

While `< 1.0`, treat **minor** as the breaking-change boundary (semver convention).

### When to release

Push a new patch / minor whenever the upstream Lunaar Public API changes in a
way that a tool needs to know about:

- New endpoint added → new tool registration → minor bump.
- Existing endpoint adds an optional field → patch bump (extend the Zod schema).
- Endpoint removes a field, renames an enum value, or changes a route → major bump and call out the migration in `CHANGELOG.md`.

Day-to-day, you don't have to keep this package in lockstep with PublicApi —
the wire format is intentionally stable. Bump only when you've added user-
visible value (a new tool, a clearer description, a fix).

## License

MIT — see [LICENSE](./LICENSE).
