"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");

const port = 32_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const gptToken = "test-gpt-token-at-least-24-characters";
let server;
let serverOutput = "";

before(async () => {
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      GPT_ACTION_API_KEY: gptToken,
      PHOTOSHOP_DEVICE_TOKEN: "test-device-token-at-least-24-characters",
      JOB_TTL_MINUTES: "60",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Relay exited during test startup.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (_error) {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for relay startup.\n${serverOutput}`);
});

after(() => {
  if (server && server.exitCode === null) server.kill();
});

async function request(path, { authenticated = true, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (authenticated) headers.authorization = `Bearer ${gptToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const responseBody = await response.json();
  return { response, body: responseBody };
}

function validRecolor(overrides = {}) {
  return {
    documentName: "MatchCard.psd",
    edits: [
      {
        layerId: 123,
        color: { red: 190, green: 20, blue: 25 },
        opacity: 100,
        blendMode: "color",
      },
    ],
    outputPsdName: "MatchCard_Recolor_v1.psd",
    outputPreviewName: "MatchCard_Recolor_v1.png",
    ...overrides,
  };
}

function validTextUpdate(overrides = {}) {
  return {
    documentName: "MatchCard.psd",
    edits: [{ layerId: 321, text: "NEW TEXT" }],
    outputPsdName: "MatchCard_Text_v1.psd",
    outputPreviewName: "MatchCard_Text_v1.png",
    ...overrides,
  };
}

function validDocumentPreview(overrides = {}) {
  return {
    documentName: "MatchCard.psd",
    outputPreviewName: "MatchCard_preview_v1.png",
    ...overrides,
  };
}

function validLayerPreviews(overrides = {}) {
  return {
    documentName: "MatchCard.psd",
    layerIds: [31, 53, 90],
    mode: "isolated-on-canvas",
    marginPx: 40,
    baseOutputName: "candidate_layers_v1",
    ...overrides,
  };
}

function validRename(overrides = {}) {
  return {
    documentName: "MatchCard.psd",
    edits: [{ layerId: 100, newName: "SHOW LOGO - SMART OBJECT" }],
    outputPsdName: "MatchCard_Renamed_v1.psd",
    outputPreviewName: "MatchCard_Renamed_v1.png",
    ...overrides,
  };
}

async function getJob(jobId) {
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
    headers: { authorization: `Bearer ${gptToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("creates a confirmed recolorLayers job", async () => {
  const created = await request("/api/jobs/recolor-layers", { body: validRecolor() });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  assert.ok(created.body.jobId);

  const status = await fetch(`${baseUrl}/api/jobs/${created.body.jobId}`, {
    headers: { authorization: `Bearer ${gptToken}` },
  });
  assert.equal(status.status, 200);
  const job = await status.json();
  assert.equal(job.type, "recolorLayers");
  assert.equal(job.requiresConfirmation, true);
});

test("rejects recolor creation without GPT authentication", async () => {
  const result = await request("/api/jobs/recolor-layers", {
    authenticated: false,
    body: validRecolor(),
  });
  assert.equal(result.response.status, 401);
});

const invalidCases = [
  ["invalid layer ID", { edits: [{ layerId: 0, color: { red: 1, green: 2, blue: 3 } }] }],
  ["duplicate layer IDs", { edits: [
    { layerId: 7, color: { red: 1, green: 2, blue: 3 } },
    { layerId: 7, color: { red: 4, green: 5, blue: 6 } },
  ] }],
  ["invalid RGB value", { edits: [{ layerId: 7, color: { red: 256, green: 2, blue: 3 } }] }],
  ["invalid opacity", { edits: [{ layerId: 7, color: { red: 1, green: 2, blue: 3 }, opacity: 101 }] }],
  ["unsupported blend mode", { edits: [{ layerId: 7, color: { red: 1, green: 2, blue: 3 }, blendMode: "difference" }] }],
  ["more than 25 edits", { edits: Array.from({ length: 26 }, (_value, index) => ({
    layerId: index + 1,
    color: { red: 1, green: 2, blue: 3 },
  })) }],
  ["PSD path traversal", { outputPsdName: "../escaped.psd" }],
  ["PNG path traversal", { outputPreviewName: "folder\\escaped.png" }],
  ["unknown input", { unexpected: true }],
];

for (const [name, override] of invalidCases) {
  test(`rejects ${name}`, async () => {
    const result = await request("/api/jobs/recolor-layers", {
      body: validRecolor(override),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("creates a confirmed updateTextLayers job", async () => {
  const created = await request("/api/jobs/update-text-layers", {
    body: validTextUpdate(),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  assert.ok(created.body.jobId);

  const status = await fetch(`${baseUrl}/api/jobs/${created.body.jobId}`, {
    headers: { authorization: `Bearer ${gptToken}` },
  });
  assert.equal(status.status, 200);
  const job = await status.json();
  assert.equal(job.type, "updateTextLayers");
  assert.equal(job.requiresConfirmation, true);
});

test("rejects text update without GPT authentication", async () => {
  const result = await request("/api/jobs/update-text-layers", {
    authenticated: false,
    body: validTextUpdate(),
  });
  assert.equal(result.response.status, 401);
});

const invalidTextCases = [
  ["empty edits", { edits: [] }],
  ["more than 25 edits", { edits: Array.from({ length: 26 }, (_value, index) => ({
    layerId: index + 1,
    text: "text",
  })) }],
  ["invalid layer ID", { edits: [{ layerId: -1, text: "text" }] }],
  ["duplicate layer IDs", { edits: [
    { layerId: 9, text: "first" },
    { layerId: 9, text: "second" },
  ] }],
  ["missing text", { edits: [{ layerId: 9 }] }],
  ["text over 4,000 characters", { edits: [{ layerId: 9, text: "x".repeat(4_001) }] }],
  ["total text over 20,000 characters", { edits: Array.from({ length: 6 }, (_value, index) => ({
    layerId: index + 1,
    text: "x".repeat(3_500),
  })) }],
  ["null byte", { edits: [{ layerId: 9, text: "before\0after" }] }],
  ["PSD path traversal", { outputPsdName: "../escaped.psd" }],
  ["PNG path traversal", { outputPreviewName: "folder\\escaped.png" }],
  ["drive-qualified output", { outputPsdName: "C:escaped.psd" }],
  ["output matching the original", { outputPsdName: "MatchCard.psd" }],
  ["unknown request property", { unexpected: true }],
  ["unknown edit property", { edits: [{ layerId: 9, text: "text", font: "Arial" }] }],
];

for (const [name, override] of invalidTextCases) {
  test(`rejects text update with ${name}`, async () => {
    const result = await request("/api/jobs/update-text-layers", {
      body: validTextUpdate(override),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("accepts intentionally empty replacement text", async () => {
  const result = await request("/api/jobs/update-text-layers", {
    body: validTextUpdate({ edits: [{ layerId: 321, text: "" }] }),
  });
  assert.equal(result.response.status, 202);
  assert.ok(result.body.jobId);
});

test("accepts spaces, Unicode, tabs, and line breaks in replacement text", async () => {
  const result = await request("/api/jobs/update-text-layers", {
    body: validTextUpdate({
      edits: [{ layerId: 321, text: "  Café 世界\tline one\r\nline two  " }],
    }),
  });
  assert.equal(result.response.status, 202);
  assert.ok(result.body.jobId);
});

test("creates a read-only exportDocumentPreview job", async () => {
  const created = await request("/api/jobs/export-document-preview", {
    body: validDocumentPreview(),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "exportDocumentPreview");
  assert.equal(job.requiresConfirmation, false);
});

test("rejects document preview creation without GPT authentication", async () => {
  const result = await request("/api/jobs/export-document-preview", {
    authenticated: false,
    body: validDocumentPreview(),
  });
  assert.equal(result.response.status, 401);
});

for (const [name, override] of [
  ["invalid output name", { outputPreviewName: "preview.jpg" }],
  ["output path traversal", { outputPreviewName: "../preview.png" }],
  ["unknown property", { unexpected: true }],
]) {
  test(`rejects document preview with ${name}`, async () => {
    const result = await request("/api/jobs/export-document-preview", {
      body: validDocumentPreview(override),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("creates a read-only exportLayerPreviews job", async () => {
  const created = await request("/api/jobs/export-layer-previews", {
    body: validLayerPreviews(),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "exportLayerPreviews");
  assert.equal(job.requiresConfirmation, false);
});

for (const [name, override] of [
  ["too many layer IDs", { layerIds: Array.from({ length: 13 }, (_value, index) => index + 1) }],
  ["duplicate layer IDs", { layerIds: [31, 31] }],
  ["invalid layer ID", { layerIds: [0] }],
  ["invalid mode", { mode: "whole-document" }],
  ["invalid negative margin", { marginPx: -1 }],
  ["invalid excessive margin", { marginPx: 401 }],
  ["non-integer margin", { marginPx: 1.5 }],
  ["path traversal in baseOutputName", { baseOutputName: "../candidate" }],
  ["directory in baseOutputName", { baseOutputName: "folder\\candidate" }],
  ["unknown property", { unexpected: true }],
]) {
  test(`rejects layer previews with ${name}`, async () => {
    const result = await request("/api/jobs/export-layer-previews", {
      body: validLayerPreviews(override),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("creates a confirmed renameLayers job", async () => {
  const created = await request("/api/jobs/rename-layers", {
    body: validRename(),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "renameLayers");
  assert.equal(job.requiresConfirmation, true);
});

test("rejects rename creation without GPT authentication", async () => {
  const result = await request("/api/jobs/rename-layers", {
    authenticated: false,
    body: validRename(),
  });
  assert.equal(result.response.status, 401);
});

for (const [name, override] of [
  ["empty edits", { edits: [] }],
  ["more than 50 edits", { edits: Array.from({ length: 51 }, (_value, index) => ({
    layerId: index + 1,
    newName: `Layer ${index + 1}`,
  })) }],
  ["duplicate layer IDs", { edits: [
    { layerId: 7, newName: "First" },
    { layerId: 7, newName: "Second" },
  ] }],
  ["invalid layer ID", { edits: [{ layerId: -1, newName: "Invalid" }] }],
  ["missing newName", { edits: [{ layerId: 7 }] }],
  ["empty newName", { edits: [{ layerId: 7, newName: "" }] }],
  ["newName over 255 characters", { edits: [{ layerId: 7, newName: "x".repeat(256) }] }],
  ["null byte in newName", { edits: [{ layerId: 7, newName: "before\0after" }] }],
  ["PSD path traversal", { outputPsdName: "../renamed.psd" }],
  ["PNG directory path", { outputPreviewName: "folder\\renamed.png" }],
  ["output matching original", { outputPsdName: "MatchCard.psd" }],
  ["unknown property", { unexpected: true }],
  ["unknown edit property", { edits: [{ layerId: 7, newName: "Name", opacity: 50 }] }],
]) {
  test(`rejects rename layers with ${name}`, async () => {
    const result = await request("/api/jobs/rename-layers", {
      body: validRename(override),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("rename layer names preserve Unicode and surrounding whitespace", async () => {
  const result = await request("/api/jobs/rename-layers", {
    body: validRename({ edits: [{ layerId: 100, newName: "  CAFÉ 世界  " }] }),
  });
  assert.equal(result.response.status, 202);
  assert.ok(result.body.jobId);
});

test("existing inspect endpoint still creates a read-only job", async () => {
  const result = await request("/api/jobs/inspect-document", {
    body: { documentName: "MatchCard.psd" },
  });
  assert.equal(result.response.status, 202);
  assert.ok(result.body.jobId);
});

test("existing Smart Object replacement endpoint still creates a job", async () => {
  const result = await request("/api/jobs/replace-smart-object", {
    body: {
      documentName: "MatchCard.psd",
      layerId: 123,
      replacementFileName: "ECCW.png",
      fitMode: "contain",
      outputPsdName: "MatchCard_ECCW_v1.psd",
      outputPreviewName: "MatchCard_ECCW_v1.png",
    },
  });
  assert.equal(result.response.status, 202);
  assert.ok(result.body.jobId);
});
