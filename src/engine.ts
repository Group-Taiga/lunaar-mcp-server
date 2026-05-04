/**
 * Generic engine that turns a single manifest entry into:
 *   1. An MCP tool registration (name + description + JSON Schema).
 *   2. A handler that, given the model-supplied args, builds the right HTTP
 *      request, polls (when applicable), and formats the result.
 *
 * Every tool — sketch / studio / jewelry / poses / 3D / AR / upscale / ops /
 * list — flows through the same code paths here. Adding a new endpoint on the
 * server just needs a new manifest entry; this file does NOT need to change.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  FieldSpec,
  JsonShapeField,
  Manifest,
  ToolSpec,
  Transport,
} from "./manifest-types.js";

// ─── configuration ────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".glb": "model/gltf-binary",
  ".usdz": "model/vnd.usdz+zip",
  ".mp4": "video/mp4",
};

const DEFAULT_POLL_INTERVAL_MS = 2000;

// ─── shapes returned by Lunaar ────────────────────────────────────────────────

interface ApiEnvelope<T> {
  status: boolean;
  data: T | null;
  message?: string;
  httpStatusCode: number;
  validationErrors?: Record<string, string[]>;
}

interface CreatedDto {
  operationId: string;
  status: string;
  message?: string;
  id?: string;
}

interface OperationDto {
  operationId: string;
  type: string;
  status: "Pending" | "Processing" | "Completed" | "Failed" | "Cancelled";
  errorMessage: string | null;
  creditsUsed: number | null;
  creditsRefunded: number | null;
  generatedImageUrl: string | null;
  upscaledImageUrl: string | null;
  output: Record<string, string> | null;
  measurements: Record<string, number | null> | null;
  completedAt: string | null;
  createdAt: string;
}

interface ListDto {
  items: OperationDto[];
  pagination: { currentPage: number; pageSize: number; totalPages: number; totalCount: number };
  statusCounts: { total: number; completed: number; processing: number; failed: number };
}

class LunaarApiError extends Error {
  readonly httpStatus: number;
  readonly validationErrors?: Record<string, string[]>;
  constructor(message: string, httpStatus: number, validationErrors?: Record<string, string[]>) {
    super(message);
    this.httpStatus = httpStatus;
    this.validationErrors = validationErrors;
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface EngineOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function registerManifest(server: Server, manifest: Manifest, opts: EngineOptions): void {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const userAgent = `lunaar-mcp-server/${process.env.npm_package_version ?? "0.2.0"} (manifest=${manifest.version})`;
  const baseUrl = (process.env.LUNAAR_BASE_URL ?? opts.baseUrl ?? manifest.baseUrl).replace(/\/$/, "");

  // tools/list — straight projection of manifest entries.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as never, // SDK accepts any JSON-Schema-shaped object here
    })),
  }));

  // tools/call — dispatch by name, run the manifest-driven engine.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = manifest.tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return errorResult(`Unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await executeTool(tool, args, { baseUrl, apiKey: opts.apiKey, fetchImpl, userAgent });
    } catch (err) {
      return errorResult(formatError(err));
    }
  });
}

interface ExecutionContext {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  userAgent: string;
}

async function executeTool(
  tool: ToolSpec,
  args: Record<string, unknown>,
  ctx: ExecutionContext
): Promise<CallToolResult> {
  const transport = tool.transport;
  const path = substitutePath(transport.pathTemplate, args);
  const url = `${ctx.baseUrl}${path}`;

  // Build request based on body shape.
  let init: RequestInit;
  if (transport.method === "GET") {
    const query = (transport as Extract<Transport, { method: "GET" }>).query ?? [];
    const search = buildQueryString(query, args);
    init = {
      method: "GET",
      headers: { "X-Api-Key": ctx.apiKey, "User-Agent": ctx.userAgent },
    };
    return await dispatchGet(`${url}${search}`, init, ctx, tool, args);
  }

  // POST variants.
  const bodyKind = (transport as Extract<Transport, { method: "POST" }>).body;
  if (bodyKind === "multipart") {
    const fields = (transport as Extract<Transport, { body: "multipart" }>).fields;
    const form = await buildMultipart(fields, args);
    init = {
      method: "POST",
      headers: { "X-Api-Key": ctx.apiKey, "User-Agent": ctx.userAgent },
      body: form,
    };
  } else if (bodyKind === "json") {
    const shape = (transport as Extract<Transport, { body: "json" }>).jsonShape;
    const body = buildJsonBody(shape, args);
    init = {
      method: "POST",
      headers: {
        "X-Api-Key": ctx.apiKey,
        "User-Agent": ctx.userAgent,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
  } else {
    init = {
      method: "POST",
      headers: { "X-Api-Key": ctx.apiKey, "User-Agent": ctx.userAgent },
    };
  }

  return await dispatchPost(url, init, ctx, tool, args);
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

async function dispatchPost(
  url: string,
  init: RequestInit,
  ctx: ExecutionContext,
  tool: ToolSpec,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const body = await postAndUnwrap(url, init, ctx);
  const expects = tool.transport.expects;
  const transport = tool.transport as Extract<Transport, { method: "POST" }>;

  switch (expects) {
    case "operation": {
      const created = body as CreatedDto;
      const op = await pollUntilTerminal(created.operationId, ctx, transport.pollTimeoutMs);
      return formatOperation(op, tool, args, "captureCreatedId" in transport && transport.captureCreatedId ? created : undefined);
    }
    case "operation-array": {
      const created = body as CreatedDto[];
      const ops = await Promise.all(
        created.map((c) => pollUntilTerminal(c.operationId, ctx, transport.pollTimeoutMs))
      );
      const sections = ops.map((op, i) => formatOperationContent(op, `${tool.result.label ?? tool.name} #${i + 1}`));
      return { content: sections.flat() };
    }
    case "sync": {
      return formatSync(body as Record<string, unknown>, tool, args);
    }
    case "upscale": {
      // Inline 200 path: body has `{ upscaledImageUrl, status }`. If empty/queued → poll the parent op.
      const inlineUrl = (body as { upscaledImageUrl?: string }).upscaledImageUrl;
      if (inlineUrl && inlineUrl.length > 0) {
        return textResult(`${tool.result.label ?? "Upscale"} → Completed (sync).\nupscaledImageUrl: ${inlineUrl}`);
      }
      const opId = String(args.operationId);
      const op = await pollUntilTerminal(opId, ctx, transport.pollTimeoutMs);
      if (op.upscaledImageUrl) {
        return textResult(`${tool.result.label ?? "Upscale"} → Completed.\nupscaledImageUrl: ${op.upscaledImageUrl}`);
      }
      return textResult(
        `${tool.result.label ?? "Upscale"} queued; still ${op.status}. Call lunaar_get_operation later.`
      );
    }
    default:
      return errorResult(`Engine: unsupported expects '${expects}' for POST ${tool.name}`);
  }
}

async function dispatchGet(
  url: string,
  init: RequestInit,
  ctx: ExecutionContext,
  tool: ToolSpec,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const body = await fetchAndUnwrap(url, init, ctx);
  const expects = tool.transport.expects;

  switch (expects) {
    case "operation-snapshot":
      return formatOperation(body as OperationDto, tool, args);
    case "list":
      return formatList(body as ListDto, tool);
    default:
      return errorResult(`Engine: unsupported expects '${expects}' for GET ${tool.name}`);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function postAndUnwrap(url: string, init: RequestInit, ctx: ExecutionContext): Promise<unknown> {
  const res = await ctx.fetchImpl(url, init);
  return await readEnvelope(res);
}

async function fetchAndUnwrap(url: string, init: RequestInit, ctx: ExecutionContext): Promise<unknown> {
  const res = await ctx.fetchImpl(url, init);
  return await readEnvelope(res);
}

async function readEnvelope(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: ApiEnvelope<unknown> | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new LunaarApiError(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
    }
  }
  if (!res.ok || (body && body.status === false)) {
    throw new LunaarApiError(body?.message ?? `HTTP ${res.status}`, res.status, body?.validationErrors);
  }
  if (!body) {
    throw new LunaarApiError("Empty response body", res.status);
  }
  return body.data;
}

async function pollUntilTerminal(
  operationId: string,
  ctx: ExecutionContext,
  timeoutMs: number = 180_000
): Promise<OperationDto> {
  const url = `${ctx.baseUrl}/v1/operations/${encodeURIComponent(operationId)}`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const op = (await fetchAndUnwrap(url, {
      headers: { "X-Api-Key": ctx.apiKey, "User-Agent": ctx.userAgent },
    }, ctx)) as OperationDto;
    if (op.status === "Completed" || op.status === "Failed" || op.status === "Cancelled") {
      return op;
    }
    if (Date.now() > deadline) return op;
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
}

// ─── request body builders ────────────────────────────────────────────────────

async function buildMultipart(fields: FieldSpec[], args: Record<string, unknown>): Promise<FormData> {
  const form = new FormData();
  for (const f of fields) {
    const raw = args[f.from];
    if (raw === undefined || raw === null) {
      if (!f.optional) throw new Error(`Missing required field: ${f.from}`);
      continue;
    }
    const wireValue = await convertField(f, raw);
    if (wireValue.kind === "file") {
      form.append(f.name, wireValue.blob, wireValue.filename);
    } else {
      form.append(f.name, wireValue.value);
    }
  }
  return form;
}

function buildJsonBody(
  shape: Record<string, JsonShapeField>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [outName, spec] of Object.entries(shape)) {
    const raw = args[spec.from];
    if (raw === undefined || raw === null) {
      if (!spec.optional) throw new Error(`Missing required field: ${spec.from}`);
      continue;
    }
    if (spec.kind === "enumArray") {
      if (!spec.map) throw new Error(`enumArray field ${outName} missing 'map'`);
      if (!Array.isArray(raw)) throw new Error(`Field ${spec.from} must be an array`);
      body[outName] = raw.map((v) => {
        const m = spec.map![String(v)];
        if (m === undefined) throw new Error(`Unknown enum value for ${spec.from}: ${String(v)}`);
        return m;
      });
    } else if (spec.kind === "enum") {
      if (!spec.map) throw new Error(`enum field ${outName} missing 'map'`);
      const m = spec.map[String(raw)];
      if (m === undefined) throw new Error(`Unknown enum value for ${spec.from}: ${String(raw)}`);
      body[outName] = m;
    } else {
      body[outName] = raw;
    }
  }
  return body;
}

function buildQueryString(query: FieldSpec[], args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const f of query) {
    const raw = args[f.from];
    if (raw === undefined || raw === null) {
      if (!f.optional) throw new Error(`Missing required query field: ${f.from}`);
      continue;
    }
    if (f.kind === "enum" && f.map) {
      const m = f.map[String(raw)];
      params.set(f.name, String(m));
    } else {
      params.set(f.name, String(raw));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

type ConvertedField =
  | { kind: "scalar"; value: string }
  | { kind: "file"; blob: Blob; filename: string };

async function convertField(spec: FieldSpec, raw: unknown): Promise<ConvertedField> {
  switch (spec.kind) {
    case "string":
    case "number":
    case "boolean":
      return { kind: "scalar", value: String(raw) };
    case "enum": {
      if (!spec.map) throw new Error(`enum field ${spec.name} missing 'map'`);
      const m = spec.map[String(raw)];
      if (m === undefined) throw new Error(`Unknown enum value for ${spec.from}: ${String(raw)}`);
      return { kind: "scalar", value: String(m) };
    }
    case "file": {
      const path = String(raw);
      const info = await stat(path).catch(() => null);
      if (!info || !info.isFile()) {
        throw new Error(`File not found at ${path} (field "${spec.from}")`);
      }
      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      const blob = new Blob([buf], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" });
      return { kind: "file", blob, filename: basename(path) };
    }
    default:
      throw new Error(`Unsupported field kind: ${spec.kind}`);
  }
}

// ─── result formatters ────────────────────────────────────────────────────────

function formatOperation(
  op: OperationDto,
  tool: ToolSpec,
  args: Record<string, unknown>,
  created?: CreatedDto
): CallToolResult {
  const label = renderTemplate(tool.result.label ?? tool.name, args);
  const content = formatOperationContent(op, label);
  if (op.status === "Completed" && created && tool.result.extras) {
    for (const ex of tool.result.extras) {
      if (ex.from === "created") {
        const v = (created as unknown as Record<string, unknown>)[ex.field];
        if (v !== undefined) {
          content.push({ type: "text", text: `${ex.label}: ${String(v)}` });
        }
      }
    }
  }
  return { content };
}

function formatOperationContent(op: OperationDto, label: string): { type: "text"; text: string }[] {
  if (op.status === "Failed") {
    const lines = [`${label} → Failed.`];
    if (op.errorMessage) {
      lines.push("", "Reason given to the user:", op.errorMessage);
    }
    if (op.creditsRefunded) {
      lines.push("", `Credits refunded: ${op.creditsRefunded}.`);
    }
    lines.push("", `OperationId: ${op.operationId}`);
    return [{ type: "text", text: lines.join("\n") }];
  }
  if (op.status !== "Completed") {
    return [
      {
        type: "text",
        text: `${label} is still ${op.status} (operationId ${op.operationId}). Call lunaar_get_operation in 30-60s to fetch the final URL.`,
      },
    ];
  }
  const lines = [`${label} → Completed.`, `OperationId: ${op.operationId}`, ""];
  if (op.generatedImageUrl) lines.push(`generatedImageUrl: ${op.generatedImageUrl}`);
  if (op.upscaledImageUrl) lines.push(`upscaledImageUrl: ${op.upscaledImageUrl}`);
  if (op.output) {
    for (const [k, v] of Object.entries(op.output)) lines.push(`${k}: ${v}`);
  }
  if (op.measurements) {
    lines.push(`measurements: ${JSON.stringify(op.measurements)}`);
  }
  if (lines.length === 3) lines.push("(no asset urls returned)");
  return [{ type: "text", text: lines.join("\n") }];
}

function formatSync(body: Record<string, unknown>, tool: ToolSpec, args: Record<string, unknown>): CallToolResult {
  const label = renderTemplate(tool.result.label ?? tool.name, args);
  const fields = tool.result.syncFields ?? Object.keys(body);
  const lines = [`${label} → Completed.`];
  for (const f of fields) {
    const v = body[f];
    if (v !== undefined && v !== null) lines.push(`${f}: ${String(v)}`);
  }
  return textResult(lines.join("\n"));
}

function formatList(page: ListDto, tool: ToolSpec): CallToolResult {
  const counts = page.statusCounts;
  const lines = [
    `${tool.result.label ?? "Operations"} — total=${counts.total}, completed=${counts.completed}, processing=${counts.processing}, failed=${counts.failed}`,
    "",
    ...page.items.map(
      (o) =>
        `• ${o.operationId} | ${o.type} | ${o.status} | credits=${o.creditsUsed ?? 0}` +
        (o.creditsRefunded ? ` (refunded ${o.creditsRefunded})` : "")
    ),
  ];
  return textResult(lines.join("\n"));
}

// ─── primitives ───────────────────────────────────────────────────────────────

function substitutePath(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = args[key];
    if (v === undefined || v === null) {
      throw new Error(`Path placeholder {${key}} has no input value`);
    }
    return encodeURIComponent(String(v));
  });
}

function renderTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = args[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function formatError(err: unknown): string {
  if (err instanceof LunaarApiError) {
    const lines = [`Lunaar API returned ${err.httpStatus}: ${err.message}`];
    if (err.validationErrors) {
      for (const [field, msgs] of Object.entries(err.validationErrors)) {
        lines.push(`  • ${field}: ${msgs.join(", ")}`);
      }
    }
    return lines.join("\n");
  }
  return (err as Error)?.message ?? String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
