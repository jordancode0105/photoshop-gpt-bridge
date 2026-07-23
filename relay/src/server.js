"use strict";
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");

const app = express();
const port = Number(process.env.PORT || 3000);
const gptApiKey = process.env.GPT_ACTION_API_KEY || "";
const pluginDeviceToken = process.env.PHOTOSHOP_DEVICE_TOKEN || "";
const jobTtlMinutes = Number(process.env.JOB_TTL_MINUTES || 60);
const ANY_EXECUTOR = "any";
const POWERSHELL_EXECUTOR = "powershell-v1";
const POWERSHELL_CAPABILITY_HEADER = "x-photoshop-bridge-agent";

if (!gptApiKey || !pluginDeviceToken) {
  console.error(
    "Missing GPT_ACTION_API_KEY or PHOTOSHOP_DEVICE_TOKEN. Copy .env.example and configure both secrets."
  );
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  })
);

const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireGptAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(token, gptApiKey)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function requirePluginAuth(req, res, next) {
  const token = req.get("x-device-token") || "";
  if (!safeEqual(token, pluginDeviceToken)) {
    return res.status(401).json({ error: "Unauthorized device" });
  }
  next();
}

function createJob(type, payload, requiresConfirmation, executor = ANY_EXECUTOR) {
  const job = {
    id: crypto.randomUUID(),
    type,
    payload,
    requiresConfirmation,
    executor,
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    claimedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

const matchCardJobTypes = new Set([
  "listMatchCardAssets",
  "planMatchCard",
  "createMatchCard",
  "updateMatchCard",
]);

function sanitizeMatchCardResult(value) {
  if (typeof value === "string") {
    return value
      .replace(/[A-Za-z]:[\\/][^\r\n]*/g, "[local path omitted]")
      .replace(/\\\\[^\\\r\n]+\\[^\r\n]*/g, "[local path omitted]");
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeMatchCardResult);
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (/(?:path|directory|folder|token|secret|api.?key|user.?profile)/i.test(key)) {
        continue;
      }
      sanitized[key] = sanitizeMatchCardResult(nestedValue);
    }
    return sanitized;
  }
  return value;
}

function publicJob(job) {
  const sanitizeResult = matchCardJobTypes.has(job.type);
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    requiresConfirmation: job.requiresConfirmation,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: sanitizeResult ? sanitizeMatchCardResult(job.result) : job.result,
    error: sanitizeResult ? sanitizeMatchCardResult(job.error) : job.error,
  };
}

const inspectSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
  })
  .strict();

const replaceSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    layerId: z.number().int().positive().optional(),
    layerName: z.string().min(1).max(255).optional(),
    replacementFileName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/]/.test(value), "File name must not contain a path"),
    fitMode: z.enum(["contain", "cover", "keep-transform"]).default("contain"),
    outputPsdName: z
      .string()
      .min(5)
      .max(255)
      .regex(/\.psd$/i)
      .refine((value) => !/[\\/]/.test(value), "File name must not contain a path"),
    outputPreviewName: z
      .string()
      .min(5)
      .max(255)
      .regex(/\.png$/i)
      .refine((value) => !/[\\/]/.test(value), "File name must not contain a path"),
  })
  .strict()
  .refine((value) => value.layerId || value.layerName, {
    message: "Provide either layerId or layerName",
  });

const rgbSchema = z
  .object({
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  })
  .strict();

const recolorEditSchema = z
  .object({
    layerId: z.number().int().positive(),
    color: rgbSchema,
    opacity: z.number().min(0).max(100).default(100),
    blendMode: z
      .enum(["normal", "color", "multiply", "overlay", "screen"])
      .default("normal"),
  })
  .strict();

const plainPsdNameSchema = z
  .string()
  .min(5)
  .max(255)
  .regex(/^[^\\/]+\.psd$/i, "Expected a plain .psd file name");

const plainPngNameSchema = z
  .string()
  .min(5)
  .max(255)
  .regex(/^[^\\/]+\.png$/i, "Expected a plain .png file name");

const recolorSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    edits: z.array(recolorEditSchema).min(1).max(25),
    outputPsdName: plainPsdNameSchema,
    outputPreviewName: plainPngNameSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set();
    value.edits.forEach((edit, index) => {
      if (seen.has(edit.layerId)) {
        context.addIssue({
          code: "custom",
          path: ["edits", index, "layerId"],
          message: `Duplicate layerId: ${edit.layerId}`,
        });
      }
      seen.add(edit.layerId);
    });
  });

