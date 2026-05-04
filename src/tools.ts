/**
 * Tool registrations. Each `registerXxx` adds one MCP tool whose schema is what the
 * model sees, calls the REST endpoint, polls until terminal, and returns either the
 * final asset URL(s) or a structured "still processing — call lunaar_get_operation
 * later" handoff.
 *
 * One file (instead of one per tool) because every wrapper is ~30 lines and the
 * shared shape (parse args → submit → wait → format result) reads better adjacent.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LunaarClient,
  LunaarApiError,
  type CreateAcceptedDto,
  type OperationDto,
} from "./client.js";

// ─── Enum schemas (kept in sync with prompts.json + DTO docs) ─────────────────

const SceneType = z.enum(["interior", "exterior", "kitchen"]);
const TimeOfDay = z.enum(["day", "evening"]);
const CabinetSurface = z.enum(["matte", "soft_satin", "satin", "glossy"]);
const HandleFinish = z.enum(["matte", "glossy"]);

const StudioMode = z.enum(["single_item", "combo", "layer", "summer"]);
const StudioBackgroundSeason = z.enum(["spring", "summer", "autumn", "winter", "studio"]);
const FitType = z.enum(["slim_fit", "regular_fit", "relaxed_fit", "oversize"]);
const DressLength = z.enum(["mini", "short", "midi", "maxi"]);

const PoseType = z.enum(["front", "side45", "side90", "back"]);

const JewelryDisplayMode = z.enum([
  "box_display",
  "product_model_display",
  "custom_surface_box_display",
  "custom_model_display",
]);
const JewelryProductType = z.enum(["ring", "necklace", "bracelet", "watch", "earring"]);
const JewelryGender = z.enum(["male", "female"]);

// ─── Enum → integer mappings ──────────────────────────────────────────────────

const SCENE_TYPE_INT: Record<z.infer<typeof SceneType>, number> = {
  interior: 0,
  exterior: 1,
  kitchen: 2,
};
const TIME_OF_DAY_INT: Record<z.infer<typeof TimeOfDay>, number> = {
  day: 0,
  evening: 1,
};
const CABINET_SURFACE_INT: Record<z.infer<typeof CabinetSurface>, number> = {
  matte: 0,
  soft_satin: 1,
  satin: 2,
  glossy: 3,
};
const HANDLE_FINISH_INT: Record<z.infer<typeof HandleFinish>, number> = {
  matte: 0,
  glossy: 1,
};
const STUDIO_MODE_INT: Record<z.infer<typeof StudioMode>, number> = {
  single_item: 1,
  combo: 2,
  layer: 3,
  summer: 4,
};
const STUDIO_SEASON_INT: Record<z.infer<typeof StudioBackgroundSeason>, number> = {
  spring: 1,
  summer: 2,
  autumn: 3,
  winter: 4,
  studio: 5,
};
const FIT_TYPE_INT: Record<z.infer<typeof FitType>, number> = {
  slim_fit: 1,
  regular_fit: 2,
  relaxed_fit: 3,
  oversize: 4,
};
const DRESS_LENGTH_INT: Record<z.infer<typeof DressLength>, number> = {
  mini: 1,
  short: 2,
  midi: 3,
  maxi: 4,
};
const POSE_TYPE_INT: Record<z.infer<typeof PoseType>, number> = {
  front: 1,
  side45: 2,
  side90: 3,
  back: 4,
};
const JEWELRY_DISPLAY_INT: Record<z.infer<typeof JewelryDisplayMode>, number> = {
  box_display: 1,
  product_model_display: 2,
  custom_surface_box_display: 3,
  custom_model_display: 4,
};
const JEWELRY_PRODUCT_INT: Record<z.infer<typeof JewelryProductType>, number> = {
  ring: 1,
  necklace: 2,
  bracelet: 3,
  watch: 4,
  earring: 5,
};
const JEWELRY_GENDER_INT: Record<z.infer<typeof JewelryGender>, number> = {
  male: 1,
  female: 2,
};

// ─── Result helpers ───────────────────────────────────────────────────────────

/** Standard MCP `content` shape — text-first plus optional image preview. */
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asError(error: unknown) {
  if (error instanceof LunaarApiError) {
    const lines = [`Lunaar API returned ${error.httpStatus}: ${error.message}`];
    if (error.validationErrors) {
      for (const [field, msgs] of Object.entries(error.validationErrors)) {
        lines.push(`  • ${field}: ${msgs.join(", ")}`);
      }
    }
    return { isError: true, content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: (error as Error)?.message ?? String(error) }],
  };
}

