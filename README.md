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

```bash
npm version patch    # or minor / major
npm publish --access public
```

Versioning follows semver. Breaking tool-schema changes (renamed args, removed enum values) → minor bump until 1.0, major after.

## License

MIT — see [LICENSE](./LICENSE).