function plainTextOutputNameSchema(extension) {
  const extensionPattern = new RegExp(`\\.${extension}$`, "i");
  return z
    .string()
    .min(extension.length + 2)
    .max(255)
    .refine((value) => extensionPattern.test(value), `Expected a plain .${extension} file name`)
    .refine(
      (value) => !/[\\/\0-\x1f<>:"|?*]/.test(value),
      "File name contains a path or an invalid character"
    )
    .refine((value) => !value.includes(".."), "File name must not contain path traversal")
    .refine((value) => !/^[A-Za-z]:/.test(value), "Drive-qualified file names are not allowed")
    .refine((value) => !value.startsWith("."), "File name must not be hidden or relative")
    .refine((value) => {
      const baseName = value.slice(0, -(extension.length + 1));
      return !/[. ]$/.test(baseName);
    }, "File name stem must not end in a dot or space")
    .refine((value) => {
      const baseName = value.slice(0, -(extension.length + 1));
      return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName);
    }, "Reserved device file names are not allowed");
}

function plainOutputStemSchema() {
  return z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) => !/[\\/\0-\x1f<>:"|?*]/.test(value),
      "File name stem contains a path or an invalid character"
    )
    .refine((value) => !value.includes(".."), "File name stem must not contain path traversal")
    .refine((value) => !/^[A-Za-z]:/.test(value), "Drive-qualified file names are not allowed")
    .refine((value) => !value.startsWith("."), "File name stem must not be hidden or relative")
    .refine((value) => !/[. ]$/.test(value), "File name stem must not end in a dot or space")
    .refine(
      (value) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value),
      "Reserved device file names are not allowed"
    );
}

function addDuplicateLayerIdIssues(edits, context, pathName) {
  const seen = new Set();
  edits.forEach((edit, index) => {
    const layerId = typeof edit === "number" ? edit : edit.layerId;
    if (seen.has(layerId)) {
      context.addIssue({
        code: "custom",
        path: [pathName, index, typeof edit === "number" ? undefined : "layerId"].filter(
          (part) => part !== undefined
        ),
        message: `Duplicate layerId: ${layerId}`,
      });
    }
    seen.add(layerId);
  });
}

const exportDocumentPreviewSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    outputPreviewName: plainTextOutputNameSchema("png"),
  })
  .strict();

const exportLayerPreviewsSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    layerIds: z.array(z.number().int().positive()).min(1).max(12),
    mode: z.enum(["isolated-transparent", "isolated-on-canvas", "contact-sheet"]),
    marginPx: z.number().int().min(0).max(400).default(40),
    baseOutputName: plainOutputStemSchema(),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateLayerIdIssues(value.layerIds, context, "layerIds");
  });

const renameLayerEditSchema = z
  .object({
    layerId: z.number().int().positive(),
    newName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.includes("\0"), "Layer name must not contain null bytes"),
  })
  .strict();

const renameLayersSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    edits: z.array(renameLayerEditSchema).min(1).max(50),
    outputPsdName: plainTextOutputNameSchema("psd"),
    outputPreviewName: plainTextOutputNameSchema("png"),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateLayerIdIssues(value.edits, context, "edits");
    if (
      value.documentName &&
      value.outputPsdName.toLowerCase() === value.documentName.toLowerCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputPsdName"],
        message: "Output PSD name must not match the original document",
      });
    }
  });

const updateTextEditSchema = z
  .object({
    layerId: z.number().int().positive(),
    text: z
      .string()
      .max(4_000)
      .refine((value) => !value.includes("\0"), "Text must not contain null bytes"),
  })
  .strict();