/** Format a finished operation for the model — terminal status decides the framing. */
function formatOperation(op: OperationDto, label: string) {
  if (op.status === "Failed") {
    return asText(
      [
        `${label} → Failed.`,
        op.errorMessage ? `\nReason given to the user:\n${op.errorMessage}` : "",
        op.creditsRefunded
          ? `\nCredits refunded: ${op.creditsRefunded}.`
          : "",
        `\nOperationId: ${op.operationId}`,
      ]
        .filter(Boolean)
        .join("")
    );
  }
  if (op.status !== "Completed") {
    return asText(
      `${label} is still ${op.status} (operationId ${op.operationId}). Call lunaar_get_operation with this id in 30-60s to fetch the final URL.`
    );
  }
  const urls: string[] = [];
  if (op.generatedImageUrl) urls.push(`generatedImageUrl: ${op.generatedImageUrl}`);
  if (op.upscaledImageUrl) urls.push(`upscaledImageUrl: ${op.upscaledImageUrl}`);
  if (op.output) {
    for (const [k, v] of Object.entries(op.output)) urls.push(`${k}: ${v}`);
  }
  if (op.measurements) {
    urls.push(`measurements: ${JSON.stringify(op.measurements)}`);
  }
  return asText(
    [
      `${label} → Completed.`,
      `OperationId: ${op.operationId}`,
      ...(urls.length ? ["", ...urls] : ["", "(no asset urls returned)"]),
    ].join("\n")
  );
}

// ─── Tool registrations ───────────────────────────────────────────────────────

export function registerAllTools(server: McpServer, client: LunaarClient): void {
  registerSketchToRender(server, client);
  registerStudioTryOn(server, client);
  registerStudioPoses(server, client);
  registerJewelryTryOn(server, client);
  registerGlassesTryOn(server, client);
  registerBodyEstimation(server, client);
  registerImageTo3D(server, client);
  registerModelToAr(server, client);
  registerUpscale(server, client);
  registerGetOperation(server, client);
  registerListOperations(server, client);
}

