/**
 * Wire shape of the MCP tool manifest served by `GET /v1/mcp/manifest.json`.
 *
 * The schema is deliberately small and JSON-only — both ends of the contract
 * (the .NET ManifestController and this TypeScript loader) read it as plain
 * JSON, so anything more elaborate would just create translation friction.
 *
 * Versioning: a top-level `version: "1"` field gates schema-breaking changes.
 * Adding new tools, new optional fields, or new enum entries does NOT require
 * a version bump — the engine ignores fields it doesn't recognise. Only when
 * existing semantics change (e.g. a `field.kind` value's behaviour, or a new
 * required top-level key) do we ship `version: "2"` and a new server major.
 */

export type FieldKind = "string" | "number" | "boolean" | "enum" | "file" | "enumArray";

export interface FieldSpec {
  /** The wire name on the REST request (e.g. "Image", "SceneType"). */
  name: string;
  kind: FieldKind;
  /** The argument key the model fills (e.g. "imagePath", "sceneType"). */
  from: string;
  /** Skipped silently when the input value is undefined/null. */
  optional?: boolean;
  /** Required for `kind: "enum"` and `kind: "enumArray"` — string→number mapping. */
  map?: Record<string, string | number>;
}

export interface JsonShapeField {
  /** Argument key — same `from` semantic as multipart fields. */
  from: string;
  /** Optional transform. Default: pass-through. */
  kind?: FieldKind;
  map?: Record<string, string | number>;
  optional?: boolean;
}

export type Transport =
  | {
      method: "POST";
      pathTemplate: string;
      body: "multipart";
      fields: FieldSpec[];
      expects: ExpectsKind;
      pollTimeoutMs?: number;
      pollIntervalMs?: number;
      /** When true, the create response is expected to include an `id` (Studio entityId). */
      captureCreatedId?: boolean;
    }
  | {
      method: "POST";
      pathTemplate: string;
      body: "json";
      jsonShape: Record<string, JsonShapeField>;
      expects: ExpectsKind;
      pollTimeoutMs?: number;
      pollIntervalMs?: number;
    }
  | {
      method: "POST";
      pathTemplate: string;
      body: "empty";
      expects: ExpectsKind;
      pollTimeoutMs?: number;
      pollIntervalMs?: number;
    }
  | {
      method: "GET";
      pathTemplate: string;
      query?: FieldSpec[];
      expects: ExpectsKind;
    };

/**
 * Result-shape modes the engine knows how to handle:
 *   - `operation`           POST returns 202 with `data.operationId`; poll until terminal.
 *   - `operation-array`     POST returns 202 with `data: [{ operationId, ... }]`; poll each.
 *   - `operation-snapshot`  GET returns the full OperationDto inline; no polling.
 *   - `sync`                Endpoint completes synchronously; return body fields verbatim.
 *   - `upscale`             POST may return inline (200 with upscaledImageUrl) or queued (202 + poll the parent op).
 *   - `list`                GET returns paged operations DTO; emit a one-line summary per item.
 */
export type ExpectsKind =
  | "operation"
  | "operation-array"
  | "operation-snapshot"
  | "sync"
  | "upscale"
  | "list";

export interface ResultSpec {
  /** Header label for completion / failure messages. May reference {input.x}. */
  label?: string;
  /** Sync endpoints: list of fields from the body to surface. */
  syncFields?: string[];
  /** Extras to append to a successful operation result (e.g. Studio entityId). */
  extras?: Array<{
    when: "completed";
    field: string;
    from: "created";
    label: string;
  }>;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for tool input. We pass it to the MCP SDK verbatim. */
  inputSchema: Record<string, unknown>;
  transport: Transport;
  result: ResultSpec;
}

export interface Manifest {
  /** Schema version (currently "1"). */
  version: string;
  /** Where requests should be sent. The MCP server uses LUNAAR_BASE_URL when set. */
  baseUrl: string;
  tools: ToolSpec[];
}

export interface ManifestLoadResult {
  manifest: Manifest;
  /** Where this copy came from — surfaces in the server's MCP `instructions`. */
  source: "live" | "cache" | "fallback";
  /** When the manifest was originally fetched from the live URL. */
  fetchedAt: string;
}