const updateTextSchema = z
  .object({
    documentName: z.string().min(1).max(255).optional(),
    edits: z.array(updateTextEditSchema).min(1).max(25),
    outputPsdName: plainTextOutputNameSchema("psd"),
    outputPreviewName: plainTextOutputNameSchema("png"),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set();
    let totalLength = 0;
    value.edits.forEach((edit, index) => {
      totalLength += edit.text.length;
      if (seen.has(edit.layerId)) {
        context.addIssue({
          code: "custom",
          path: ["edits", index, "layerId"],
          message: `Duplicate layerId: ${edit.layerId}`,
        });
      }
      seen.add(edit.layerId);
    });
    if (totalLength > 20_000) {
      context.addIssue({
        code: "custom",
        path: ["edits"],
        message: "Total replacement text must not exceed 20,000 characters",
      });
    }
    if (
      value.documentName &&
      value.outputPsdName.toLowerCase() === value.documentName.toLowerCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputPsdName"],
        message: "Output PSD name must not match the original document",
      });
    }
  });

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plainLocalFileNameSchema(extensions) {
  const normalizedExtensions = extensions
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
    .sort((left, right) => right.length - left.length);
  const extensionPattern = new RegExp(
    `(?:${normalizedExtensions.map(escapeRegex).join("|")})$`,
    "i"
  );

  return z
    .string()
    .min(3)
    .max(255)
    .refine(
      (value) => !/[\\/\0-\x1f<>:"|?*]/.test(value),
      "File name contains a path or an invalid character"
    )
    .refine((value) => !value.includes(".."), "File name must not contain path traversal")
    .refine((value) => !/^[A-Za-z]:/.test(value), "Drive-qualified file names are not allowed")
    .refine((value) => !value.startsWith("."), "File name must not be hidden or relative")
    .refine(
      (value) => !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value),
      "Remote URLs and data URIs are not allowed"
    )
    .refine((value) => extensionPattern.test(value), "Unsupported file extension")
    .refine((value) => {
      const lowerValue = value.toLowerCase();
      const extension = normalizedExtensions.find((candidate) =>
        lowerValue.endsWith(candidate.toLowerCase())
      );
      if (!extension) return false;
      const stem = value.slice(0, -extension.length);
      return stem.trim().length > 0 && !/[. ]$/.test(stem);
    }, "File name stem is invalid")
    .refine((value) => {
      const firstStemPart = value.split(".", 1)[0];
      return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(firstStemPart);
    }, "Reserved device file names are not allowed");
}

const supportedAssetNameSchema = plainLocalFileNameSchema([
  ".png",
  ".jpg",
  ".jpeg",
  ".psd",
  ".tif",
  ".tiff",
]);
const templateBackgroundNameSchema = plainLocalFileNameSchema([".png"]);
const matchCardPsdNameSchema = plainLocalFileNameSchema([".psd"]);
const matchCardPngNameSchema = plainLocalFileNameSchema([".png"]);
const matchCardManifestNameSchema = plainLocalFileNameSchema([".matchcard.json"]);

const matchCardCanvasSchema = z
  .object({
    width: z.number().int().min(320).max(8192),
    height: z.number().int().min(320).max(8192),
    resolution: z.number().int().min(36).max(600),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > 40_000_000) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Canvas must not exceed 40,000,000 pixels",
      });
    }
  });

const layoutPresetSchema = z.enum([
  "two-competitor-title-center",
  "two-competitor-title-lower",
  "three-competitor-title-center",
  "single-competitor-title-side",
  "eccw-two-competitor-panel-template",
]);
const ECCW_PANEL_LAYOUT_PRESET = "eccw-two-competitor-panel-template";
const ECCW_PANEL_TEMPLATE_FILE_NAME =
  "ECCW_JordanSinner_vs_EddieSlayer_template_bg_v1.png";

const protectedAssetRoles = [
  "competitorLeft",
  "competitorRight",
  "competitorCenter",
  "showLogo",
  "promotionLogo",
  "championshipLogo",
  "beltImage",
  "sponsorLogo",
  "venueLogo",
  "suppliedCharacterArtwork",
  "suppliedPhotograph",
];

const createMatchCardAssetsSchema = z
  .object({
    competitorLeft: supportedAssetNameSchema.optional(),
    competitorRight: supportedAssetNameSchema.optional(),
    competitorCenter: supportedAssetNameSchema.optional(),
    showLogo: supportedAssetNameSchema,
    promotionLogo: supportedAssetNameSchema.optional(),
    championshipLogo: supportedAssetNameSchema.optional(),
    beltImage: supportedAssetNameSchema.optional(),
    sponsorLogo: supportedAssetNameSchema.optional(),
    venueLogo: supportedAssetNameSchema.optional(),
    suppliedCharacterArtwork: supportedAssetNameSchema.optional(),
    suppliedPhotograph: supportedAssetNameSchema.optional(),
  })
  .strict();