function registerSketchToRender(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_sketch_to_render",
    "Convert a sketch into a photorealistic interior, exterior, or kitchen render. 15 credits per call. Returns the final image URL (Completed) or operationId for later polling.",
    {
      imagePath: z.string().describe("Local file path to the sketch (jpg/png/webp/heic, ≤25MB)."),
      sceneType: SceneType.default("interior"),
      timeOfDay: TimeOfDay.default("day"),
      lowerCabinetSurface: CabinetSurface.optional().describe("Kitchen only."),
      upperCabinetSurface: CabinetSurface.optional().describe("Kitchen only."),
      tallCabinetSurface: CabinetSurface.optional().describe("Kitchen only."),
      countertopSurface: CabinetSurface.optional().describe("Kitchen only."),
      handleFinish: HandleFinish.optional().describe("Kitchen only."),
      accessory: z.boolean().optional().describe("Kitchen only — render countertop accessories."),
      glassCabinetLed: z.boolean().optional().describe("Kitchen only — LED inside glass cabinets."),
      openShelfLed: z.boolean().optional().describe("Kitchen only — LED under open shelves."),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>(
          "/v1/ai/sketch-to-img",
          {
            Image: { filePath: args.imagePath },
            SceneType: SCENE_TYPE_INT[args.sceneType],
            TimeOfDay: TIME_OF_DAY_INT[args.timeOfDay],
            LowerCabinetSurface:
              args.lowerCabinetSurface !== undefined
                ? CABINET_SURFACE_INT[args.lowerCabinetSurface]
                : undefined,
            UpperCabinetSurface:
              args.upperCabinetSurface !== undefined
                ? CABINET_SURFACE_INT[args.upperCabinetSurface]
                : undefined,
            TallCabinetSurface:
              args.tallCabinetSurface !== undefined
                ? CABINET_SURFACE_INT[args.tallCabinetSurface]
                : undefined,
            CountertopSurface:
              args.countertopSurface !== undefined
                ? CABINET_SURFACE_INT[args.countertopSurface]
                : undefined,
            HandleFinish:
              args.handleFinish !== undefined ? HANDLE_FINISH_INT[args.handleFinish] : undefined,
            Accessory: args.accessory,
            GlassCabinetLed: args.glassCabinetLed,
            OpenShelfLed: args.openShelfLed,
          }
        );
        const op = await client.waitForCompletion(created.operationId);
        return formatOperation(op, `Sketch → ${args.sceneType} ${args.timeOfDay}`);
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerStudioTryOn(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_studio_tryon",
    "Virtual try-on. SingleItem (10 credits): person + 1 garment. Combo (15): person + 2-6 garments. Layer (15): person + 3 stacked garments. Summer (15): swimwear with environment.",
    {
      mode: StudioMode,
      personImagePath: z.string().optional().describe("Required for single_item / combo / layer. Not used for summer."),
      // SingleItem
      clothingImagePath: z.string().optional().describe("single_item only."),
      clothingCategory: z.enum(["dress", "top", "bottom", "accessory", "shoes", "outerwear"]).optional().describe("single_item only."),
      // Combo
      topImagePath: z.string().optional(),
      bottomImagePath: z.string().optional(),
      dressImagePath: z.string().optional(),
      outerwearImagePath: z.string().optional(),
      accessoryImagePath: z.string().optional(),
      shoesImagePath: z.string().optional(),
      // Layer
      layer1ImagePath: z.string().optional(),
      layer2ImagePath: z.string().optional(),
      layer3ImagePath: z.string().optional(),
      // Summer
      bikiniTopImagePath: z.string().optional(),
      bikiniBottomImagePath: z.string().optional(),
      swimSuitImagePath: z.string().optional(),
      menSwimwearImagePath: z.string().optional(),
      backgroundSeason: StudioBackgroundSeason.optional(),
      // Cross-mode optional refinements
      fitType: FitType.optional(),
      dressLength: DressLength.optional(),
      maskImagePath: z.string().optional(),
    },
    async (args) => {
      const CLOTHING_CATEGORY_INT: Record<string, number> = {
        dress: 1,
        top: 2,
        bottom: 3,
        accessory: 4,
        shoes: 5,
        outerwear: 6,
      };
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>("/v1/ai/studio", {
          Mode: STUDIO_MODE_INT[args.mode],
          PersonImage: args.personImagePath ? { filePath: args.personImagePath } : undefined,
          ClothingImage: args.clothingImagePath ? { filePath: args.clothingImagePath } : undefined,
          ClothingCategory: args.clothingCategory ? CLOTHING_CATEGORY_INT[args.clothingCategory] : undefined,
          DressLength: args.dressLength ? DRESS_LENGTH_INT[args.dressLength] : undefined,
          DressImage: args.dressImagePath ? { filePath: args.dressImagePath } : undefined,
          TopImage: args.topImagePath ? { filePath: args.topImagePath } : undefined,
          BottomImage: args.bottomImagePath ? { filePath: args.bottomImagePath } : undefined,
          OuterwearImage: args.outerwearImagePath ? { filePath: args.outerwearImagePath } : undefined,
          AccessoryImage: args.accessoryImagePath ? { filePath: args.accessoryImagePath } : undefined,
          ShoesImage: args.shoesImagePath ? { filePath: args.shoesImagePath } : undefined,
          Layer1Image: args.layer1ImagePath ? { filePath: args.layer1ImagePath } : undefined,
          Layer2Image: args.layer2ImagePath ? { filePath: args.layer2ImagePath } : undefined,
          Layer3Image: args.layer3ImagePath ? { filePath: args.layer3ImagePath } : undefined,
          BikiniTopImage: args.bikiniTopImagePath ? { filePath: args.bikiniTopImagePath } : undefined,
          BikiniBottomImage: args.bikiniBottomImagePath ? { filePath: args.bikiniBottomImagePath } : undefined,
          SwimSuitImage: args.swimSuitImagePath ? { filePath: args.swimSuitImagePath } : undefined,
          MenSwimwearImage: args.menSwimwearImagePath ? { filePath: args.menSwimwearImagePath } : undefined,
          MaskImage: args.maskImagePath ? { filePath: args.maskImagePath } : undefined,
          BackgroundSeason: args.backgroundSeason ? STUDIO_SEASON_INT[args.backgroundSeason] : undefined,
          FitType: args.fitType ? FIT_TYPE_INT[args.fitType] : undefined,
        });
        const op = await client.waitForCompletion(created.operationId);
        const out = formatOperation(op, `Studio (${args.mode})`);
        if (op.status === "Completed" && created.id) {
          out.content.push({
            type: "text" as const,
            text: `\nentityId for /poses: ${created.id}`,
          });
        }
        return out;
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerStudioPoses(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_studio_poses",
    "Generate 1-3 alternate-pose variants of a previously rendered Studio item. 10 credits per pose.",
    {
      parentEntityId: z
        .string()
        .describe("Studio entity id (the `entityId` returned by lunaar_studio_tryon, NOT the operationId)."),
      poseTypes: z.array(PoseType).min(1).max(3).describe("1-3 distinct poses."),
    },
    async (args) => {
      try {
        const created = await client.submitJson<CreateAcceptedDto[]>("/v1/ai/studio/poses", {
          parentEntityId: args.parentEntityId,
          poseTypes: args.poseTypes.map((p) => POSE_TYPE_INT[p]),
        });
        const ops = await Promise.all(
          created.map((c) => client.waitForCompletion(c.operationId))
        );
        const sections = ops.map((op, i) =>
          formatOperation(op, `Pose ${i + 1} (${args.poseTypes[i]})`)
        );
        const merged = sections.flatMap((s) => s.content);
        return { content: merged };
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerJewelryTryOn(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_jewelry_tryon",
    "Composite a jewelry product onto a model or display surface. Box (10 credits), ProductModel (10), CustomSurfaceBox (15), CustomModel (15).",
    {
      jewelryImagePath: z.string(),
      displayMode: JewelryDisplayMode,
      productType: JewelryProductType,
      gender: JewelryGender.optional().describe("Required for product_model_display + custom_model_display."),
      secondaryImagePath: z.string().optional().describe("Required for custom_surface_box_display + custom_model_display."),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>(
          "/v1/ai/jewelry-tryon",
          {
            JewelryImage: { filePath: args.jewelryImagePath },
            DisplayMode: JEWELRY_DISPLAY_INT[args.displayMode],
            ProductType: JEWELRY_PRODUCT_INT[args.productType],
            Gender: args.gender ? JEWELRY_GENDER_INT[args.gender] : undefined,
            SecondaryImage: args.secondaryImagePath ? { filePath: args.secondaryImagePath } : undefined,
          }
        );
        const op = await client.waitForCompletion(created.operationId);
        return formatOperation(op, `Jewelry (${args.displayMode}, ${args.productType})`);
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerGlassesTryOn(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_glasses_tryon",
    "Place a pair of glasses on a model's face with anatomy-aware fit. 10 credits per call.",
    {
      personImagePath: z.string(),
      glassesImagePath: z.string(),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>(
          "/v1/ai/glasses-tryon",
          {
            PersonImage: { filePath: args.personImagePath },
            GlassesImage: { filePath: args.glassesImagePath },
          }
        );
        const op = await client.waitForCompletion(created.operationId);
        return formatOperation(op, "Glasses try-on");
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerBodyEstimation(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_body_estimation",
    "Extract anatomical measurements (chest, waist, hip) from a single full-body photo. 10 credits per call.",
    {
      imagePath: z.string().describe("Full-body photo, subject fully visible, plain background."),
      heightCm: z.number().int().min(100).max(250).describe("Subject height in centimetres."),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>(
          "/v1/ai/body-estimation",
          {
            Image: { filePath: args.imagePath },
            HeightCm: args.heightCm,
          }
        );
        const op = await client.waitForCompletion(created.operationId);
        return formatOperation(op, "Body estimation");
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerImageTo3D(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_image_to_3d",
    "Generate a GLB 3D model + spinning preview video from a single product photo. 20 credits per call. Latency 2-4 minutes — may exceed default polling window; if so, use lunaar_get_operation later.",
    {
      imagePath: z.string(),
      targetHeightCm: z.number().optional().describe("Real-world height for scale calibration."),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<CreateAcceptedDto>("/v1/ai/image-3d", {
          Image: { filePath: args.imagePath },
          TargetHeightCm: args.targetHeightCm,
        });
        const op = await client.waitForCompletion(created.operationId, { timeoutMs: 240_000 });
        return formatOperation(op, "Image-to-3D");
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerModelToAr(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_model_to_ar",
    "Upload an existing GLB (and optional USDZ + thumbnail) and get a public AR-viewer URL. 5 credits per call. Returns inline (sync).",
    {
      title: z.string().min(1),
      glbFilePath: z.string(),
      usdzFilePath: z.string().optional(),
      thumbnailImagePath: z.string().optional(),
    },
    async (args) => {
      try {
        const created = await client.submitMultipart<{
          modelId: string;
          url: string;
          glbUrl: string;
          usdzUrl: string | null;
          thumbnailUrl: string | null;
        }>("/v1/ai/model-to-ar", {
          Title: args.title,
          GlbFile: { filePath: args.glbFilePath },
          UsdzFile: args.usdzFilePath ? { filePath: args.usdzFilePath } : undefined,
          ThumbnailImage: args.thumbnailImagePath ? { filePath: args.thumbnailImagePath } : undefined,
        });
        return asText(
          [
            `Model-to-AR → Completed.`,
            `modelId: ${created.modelId}`,
            `viewerUrl: ${created.url}`,
            `glbUrl: ${created.glbUrl}`,
            created.usdzUrl ? `usdzUrl: ${created.usdzUrl}` : "",
            created.thumbnailUrl ? `thumbnailUrl: ${created.thumbnailUrl}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerUpscale(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_upscale",
    "Re-render a previously completed AI operation at higher resolution. 5 credits per call.",
    {
      operationId: z.string().describe("OperationId of any completed /v1/ai/* run."),
    },
    async (args) => {
      try {
        const result = await client.submitEmpty<{ upscaledImageUrl: string; status: string }>(
          `/v1/ai/upscale/${encodeURIComponent(args.operationId)}`
        );
        if (result.upscaledImageUrl && result.upscaledImageUrl.length > 0) {
          return asText(
            `Upscale → Completed (sync).\nupscaledImageUrl: ${result.upscaledImageUrl}`
          );
        }
        // Async path — fall back to polling the parent operation; the upscaled URL is
        // written to the same Operation as `upscaledImageUrl`.
        const op = await client.waitForCompletion(args.operationId, { timeoutMs: 90_000 });
        if (op.upscaledImageUrl) {
          return asText(`Upscale → Completed.\nupscaledImageUrl: ${op.upscaledImageUrl}`);
        }
        return asText(
          `Upscale queued; still ${op.status}. Call lunaar_get_operation with this id later.`
        );
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerGetOperation(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_get_operation",
    "Inspect any operation by id. Use this when an earlier tool returned a non-terminal status, or to poll a long-running Image-to-3D run.",
    {
      operationId: z.string(),
    },
    async (args) => {
      try {
        const op = await client.getOperation(args.operationId);
        return formatOperation(op, `Operation ${args.operationId}`);
      } catch (err) {
        return asError(err);
      }
    }
  );
}

function registerListOperations(server: McpServer, client: LunaarClient) {
  server.tool(
    "lunaar_list_operations",
    "List recent operations for the current API key. Useful for picking up an operationId you forgot or auditing recent calls.",
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
      type: z
        .enum([
          "SketchToImg",
          "AiClothing",
          "JewelryTryOn",
          "GlassesTryOn",
          "BodyEstimation",
          "ImageTo3D",
          "ModelToAr",
        ])
        .optional(),
      status: z.enum(["Pending", "Processing", "Completed", "Failed", "Cancelled"]).optional(),
    },
    async (args) => {
      try {
        const page = await client.listOperations({
          page: args.page,
          pageSize: args.pageSize,
          type: args.type,
          status: args.status,
        });
        const counts = page.statusCounts;
        const lines = [
          `Status counts: total=${counts.total}, completed=${counts.completed}, processing=${counts.processing}, failed=${counts.failed}`,
          "",
          ...page.items.map(
            (o) =>
              `• ${o.operationId} | ${o.type} | ${o.status} | credits=${o.creditsUsed ?? 0}` +
              (o.creditsRefunded ? ` (refunded ${o.creditsRefunded})` : "")
          ),
        ];
        return asText(lines.join("\n"));
      } catch (err) {
        return asError(err);
      }
    }
  );
}
