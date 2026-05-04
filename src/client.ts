/**
 * Thin client around the Lunaar PublicApi REST surface.
 *
 * Responsibilities:
 *   - Inject `X-Api-Key` on every request.
 *   - Build multipart/form-data requests for the `/v1/ai/*` create endpoints from
 *     local file paths (the MCP host gives us paths, not Buffers).
 *   - Provide a polling helper that waits until an Operation reaches a terminal state,
 *     surfacing the user-friendly error message verbatim when the run fails so the
 *     LLM doesn't have to invent its own.
 *
 * Anything REST-shape-specific (route names, DTO field names, enum values) lives
 * here so each tool file stays focused on the prompt schema the model sees.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const DEFAULT_BASE_URL = "https://api.lunaarvision.com";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;

/** Mime sniff from extension — Lunaar accepts JPG / PNG / WEBP / HEIC for image inputs. */
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

export type OperationStatus =
  | "Pending"
  | "Processing"
  | "Completed"
  | "Failed"
  | "Cancelled";

export interface OperationDto {
  operationId: string;
  type: string;
  status: OperationStatus;
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

export interface CreateAcceptedDto {
  operationId: string;
  status: string;
  message?: string;
  // Studio echoes a separate entity id (the `data.id` we need for /poses follow-ups).
  id?: string;
}

export interface PagedOperationsDto {
  items: OperationDto[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
  statusCounts: { total: number; completed: number; processing: number; failed: number };
}

export interface ApiResponse<T> {
  status: boolean;
  data: T | null;
  message?: string;
  httpStatusCode: number;
  validationErrors?: Record<string, string[]>;
}

export class LunaarApiError extends Error {
  readonly httpStatus: number;
  readonly validationErrors?: Record<string, string[]>;
  constructor(
    message: string,
    httpStatus: number,
    validationErrors?: Record<string, string[]>
  ) {
    super(message);
    this.name = "LunaarApiError";
    this.httpStatus = httpStatus;
    this.validationErrors = validationErrors;
  }
}

export class LunaarClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    const apiKey = opts?.apiKey ?? process.env.LUNAAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LUNAAR_API_KEY env var is required. Get one from https://platform.lunaarvision.com → API Keys."
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts?.baseUrl ?? process.env.LUNAAR_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      ""
    );
  }

  /**
   * POST a multipart create call; returns the 202 envelope's `data` payload.
   *
   * Generic is unconstrained because not every multipart endpoint follows the
   * `CreateAcceptedDto` shape — Model-to-AR returns a sync `{modelId, url, glbUrl…}`
   * payload, while the AI/* create endpoints return the `{operationId, status}`
   * accepted-shape. Each caller pins its expected `T`.
   */
  async submitMultipart<T>(
    path: string,
    fields: Record<string, FormFieldValue>
  ): Promise<T> {
    const form = await buildFormData(fields);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "User-Agent": userAgent() },
      body: form,
    });
    return await readEnvelope<T>(res);
  }

  /** POST a JSON body — used by /v1/ai/studio/poses. */
  async submitJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
      },
      body: JSON.stringify(body),
    });
    return await readEnvelope<T>(res);
  }

  /** POST that takes only a path id (e.g. /v1/ai/upscale/{id}) and no body. */
  async submitEmpty<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "User-Agent": userAgent() },
    });
    return await readEnvelope<T>(res);
  }

  /** Single-shot operation status read. */
  async getOperation(operationId: string): Promise<OperationDto> {
    const res = await fetch(`${this.baseUrl}/v1/operations/${operationId}`, {
      headers: { "X-Api-Key": this.apiKey, "User-Agent": userAgent() },
    });
    return await readEnvelope<OperationDto>(res);
  }

  /** Paginated list of recent operations for the authenticated client. */
  async listOperations(opts: {
    page: number;
    pageSize: number;
    type?: string;
    status?: string;
  }): Promise<PagedOperationsDto> {
    const search = new URLSearchParams({
      pageNumber: String(opts.page),
      pageSize: String(opts.pageSize),
    });
    if (opts.type) search.set("type", opts.type);
    if (opts.status) search.set("status", opts.status);
    const res = await fetch(`${this.baseUrl}/v1/operations?${search.toString()}`, {
      headers: { "X-Api-Key": this.apiKey, "User-Agent": userAgent() },
    });
    return await readEnvelope<PagedOperationsDto>(res);
  }

  /**
   * Poll `/v1/operations/{id}` until the run is no longer in flight, or until the
   * timeout elapses. The MCP host typically caps tool execution at 60-180s, so the
   * default timeout (180s) covers virtually every endpoint except Image-to-3D — for
   * those, callers should fall back to `lunaar_get_operation`.
   */
  async waitForCompletion(
    operationId: string,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<OperationDto> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const op = await this.getOperation(operationId);
      if (op.status === "Completed" || op.status === "Failed" || op.status === "Cancelled") {
        return op;
      }
      if (Date.now() > deadline) {
        return op; // caller decides — return whatever non-terminal state we last saw
      }
      await sleep(intervalMs);
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export type FormFieldValue =
  | string
  | number
  | boolean
  | { filePath: string; field: string }
  | { filePath: string }
  | undefined
  | null;

async function buildFormData(fields: Record<string, FormFieldValue>): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && "filePath" in value) {
      const path = value.filePath;
      const info = await stat(path).catch(() => null);
      if (!info || !info.isFile()) {
        throw new Error(`File not found at ${path} (field "${key}").`);
      }
      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      const blob = new Blob([buf], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" });
      form.append(key, blob, basename(path));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

async function readEnvelope<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: ApiResponse<T> | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new LunaarApiError(
        `Non-JSON response from Lunaar (HTTP ${res.status}). Body: ${text.slice(0, 200)}`,
        res.status
      );
    }
  }

  if (!res.ok || (body && body.status === false)) {
    const msg = body?.message ?? `HTTP ${res.status}`;
    throw new LunaarApiError(msg, res.status, body?.validationErrors);
  }

  if (!body) {
    throw new LunaarApiError("Empty response body from Lunaar", res.status);
  }

  return body.data as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let cachedUserAgent: string | undefined;
function userAgent(): string {
  if (!cachedUserAgent) {
    // Surfaces in Lunaar's Loki dashboards so they can see traffic origin breakdown.
    cachedUserAgent = `lunaar-mcp-server/${process.env.npm_package_version ?? "0.1.0"} (+https://platform.lunaarvision.com)`;
  }
  return cachedUserAgent;
}