const updateMatchCardAssetsSchema = z
  .object({
    competitorLeft: supportedAssetNameSchema.optional(),
    competitorRight: supportedAssetNameSchema.optional(),
    competitorCenter: supportedAssetNameSchema.optional(),
    showLogo: supportedAssetNameSchema.optional(),
    promotionLogo: supportedAssetNameSchema.optional(),
    championshipLogo: supportedAssetNameSchema.optional(),
    beltImage: supportedAssetNameSchema.optional(),
    sponsorLogo: supportedAssetNameSchema.optional(),
    venueLogo: supportedAssetNameSchema.optional(),
    suppliedCharacterArtwork: supportedAssetNameSchema.optional(),
    suppliedPhotograph: supportedAssetNameSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one asset change");

const matchCardTextValueSchema = z
  .string()
  .max(1000)
  .refine((value) => !value.includes("\0"), "Text must not contain null bytes");

const matchCardTextSchema = z
  .object({
    championship: matchCardTextValueSchema.optional(),
    competitorLeftName: matchCardTextValueSchema.optional(),
    competitorRightName: matchCardTextValueSchema.optional(),
    competitorCenterName: matchCardTextValueSchema.optional(),
    matchTitle: matchCardTextValueSchema.optional(),
    stipulation: matchCardTextValueSchema.optional(),
    date: matchCardTextValueSchema.optional(),
    time: matchCardTextValueSchema.optional(),
    venue: matchCardTextValueSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "Provide at least one text field" });
    }
    const totalLength = Object.values(value).reduce((total, text) => total + text.length, 0);
    if (totalLength > 5000) {
      context.addIssue({
        code: "custom",
        message: "Total match-card text must not exceed 5,000 characters",
      });
    }
  });

const matchCardStyleDescriptionSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.includes("\0"), "Style description must not contain null bytes");

const requestedFontNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => !/[\0-\x1f\x7f]/.test(value),
    "Requested font names must not contain control characters"
  );

