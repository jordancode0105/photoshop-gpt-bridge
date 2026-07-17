"use strict";

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

function createJob(type, payload, requiresConfirmation) {
  const job = {
    id: crypto.randomUUID(),
    type,
    payload,
    requiresConfirmation,
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

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    requiresConfirmation: job.requiresConfirmation,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  };
}

const inspectSchema = z.object({
  documentName: z.string().min(1).max(255).optional(),
});

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
  .refine((value) => value.layerId || value.layerName, {
    message: "Provide either layerId or layerName",
  });

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

app.post("/api/plugin/jobs/claim-next", requirePluginAuth, (_req, res) => {
  const next = [...jobs.values()]
    .filter((job) => job.status === "pending")
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
    createdAt: next.createdAt,
  });
});

const completionSchema = z.object({
  result: z.unknown(),
});

app.post("/api/plugin/jobs/:jobId/complete", requirePluginAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  const parsed = completionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid completion payload" });
  }

  job.status = "succeeded";
  job.result = parsed.data.result;
  job.error = null;
  job.updatedAt = nowIso();
  res.json({ ok: true });
});

const failureSchema = z.object({
  error: z.string().min(1).max(4000),
});

app.post("/api/plugin/jobs/:jobId/fail", requirePluginAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

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
