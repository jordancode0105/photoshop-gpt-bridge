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