const requestedFontsSchema = z
  .object({
    mainTitle: requestedFontNameSchema.optional(),
    championshipLabel: requestedFontNameSchema.optional(),
    competitorNames: requestedFontNameSchema.optional(),
    stipulation: requestedFontNameSchema.optional(),
    date: requestedFontNameSchema.optional(),
    time: requestedFontNameSchema.optional(),
    venue: requestedFontNameSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one requested font");

const createMatchCardStyleSchema = z
  .object({
    description: matchCardStyleDescriptionSchema,
    primaryColor: rgbSchema,
    secondaryColor: rgbSchema,
    accentColor: rgbSchema,
    metallicColor: rgbSchema,
    layoutPreset: layoutPresetSchema,
    fonts: requestedFontsSchema.optional(),
  })
  .strict();

const updateMatchCardStyleSchema = z
  .object({
    primaryColor: rgbSchema.optional(),
    secondaryColor: rgbSchema.optional(),
    accentColor: rgbSchema.optional(),
    metallicColor: rgbSchema.optional(),
    fonts: requestedFontsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one style change");

const templateBackgroundSchema = z
  .object({
    fileName: templateBackgroundNameSchema,
    fitMode: z.enum(["contain", "cover"]).default("cover"),
  })
  .strict();

const assetPlacementShape = {
  coordinateSpace: z.enum(["normalized", "pixels"]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  fitMode: z.enum(["contain", "cover", "keep-transform"]).optional(),
  scale: z.number().min(0.05).max(10).optional(),
  maxWidth: z.number().positive().optional(),
  maxHeight: z.number().positive().optional(),
  clippingMask: z.boolean().optional(),
  nonGenerativeMask: z.boolean().optional(),
  dropShadow: z.boolean().optional(),
  outerGlow: z.boolean().optional(),
};

function makeAssetPlacementSchema(allowInheritedCoordinateSpace) {
  return z.object(assetPlacementShape).strict().superRefine((value, context) => {
    if ((value.x === undefined) !== (value.y === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.x === undefined ? "x" : "y"],
        message: "x and y must be provided together",
      });
      return;
    }

    const candidateSpaces = value.coordinateSpace
      ? [value.coordinateSpace]
      : allowInheritedCoordinateSpace
        ? ["normalized", "pixels"]
        : ["normalized"];
    const fitsSpace = (space) => {
      if (value.x !== undefined) {
        if (space === "normalized" && (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1)) return false;
        if (
          space === "pixels" &&
          (!Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < -16_384 || value.x > 16_384 || value.y < -16_384 || value.y > 16_384)
        ) return false;
      }
      for (const dimension of [value.maxWidth, value.maxHeight]) {
        if (dimension === undefined) continue;
        if (space === "normalized" && dimension > 1) return false;
        if (space === "pixels" && (!Number.isInteger(dimension) || dimension > 16_384)) return false;
      }
      return true;
    };
    if (!candidateSpaces.some(fitsSpace)) {
      context.addIssue({
        code: "custom",
        path: ["coordinateSpace"],
        message: allowInheritedCoordinateSpace && !value.coordinateSpace
          ? "Placement values must form one valid normalized or pixel-space patch"
          : "Placement values are invalid for the selected coordinate space",
      });
    }
  });
}

const assetPlacementSchema = makeAssetPlacementSchema(false);
const updateAssetPlacementSchema = makeAssetPlacementSchema(true);

function makeAssetPlacementsSchema(placementSchema) {
  return z.object({
    competitorLeft: placementSchema.optional(),
    competitorRight: placementSchema.optional(),
    competitorCenter: placementSchema.optional(),
    showLogo: placementSchema.optional(),
    promotionLogo: placementSchema.optional(),
    championshipLogo: placementSchema.optional(),
    beltImage: placementSchema.optional(),
    sponsorLogo: placementSchema.optional(),
    venueLogo: placementSchema.optional(),
    suppliedCharacterArtwork: placementSchema.optional(),
    suppliedPhotograph: placementSchema.optional(),
  }).strict().refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one placement override"
  );
}

const assetPlacementsSchema = makeAssetPlacementsSchema(assetPlacementSchema);
const updateAssetPlacementsSchema = makeAssetPlacementsSchema(updateAssetPlacementSchema);

const semanticVisibilityRoles = [
  "templateBackground",
  "atmosphere",
  "framesAndPanels",
  "competitorRenders",
  "championshipAndBelt",
  "matchTitleGroup",
  "eventInformation",
  "showLogoGroup",
  "finishingEffects",
  ...protectedAssetRoles,
  "championship",
  "competitorLeftName",
  "competitorRightName",
  "competitorCenterName",
  "matchTitle",
  "stipulation",
  "date",
  "time",
  "venue",
];

const visibilityChangesSchema = z
  .array(
    z
      .object({
        role: z.enum(semanticVisibilityRoles),
        visible: z.boolean(),
      })
      .strict()
  )
  .min(1)
  .max(40)
  .superRefine((changes, context) => {
    const seen = new Set();
    changes.forEach((change, index) => {
      if (seen.has(change.role)) {
        context.addIssue({
          code: "custom",
          path: [index, "role"],
          message: `Duplicate visibility role: ${change.role}`,
        });
      }
      seen.add(change.role);
    });
  });

const createMatchCardSchema = z
  .object({
    briefName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !value.includes("\0"), "Brief name must not contain null bytes"),
    canvas: matchCardCanvasSchema,
    templateBackground: templateBackgroundSchema,
    style: createMatchCardStyleSchema,
    assets: createMatchCardAssetsSchema,
    text: matchCardTextSchema,
    placements: assetPlacementsSchema.optional(),
    outputPsdName: matchCardPsdNameSchema,
    outputPreviewName: matchCardPngNameSchema,
    outputManifestName: matchCardManifestNameSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const competitorRequirements = {
      "two-competitor-title-center": ["competitorLeft", "competitorRight"],
      "two-competitor-title-lower": ["competitorLeft", "competitorRight"],
      [ECCW_PANEL_LAYOUT_PRESET]: ["competitorLeft", "competitorRight"],
      "three-competitor-title-center": [
        "competitorLeft",
        "competitorRight",
        "competitorCenter",
      ],
      "single-competitor-title-side": ["competitorCenter"],
    };
    for (const role of competitorRequirements[value.style.layoutPreset]) {
      if (!value.assets[role]) {
        context.addIssue({
          code: "custom",
          path: ["assets", role],
          message: `${role} is required for ${value.style.layoutPreset}`,
        });
      }
    }

    if (value.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
      if (value.canvas.width !== 1920 || value.canvas.height !== 1080) {
        context.addIssue({
          code: "custom",
          path: ["canvas"],
          message: "The ECCW panel template preset requires an exact 1920x1080 canvas",
        });
      }
      if (
        value.templateBackground.fileName.toLowerCase() !==
        ECCW_PANEL_TEMPLATE_FILE_NAME.toLowerCase()
      ) {
        context.addIssue({
          code: "custom",
          path: ["templateBackground", "fileName"],
          message: "The ECCW panel template preset requires its dedicated template background",
        });
      }
      const allowedAssets = new Set(["competitorLeft", "competitorRight", "showLogo"]);
      for (const role of Object.keys(value.assets)) {
        if (!allowedAssets.has(role)) {
          context.addIssue({
            code: "custom",
            path: ["assets", role],
            message: `The ECCW panel template preset does not support ${role}`,
          });
        }
      }
      const requiredText = [
        "competitorLeftName",
        "competitorRightName",
        "matchTitle",
        "date",
      ];
      for (const role of requiredText) {
        if (value.text[role] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["text", role],
            message: `${role} is required for ${ECCW_PANEL_LAYOUT_PRESET}`,
          });
        }
      }
      for (const role of Object.keys(value.text)) {
        if (!requiredText.includes(role)) {
          context.addIssue({
            code: "custom",
            path: ["text", role],
            message: `The ECCW panel template preset does not support ${role}`,
          });
        }
      }
      if (value.text.matchTitle?.trim().toUpperCase() !== "VS") {
        context.addIssue({
          code: "custom",
          path: ["text", "matchTitle"],
          message: 'The ECCW panel template preset requires matchTitle to be "VS"',
        });
      }
    }

    if (value.placements) {
      for (const role of Object.keys(value.placements)) {
        if (!value.assets[role]) {
          context.addIssue({
            code: "custom",
            path: ["placements", role],
            message: `Placement role ${role} must reference a supplied asset`,
          });
        }
      }
    }

    const sourceNames = [value.templateBackground.fileName, ...Object.values(value.assets)].map(
      (fileName) => fileName.toLowerCase()
    );
    for (const [outputField, outputName] of [
      ["outputPsdName", value.outputPsdName],
      ["outputPreviewName", value.outputPreviewName],
    ]) {
      if (sourceNames.includes(outputName.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: [outputField],
          message: "Output file name must not overwrite an input asset",
        });
      }
    }
  });

const updateMatchCardChangesSchema = z
  .object({
    templateBackground: templateBackgroundSchema.optional(),
    style: updateMatchCardStyleSchema.optional(),
    assets: updateMatchCardAssetsSchema.optional(),
    text: matchCardTextSchema.optional(),
    placements: updateAssetPlacementsSchema.optional(),
    visibility: visibilityChangesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one match-card change");

const updateMatchCardSchema = z
  .object({
    manifestFileName: matchCardManifestNameSchema,
    changes: updateMatchCardChangesSchema,
    outputPsdName: matchCardPsdNameSchema,
    outputPreviewName: matchCardPngNameSchema,
    outputManifestName: matchCardManifestNameSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputManifestName.toLowerCase() === value.manifestFileName.toLowerCase()) {
      context.addIssue({
        code: "custom",
        path: ["outputManifestName"],
        message: "Output manifest must be a new version",
      });
    }

    const sourceNames = [
      value.changes.templateBackground?.fileName,
      ...Object.values(value.changes.assets || {}),
    ]
      .filter(Boolean)
      .map((fileName) => fileName.toLowerCase());
    for (const [outputField, outputName] of [
      ["outputPsdName", value.outputPsdName],
      ["outputPreviewName", value.outputPreviewName],
    ]) {
      if (sourceNames.includes(outputName.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: [outputField],
          message: "Output file name must not overwrite an input asset",
        });
      }
    }
  });

const listMatchCardAssetsSchema = z.object({}).strict();

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "photoshop-gpt-bridge", time: nowIso() });
});

app.post("/api/jobs/inspect-document", requireGptAuth, (req, res) => {
  const parsed = inspectSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const job = createJob("inspectDocument", parsed.data, false);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Inspection queued. Poll the job-status endpoint.",
  });
});

app.post("/api/jobs/replace-smart-object", requireGptAuth, (req, res) => {
  const parsed = replaceSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const job = createJob("replaceSmartObject", parsed.data, true);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message:
      "Write operation queued. The user must approve it in the Photoshop Bridge panel, then poll job status.",
  });
});

app.post("/api/jobs/recolor-layers", requireGptAuth, (req, res) => {
  const parsed = recolorSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("recolorLayers", parsed.data, true);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message:
      "Recolor operation queued. The user must approve it in the local Photoshop agent, then poll job status.",
  });
});

app.post("/api/jobs/update-text-layers", requireGptAuth, (req, res) => {
  const parsed = updateTextSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("updateTextLayers", parsed.data, true);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message:
      "Text update queued. Stop and wait for the user to approve it in the local Photoshop agent.",
  });
});

app.post("/api/jobs/export-document-preview", requireGptAuth, (req, res) => {
  const parsed = exportDocumentPreviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("exportDocumentPreview", parsed.data, false);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Read-only document preview queued. Poll the job-status endpoint.",
  });
});

app.post("/api/jobs/export-layer-previews", requireGptAuth, (req, res) => {
  const parsed = exportLayerPreviewsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("exportLayerPreviews", parsed.data, false);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Read-only layer preview export queued. Poll the job-status endpoint.",
  });
});

app.post("/api/jobs/rename-layers", requireGptAuth, (req, res) => {
  const parsed = renameLayersSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("renameLayers", parsed.data, true);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Layer rename queued. Stop and wait for local approval before polling status.",
  });
});

app.post("/api/jobs/list-match-card-assets", requireGptAuth, (req, res) => {
  const parsed = listMatchCardAssetsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("listMatchCardAssets", parsed.data, false, POWERSHELL_EXECUTOR);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Read-only match-card asset inventory queued. Poll the job-status endpoint.",
  });
});

app.post("/api/jobs/plan-match-card", requireGptAuth, (req, res) => {
  const parsed = createMatchCardSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("planMatchCard", parsed.data, false, POWERSHELL_EXECUTOR);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message: "Read-only match-card plan queued. Poll the job-status endpoint.",
  });
});

app.post("/api/jobs/create-match-card", requireGptAuth, (req, res) => {
  const parsed = createMatchCardSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("createMatchCard", parsed.data, true, POWERSHELL_EXECUTOR);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message:
      "Match-card creation queued. Stop and wait for the user to type YES in the local agent.",
  });
});

app.post("/api/jobs/update-match-card", requireGptAuth, (req, res) => {
  const parsed = updateMatchCardSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const job = createJob("updateMatchCard", parsed.data, true, POWERSHELL_EXECUTOR);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    message:
      "Match-card update queued. Stop and wait for the user to type YES in the local agent.",
  });
});

app.get("/api/jobs/:jobId", requireGptAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  res.json(publicJob(job));
});

/*
 * Plugin-only endpoints are intentionally excluded from the GPT Action schema.
 */

app.post("/api/plugin/jobs/claim-next", requirePluginAuth, (req, res) => {
  const isPowerShellAgent =
    (req.get(POWERSHELL_CAPABILITY_HEADER) || "") === POWERSHELL_EXECUTOR;
  const next = [...jobs.values()]
    .filter(
      (job) =>
        job.status === "pending" &&
        ((job.executor || ANY_EXECUTOR) === ANY_EXECUTOR ||
          (isPowerShellAgent && job.executor === POWERSHELL_EXECUTOR))
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

  if (!next) {
    return res.status(204).end();
  }

  next.status = "claimed";
  next.claimedAt = nowIso();
  next.updatedAt = nowIso();

  res.json({
    id: next.id,
    type: next.type,
    payload: next.payload,
    requiresConfirmation: next.requiresConfirmation,
    executor: next.executor || ANY_EXECUTOR,
    createdAt: next.createdAt,
  });
});

const inventorySuggestedRoleSchema = z
  .enum([...protectedAssetRoles, "baleCcPackage", "templateBackground"])
  .nullable();

const matchCardInventoryAssetSchema = z
  .object({
    fileName: supportedAssetNameSchema,
    extension: z.enum([".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"]),
    fileSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    width: z.number().nonnegative().nullable(),
    height: z.number().nonnegative().nullable(),
    isPsd: z.boolean(),
    isPngOrJpeg: z.boolean(),
    suggestedRole: inventorySuggestedRoleSchema,
    matchesConfiguredBaleCcPackage: z.boolean(),
    appearsSuitableAsTemplateBackground: z.boolean(),
  })
  .strict();

const matchCardInventoryResultSchema = z
  .object({
    assets: z.array(matchCardInventoryAssetSchema),
    baleCcConfigured: z.boolean(),
    baleCcPackageFileName: matchCardPsdNameSchema.nullable(),
    supportedExtensions: z.tuple([
      z.literal(".png"),
      z.literal(".jpg"),
      z.literal(".jpeg"),
      z.literal(".psd"),
      z.literal(".tif"),
      z.literal(".tiff"),
    ]),
    recursive: z.literal(false),
  })
  .strict();

const completionSchema = z
  .object({
    result: z.unknown(),
  })
  .strict();

function sanitizeValidationLogText(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:authorization|x-device-token|device[_-]?token|api[_-]?key|secret)\s*[:=]\s*[^,\s;}]+/gi, "[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\r\n,}]*/g, "[local path omitted]")
    .replace(/\\\\[^\\\r\n]+\\[^\r\n,}]*/g, "[local path omitted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function formatValidationIssuePath(basePath, issue) {
  const segments = [...(issue.path || [])];
  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && issue.keys.length) {
    segments.push(issue.keys[0]);
  }

  let formatted = basePath;
  for (const segment of segments) {
    if (Number.isInteger(segment) && segment >= 0) {
      formatted += `[${segment}]`;
      continue;
    }
    const field = String(segment);
    formatted += /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field) ? `.${field}` : ".[field]";
  }
  return formatted;
}

function logCompletionValidationFailure(job, validationError, basePath) {
  const issue = validationError.issues[0];
  const path = issue ? formatValidationIssuePath(basePath, issue) : basePath;
  const rawMessage = issue?.code === "unrecognized_keys" ? "Unrecognized field" : issue?.message;
  const message = sanitizeValidationLogText(rawMessage || "Validation failed") || "Validation failed";
  console.warn(
    `[completion-validation] jobId=${job.id} jobType=${job.type} path=${path} message=${message}`
  );
}

function validateJobFinalizationAccess(req, res, job) {
  if (
    job.executor === POWERSHELL_EXECUTOR &&
    (req.get(POWERSHELL_CAPABILITY_HEADER) || "") !== POWERSHELL_EXECUTOR
  ) {
    res.status(403).json({ error: "PowerShell agent capability required" });
    return false;
  }
  if (job.status !== "claimed") {
    res.status(409).json({ error: "Job must be claimed before it can be finalized" });
    return false;
  }
  return true;
}

app.post("/api/plugin/jobs/:jobId/complete", requirePluginAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  if (!validateJobFinalizationAccess(req, res, job)) return;

  const parsed = completionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    logCompletionValidationFailure(job, parsed.error, "completion");
    return res.status(400).json({ error: "Invalid completion payload" });
  }

  let completionResult = parsed.data.result;
  if (job.type === "listMatchCardAssets") {
    const inventoryResult = matchCardInventoryResultSchema.safeParse(completionResult);
    if (!inventoryResult.success) {
      logCompletionValidationFailure(job, inventoryResult.error, "result");
      return res.status(400).json({
        error: "Invalid asset inventory result",
        details: inventoryResult.error.flatten(),
      });
    }
    completionResult = inventoryResult.data;
  }

  job.status = "succeeded";
  job.result = completionResult;
  job.error = null;
  job.updatedAt = nowIso();
  res.json({ ok: true });
});

const failureSchema = z
  .object({
    error: z.string().min(1).max(4000),
  })
  .strict();

app.post("/api/plugin/jobs/:jobId/fail", requirePluginAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  if (!validateJobFinalizationAccess(req, res, job)) return;

  const parsed = failureSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid failure payload" });
  }

  job.status = "failed";
  job.result = null;
  job.error = parsed.data.error;
  job.updatedAt = nowIso();
  res.json({ ok: true });
});

setInterval(() => {
  const cutoff = Date.now() - jobTtlMinutes * 60_000;
  for (const [id, job] of jobs.entries()) {
    if (Date.parse(job.updatedAt) < cutoff) {
      jobs.delete(id);
    }
  }
}, 60_000).unref();

app.listen(port, () => {
  console.log(`Photoshop GPT bridge relay listening on port ${port}`);
});
