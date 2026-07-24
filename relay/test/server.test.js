"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const port = 32_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const gptToken = "test-gpt-token-at-least-24-characters";
const deviceToken = "test-device-token-at-least-24-characters";
let server;
let serverOutput = "";

before(async () => {
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      GPT_ACTION_API_KEY: gptToken,
      PHOTOSHOP_DEVICE_TOKEN: deviceToken,
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
  const headers = {
    "content-type": "application/json",
    "x-forwarded-for": path.includes("match-card") ? "198.51.100.10" : "198.51.100.20",
  };
  if (authenticated) headers.authorization = `Bearer ${gptToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const responseBody = await response.json();
  return { response, body: responseBody };
}

async function pluginRequest({ authenticated = true, capability, body = {} } = {}) {
  const headers = { "content-type": "application/json" };
  if (authenticated) headers["x-device-token"] = deviceToken;
  if (capability) headers["x-photoshop-bridge-agent"] = capability;
  const response = await fetch(`${baseUrl}/api/plugin/jobs/claim-next`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  return {
    response,
    body: responseText ? JSON.parse(responseText) : null,
  };
}

async function finalizePluginJob(jobId, action, body, { capability = "powershell-v1" } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-device-token": deviceToken,
  };
  if (capability !== null) headers["x-photoshop-bridge-agent"] = capability;
  const response = await fetch(`${baseUrl}/api/plugin/jobs/${jobId}/${action}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function completePluginJob(jobId, result, options) {
  return finalizePluginJob(jobId, "complete", { result }, options);
}

async function failPluginJob(jobId, error, options) {
  return finalizePluginJob(jobId, "fail", { error }, options);
}

async function waitForServerLog(startIndex, expectedText) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const output = serverOutput.slice(startIndex);
    if (output.includes(expectedText)) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for relay log containing ${expectedText}`);
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

function validCanvas(overrides = {}) {
  return { width: 1920, height: 1080, resolution: 72, ...overrides };
}

function validTemplateBackground(overrides = {}) {
  return {
    fileName: "ECCW_Breakker_vs_Rage_template_bg_v1.png",
    fitMode: "cover",
    ...overrides,
  };
}

function validStyle(overrides = {}) {
  return {
    description: "premium red black white wrestling broadcast presentation",
    primaryColor: { red: 190, green: 0, blue: 28 },
    secondaryColor: { red: 8, green: 8, blue: 10 },
    accentColor: { red: 245, green: 245, blue: 242 },
    metallicColor: { red: 142, green: 148, blue: 154 },
    layoutPreset: "two-competitor-title-center",
    fonts: {
      mainTitle: "Arial Bold",
      competitorNames: "Arial",
    },
    ...overrides,
  };
}

function validAssets(overrides = {}) {
  return {
    showLogo: "ECCW.png",
    competitorLeft: "Breakker.png",
    competitorRight: "Rage.png",
    beltImage: "IC_Title.png",
    venueLogo: "MGM.png",
    ...overrides,
  };
}

function validMatchCardText(overrides = {}) {
  return {
    championship: "INTERCONTINENTAL CHAMPIONSHIP",
    competitorLeftName: "BREAKKER",
    competitorRightName: "RAGE",
    matchTitle: "BREAKKER\nRAGE",
    stipulation: "FIRST TO FIVE",
    date: "SUNDAY · JULY 20",
    time: "2 PM EST | 1 PM CST | 7 PM GMT",
    venue: "LIVE! FROM THE MGM GRAND ARENA IN LAS VEGAS",
    ...overrides,
  };
}

function validCreateMatchCard(overrides = {}) {
  return {
    briefName: "ECCW Breakker vs Rage",
    canvas: validCanvas(),
    templateBackground: validTemplateBackground(),
    style: validStyle(),
    assets: validAssets(),
    text: validMatchCardText(),
    placements: {
      competitorLeft: {
        coordinateSpace: "normalized",
        x: 0.25,
        y: 0.55,
        fitMode: "contain",
        scale: 1,
        maxWidth: 0.45,
        maxHeight: 0.9,
        dropShadow: true,
      },
      competitorRight: {
        coordinateSpace: "pixels",
        x: 1440,
        y: 594,
        fitMode: "contain",
        maxWidth: 860,
        maxHeight: 972,
        outerGlow: true,
      },
    },
    outputPsdName: "ECCW_Breakker_vs_Rage_v1.psd",
    outputPreviewName: "ECCW_Breakker_vs_Rage_v1.png",
    outputManifestName: "ECCW_Breakker_vs_Rage_v1.matchcard.json",
    ...overrides,
  };
}

function validEccwPanelCreate(overrides = {}) {
  return validCreateMatchCard({
    briefName: "ECCW Jordan Sinner vs Eddie Slayer",
    canvas: validCanvas(),
    templateBackground: validTemplateBackground({
      fileName: "ECCW_JordanSinner_vs_EddieSlayer_template_bg_v1.png",
    }),
    style: validStyle({
      layoutPreset: "eccw-two-competitor-panel-template",
    }),
    assets: {
      competitorLeft: "JordanSinner.png",
      competitorRight: "EddieSlayer.png",
      showLogo: "ECCW.png",
    },
    text: {
      competitorLeftName: "JORDAN SINNER",
      competitorRightName: "EDDIE SLAYER",
      matchTitle: "VS",
      date: "JULY 23RD",
    },
    placements: {
      competitorLeft: {
        coordinateSpace: "pixels",
        x: 451,
        y: 489,
        fitMode: "contain",
        maxWidth: 700,
        maxHeight: 760,
        clippingMask: true,
      },
    },
    outputPsdName: "ECCW_JordanSinner_vs_EddieSlayer_v5.psd",
    outputPreviewName: "ECCW_JordanSinner_vs_EddieSlayer_v5.png",
    outputManifestName: "ECCW_JordanSinner_vs_EddieSlayer_v5.matchcard.json",
    ...overrides,
  });
}

function validPremiumEccwCreate(overrides = {}) {
  return validEccwPanelCreate({
    style: validStyle({
      layoutPreset: "eccw-two-competitor-panel-premium",
    }),
    text: {
      competitorLeftName: "JORDAN SINNER",
      competitorRightName: "EDDIE SLAYER",
      matchTitle: "VS",
    },
    placements: undefined,
    artDirection: {
      competitorLeft: {
        scale: 1.02,
        xOffset: 0,
        depthShadow: { opacity: 38, blur: 18, distance: 8 },
        centerRim: { opacity: 30, blur: 5 },
        outerRim: { opacity: 14, blur: 3 },
      },
      competitorRight: {
        scale: 0.98,
        xOffset: 0,
      },
      panelMasks: { enabled: true, inset: 4 },
      composition: { targetHeightOccupancy: 0.92, centerGap: 33 },
      nameplates: {
        fill: { red: 198, green: 24, blue: 32 },
        opacity: 90,
        textureReveal: 14,
      },
      topPlate: {
        mode: "logo-only",
        logo: { fitMode: "largest-safe-fit", safePadding: 14 },
      },
      vs: {
        fill: { red: 198, green: 24, blue: 32 },
        opacity: 90,
        textureReveal: 14,
        stroke: false,
        centeringTolerance: 2,
      },
      lowerCenter: {
        enabled: true,
        text: "FIRST TO THREE",
        fontSize: 24,
        tracking: 180,
        fill: { red: 235, green: 235, blue: 235 },
        opacity: 90,
        microplate: true,
      },
      renderGrade: {
        blackDepth: 8,
        highlightRecovery: 6,
        contrast: 8,
        saturation: 0,
        redAmbient: 8,
        sharpening: 6,
      },
      globalFinish: {
        enabled: true,
        contrast: 8,
        redBlackSplitTone: 8,
        vignette: 10,
        grain: 4,
        centerGlow: 7,
      },
    },
    outputPsdName: "ECCW_JordanSinner_vs_EddieSlayer_premium_v15.psd",
    outputPreviewName: "ECCW_JordanSinner_vs_EddieSlayer_premium_v15.png",
    outputManifestName:
      "ECCW_JordanSinner_vs_EddieSlayer_premium_v15.matchcard.json",
    ...overrides,
  });
}

function validEccwArtDirection(overrides = {}) {
  return {
    competitorLeft: {
      scale: 1.55,
      xOffset: -24,
      yOffset: 12,
      cutoffY: 842,
      headTargetY: 142,
      shadowOpacity: 38,
      shadowDistance: 16,
      brightness: 8,
      contrast: 12,
    },
    competitorRight: {
      scale: 1.32,
      xOffset: 30,
      yOffset: -8,
      cutoffY: 858,
      headTargetY: 155,
      shadowOpacity: 32,
      shadowDistance: 12,
    },
    nameplates: {
      targetWidthOccupancy: 0.86,
      targetHeightOccupancy: 0.64,
      minimumHorizontalPadding: 30,
      maximumFontSize: 92,
      minimumFontSize: 42,
      tracking: 10,
    },
    topPlate: {
      logo: { visibleWidth: 260, xOffset: 0, yOffset: 0 },
      date: {
        fontSize: 66,
        xOffset: 0,
        yOffset: 0,
        fill: { red: 255, green: 255, blue: 255 },
        shadow: { enabled: true, opacity: 40, distance: 4, blur: 8 },
      },
      stipulation: {
        text: "FIRST TO THREE RULES",
        fontSize: 30,
        xOffset: 0,
        yOffset: 0,
        fill: { red: 230, green: 230, blue: 230 },
      },
    },
    vs: { fontSize: 78, xOffset: 0, yOffset: 6 },
    ...overrides,
  };
}

function validUpdateMatchCard(overrides = {}) {
  return {
    manifestFileName: "ECCW_Breakker_vs_Rage_v1.matchcard.json",
    changes: {
      assets: { competitorRight: "Rage_v2.png" },
      text: { competitorRightName: "RAGE II" },
      style: {
        primaryColor: { red: 170, green: 0, blue: 24 },
        fonts: { mainTitle: "Arial Bold" },
      },
      placements: {
        competitorRight: {
          coordinateSpace: "normalized",
          x: 0.76,
          y: 0.56,
          fitMode: "keep-transform",
          scale: 1.05,
        },
      },
      visibility: [
        { role: "beltImage", visible: true },
        { role: "finishingEffects", visible: true },
      ],
    },
    outputPsdName: "ECCW_Breakker_vs_Rage_v2.psd",
    outputPreviewName: "ECCW_Breakker_vs_Rage_v2.png",
    outputManifestName: "ECCW_Breakker_vs_Rage_v2.matchcard.json",
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

test("creates a PowerShell-only read-only asset inventory job", async () => {
  const created = await request("/api/jobs/list-match-card-assets", { body: {} });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "listMatchCardAssets");
  assert.equal(job.requiresConfirmation, false);
});

test("asset inventory requires GPT authentication and a closed empty body", async () => {
  const unauthenticated = await request("/api/jobs/list-match-card-assets", {
    authenticated: false,
    body: {},
  });
  assert.equal(unauthenticated.response.status, 401);

  const unknownProperty = await request("/api/jobs/list-match-card-assets", {
    body: { workingFolder: "C:\\Users\\example" },
  });
  assert.equal(unknownProperty.response.status, 400);
  assert.equal(unknownProperty.body.error, "Invalid request");
});

test("legacy claimants cannot claim PowerShell match-card jobs", async () => {
  const unauthenticatedPowerShellClaim = await pluginRequest({
    authenticated: false,
    capability: "powershell-v1",
  });
  assert.equal(unauthenticatedPowerShellClaim.response.status, 401);

  const legacyClaim = await pluginRequest();
  assert.equal(legacyClaim.response.status, 204);
  assert.equal(legacyClaim.body, null);

  const wrongCapability = await pluginRequest({ capability: "generic-v1" });
  assert.equal(wrongCapability.response.status, 204);

  const powershellClaim = await pluginRequest({ capability: "powershell-v1" });
  assert.equal(powershellClaim.response.status, 200);
  assert.equal(powershellClaim.body.type, "listMatchCardAssets");
  assert.equal(powershellClaim.body.executor, "powershell-v1");
  assert.equal(powershellClaim.body.requiresConfirmation, false);

  const completionWithoutCapability = await completePluginJob(
    powershellClaim.body.id,
    {},
    { capability: null }
  );
  assert.equal(completionWithoutCapability.response.status, 403);

  const completionWithWrongCapability = await completePluginJob(
    powershellClaim.body.id,
    {},
    { capability: "generic-v1" }
  );
  assert.equal(completionWithWrongCapability.response.status, 403);

  const logStart = serverOutput.length;
  const unsafeInventoryResult = await completePluginJob(powershellClaim.body.id, {
    assets: [],
    baleCcConfigured: true,
    baleCcPackageFileName: "BaleCC_Master.psd",
    supportedExtensions: [".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"],
    recursive: false,
    workingFolder: "C:\\Users\\person\\PhotoshopBridge",
  });
  assert.equal(unsafeInventoryResult.response.status, 400);
  assert.equal(unsafeInventoryResult.body.error, "Invalid asset inventory result");
  const validationLog = await waitForServerLog(logStart, `jobId=${powershellClaim.body.id}`);
  assert.match(validationLog, /jobType=listMatchCardAssets/);
  assert.match(validationLog, /path=result\.workingFolder/);
  assert.match(validationLog, /message=Unrecognized field/);
  assert.doesNotMatch(validationLog, /C:\\Users\\person\\PhotoshopBridge/);
  assert.doesNotMatch(validationLog, new RegExp(deviceToken));

  const completed = await completePluginJob(powershellClaim.body.id, {
    assets: [
      {
        fileName: "ECCW.png",
        extension: ".png",
        fileSizeBytes: 123456,
        width: 1920,
        height: 1080,
        isPsd: false,
        isPngOrJpeg: true,
        suggestedRole: "showLogo",
        matchesConfiguredBaleCcPackage: false,
        appearsSuitableAsTemplateBackground: false,
      },
      {
        fileName: "BaleCC_Master.psd",
        extension: ".psd",
        fileSizeBytes: 654321,
        width: null,
        height: null,
        isPsd: true,
        isPngOrJpeg: false,
        suggestedRole: "baleCcPackage",
        matchesConfiguredBaleCcPackage: true,
        appearsSuitableAsTemplateBackground: false,
      },
    ],
    baleCcConfigured: true,
    baleCcPackageFileName: "BaleCC_Master.psd",
    supportedExtensions: [".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"],
    recursive: false,
  });
  assert.equal(completed.response.status, 200);

  const repeatedCompletion = await completePluginJob(powershellClaim.body.id, {
    assets: [],
    baleCcConfigured: false,
    baleCcPackageFileName: null,
    supportedExtensions: [".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"],
    recursive: false,
  });
  assert.equal(repeatedCompletion.response.status, 409);

  const publicResult = await getJob(powershellClaim.body.id);
  assert.equal(publicResult.status, "succeeded");
  assert.equal(publicResult.result.assets[0].fileName, "ECCW.png");
  assert.equal(publicResult.result.assets[1].width, null);
  assert.equal(publicResult.result.assets[1].suggestedRole, "baleCcPackage");
  assert.equal(publicResult.result.baleCcPackageFileName, "BaleCC_Master.psd");
  assert.equal(publicResult.result.recursive, false);

  const queuedIds = new Map();
  for (const [path, body] of [
    ["/api/jobs/plan-match-card", validCreateMatchCard()],
    ["/api/jobs/create-match-card", validCreateMatchCard()],
    [
      "/api/jobs/update-match-card",
      validUpdateMatchCard({
        changes: { placements: { competitorRight: { x: 100, y: 200, scale: 1.05 } } },
      }),
    ],
  ]) {
    const queued = await request(path, { body });
    assert.equal(queued.response.status, 202);
    queuedIds.set(path, queued.body.jobId);
  }

  const pendingCompletion = await completePluginJob(
    queuedIds.get("/api/jobs/create-match-card"),
    { shouldNotComplete: true }
  );
  assert.equal(pendingCompletion.response.status, 409);

  const legacyStillCannotClaim = await pluginRequest();
  assert.equal(legacyStillCannotClaim.response.status, 204);

  const claimedTypes = new Map();
  const claimedJobs = new Map();
  for (let index = 0; index < 3; index += 1) {
    const claimed = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.body.executor, "powershell-v1");
    claimedTypes.set(claimed.body.type, claimed.body.requiresConfirmation);
    claimedJobs.set(claimed.body.type, claimed.body);
  }
  assert.deepEqual(
    claimedTypes,
    new Map([
      ["planMatchCard", false],
      ["createMatchCard", true],
      ["updateMatchCard", true],
    ])
  );
  assert.deepEqual(claimedJobs.get("updateMatchCard").payload.changes.placements, {
    competitorRight: { x: 100, y: 200, scale: 1.05 },
  });

  const planCompletion = await completePluginJob(claimedJobs.get("planMatchCard").id, {
    plannedLayers: ["00 - BALE CC", "10 - TEMPLATE BACKGROUND"],
    diagnostic: "Read C:\\Users\\person\\PhotoshopBridge\\template.png",
  });
  assert.equal(planCompletion.response.status, 200);
  const publicPlan = await getJob(claimedJobs.get("planMatchCard").id);
  assert.equal(JSON.stringify(publicPlan.result).includes("C:\\\\Users"), false);

  const createFailureWithoutCapability = await failPluginJob(
    claimedJobs.get("createMatchCard").id,
    "Failed",
    { capability: null }
  );
  assert.equal(createFailureWithoutCapability.response.status, 403);
  const createFailure = await failPluginJob(
    claimedJobs.get("createMatchCard").id,
    "Failed at C:\\Users\\person\\PhotoshopBridge\\output.psd"
  );
  assert.equal(createFailure.response.status, 200);
  const publicFailure = await getJob(claimedJobs.get("createMatchCard").id);
  assert.equal(publicFailure.status, "failed");
  assert.equal(publicFailure.error.includes("C:\\Users"), false);
});

test(
  "PowerShell inventory completion sends one schema-valid result object",
  { skip: process.platform === "win32" ? false : "requires Windows PowerShell" },
  async () => {
    const contractScript = path.resolve(
      process.cwd(),
      "..",
      "local-agent",
      "test-inventory-result-shape.ps1"
    );
    const completionBody = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          contractScript,
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      ).trim()
    );

    assert.deepEqual(Object.keys(completionBody), ["result"]);
    assert.equal(Array.isArray(completionBody.result), false);
    assert.equal(typeof completionBody.result, "object");
    assert.deepEqual(Object.keys(completionBody.result).sort(), [
      "assets",
      "baleCcConfigured",
      "baleCcPackageFileName",
      "recursive",
      "supportedExtensions",
    ]);
    assert.deepEqual(completionBody.result.supportedExtensions, [
      ".png",
      ".jpg",
      ".jpeg",
      ".psd",
      ".tif",
      ".tiff",
    ]);
    assert.equal(completionBody.result.recursive, false);

    const created = await request("/api/jobs/list-match-card-assets", { body: {} });
    assert.equal(created.response.status, 202);
    const claimed = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(claimed.response.status, 200);
    assert.equal(claimed.body.id, created.body.jobId);
    assert.equal(claimed.body.type, "listMatchCardAssets");

    const completed = await finalizePluginJob(claimed.body.id, "complete", completionBody);
    assert.equal(completed.response.status, 200);
    assert.deepEqual(completed.body, { ok: true });

    const publicResult = await getJob(claimed.body.id);
    assert.equal(publicResult.status, "succeeded");
    assert.deepEqual(publicResult.result, completionBody.result);
  }
);

test("Bale import activates its source document and restores its destination", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const helperStart = workerSource.indexOf("function duplicateBaleCcGroupFromSource(");
  const helperEnd = workerSource.indexOf(
    "\n    function placeImportedBaleGroupInsideWrapper(",
    helperStart
  );
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = workerSource.slice(helperStart, helperEnd);

  const sourceDocumentValidation = helperSource.indexOf(
    'baleDomTypename(sourceDocument) !== "Document"'
  );
  const sourceGroupValidation = helperSource.indexOf(
    'baleDomTypename(sourceGroup) !== "LayerSet"'
  );
  const destinationDocumentValidation = helperSource.indexOf(
    'baleDomTypename(destinationDocument) !== "Document"'
  );
  const differentDocumentValidation = helperSource.indexOf(
    "sourceDocument === destinationDocument"
  );
  const sourceActivation = helperSource.indexOf("app.activeDocument = sourceDocument;");
  const sourceVerification = helperSource.indexOf("app.activeDocument !== sourceDocument");
  const duplicateCall = helperSource.indexOf(
    "sourceGroup.duplicate(destinationDocument, ElementPlacement.PLACEATBEGINNING)"
  );
  const finallyBlock = helperSource.indexOf("finally");
  const destinationActivation = helperSource.indexOf(
    "app.activeDocument = destinationDocument;",
    finallyBlock
  );
  const destinationVerification = helperSource.indexOf(
    "app.activeDocument !== destinationDocument",
    destinationActivation
  );

  assert.ok(sourceDocumentValidation >= 0);
  assert.ok(sourceDocumentValidation < sourceGroupValidation);
  assert.ok(sourceGroupValidation < destinationDocumentValidation);
  assert.ok(destinationDocumentValidation < differentDocumentValidation);
  assert.ok(differentDocumentValidation < sourceActivation);
  assert.ok(sourceActivation >= 0);
  assert.ok(sourceActivation < sourceVerification);
  assert.ok(sourceVerification < duplicateCall);
  assert.ok(duplicateCall < finallyBlock);
  assert.ok(finallyBlock < destinationActivation);
  assert.ok(destinationActivation < destinationVerification);
  assert.equal(
    (
      workerSource.match(
        /duplicateBaleCcGroupFromSource\(packageDocument, matches\[0\], targetDocument\)/g
      ) || []
    ).length,
    2
  );
  assert.doesNotMatch(workerSource, /matches\[0\]\.duplicate\(/);
  assert.match(workerSource, /sourceTypename/);
  assert.match(workerSource, /destinationTypename/);
  assert.match(workerSource, /placement/);
  assert.match(workerSource, /activeDocument/);
  assert.equal(
    (
      workerSource.match(
        /if \(ownedDocument && packageDocument\) try \{ packageDocument\.close\(SaveOptions\.DONOTSAVECHANGES\); \}/g
      ) || []
    ).length,
    2
  );
});

test("Bale wrapper nesting uses an ArtLayer anchor instead of LayerSet PLACEINSIDE", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const helperStart = workerSource.indexOf(
    "function placeImportedBaleGroupInsideWrapper("
  );
  const helperEnd = workerSource.indexOf("\n    function importBaleCcGroup(", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = workerSource.slice(helperStart, helperEnd);

  const destinationActivation = helperSource.indexOf(
    "app.activeDocument = destinationDocument;"
  );
  const anchorCreation = helperSource.indexOf("anchor = wrapper.artLayers.add();");
  const anchorTypeCheck = helperSource.indexOf(
    'baleDomTypename(anchor) !== "ArtLayer"'
  );
  const relativeMove = helperSource.indexOf(
    "importedGroup.move(anchor, ElementPlacement.PLACEBEFORE);"
  );
  const anchorCleanup = helperSource.indexOf("anchor.remove();");
  const finallyBlock = helperSource.indexOf("finally");
  const destinationRestore = helperSource.indexOf(
    "app.activeDocument = destinationDocument;",
    finallyBlock
  );

  assert.ok(destinationActivation >= 0);
  assert.ok(destinationActivation < anchorCreation);
  assert.ok(anchorCreation < anchorTypeCheck);
  assert.ok(anchorTypeCheck < relativeMove);
  assert.ok(relativeMove < finallyBlock);
  assert.ok(finallyBlock < anchorCleanup);
  assert.ok(anchorCleanup < destinationRestore);
  assert.doesNotMatch(
    workerSource,
    /(?:imported|importedGroup)\.move\(wrapper,\s*ElementPlacement\.INSIDE\)/
  );
  assert.equal(
    (
      workerSource.match(
        /placeImportedBaleGroupInsideWrapper\(imported, wrapper, targetDocument\)/g
      ) || []
    ).length,
    2
  );
});

test("PowerShell claimant can still claim existing operation jobs", async () => {
  const created = await request("/api/jobs/inspect-document", {
    body: { documentName: "MatchCard.psd" },
  });
  assert.equal(created.response.status, 202);

  const claim = await pluginRequest({ capability: "powershell-v1" });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.id, created.body.jobId);
  assert.equal(claim.body.type, "inspectDocument");
  assert.equal(claim.body.executor, "any");
  assert.equal(claim.body.requiresConfirmation, false);

  const completed = await completePluginJob(claim.body.id, { inspected: true }, {
    capability: null,
  });
  assert.equal(completed.response.status, 200);
});

test("asset inventory accepts an omitted HTTP request body", async () => {
  const response = await fetch(baseUrl + "/api/jobs/list-match-card-assets", {
    method: "POST",
    headers: { authorization: "Bearer " + gptToken },
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.ok(body.jobId);
  assert.equal(body.status, "pending");
});

test("creates a read-only planMatchCard job from the create payload", async () => {
  const created = await request("/api/jobs/plan-match-card", {
    body: validCreateMatchCard(),
  });
  assert.equal(created.response.status, 202);
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "planMatchCard");
  assert.equal(job.requiresConfirmation, false);
});

test("planMatchCard requires authentication and uses strict create validation", async () => {
  const unauthenticated = await request("/api/jobs/plan-match-card", {
    authenticated: false,
    body: validCreateMatchCard(),
  });
  assert.equal(unauthenticated.response.status, 401);

  const invalid = await request("/api/jobs/plan-match-card", {
    body: validCreateMatchCard({ prompt: "generate a wrestler" }),
  });
  assert.equal(invalid.response.status, 400);
});

test("creates a confirmed createMatchCard job", async () => {
  const created = await request("/api/jobs/create-match-card", {
    body: validCreateMatchCard(),
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.status, "pending");
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "createMatchCard");
  assert.equal(job.requiresConfirmation, true);
});

test("creates the deterministic ECCW panel-template preset", async () => {
  const created = await request("/api/jobs/create-match-card", {
    body: validEccwPanelCreate(),
  });
  assert.equal(created.response.status, 202);
  let claimed = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(candidate.response.status, 200);
    if (candidate.body.id === created.body.jobId) {
      claimed = candidate;
      break;
    }
  }
  assert.ok(claimed);
  assert.equal(
    claimed.body.payload.style.layoutPreset,
    "eccw-two-competitor-panel-template"
  );
  assert.deepEqual(claimed.body.payload.canvas, {
    width: 1920,
    height: 1080,
    resolution: 72,
  });
  assert.equal(
    claimed.body.payload.templateBackground.fileName,
    "ECCW_JordanSinner_vs_EddieSlayer_template_bg_v1.png"
  );
  assert.deepEqual(Object.keys(claimed.body.payload.assets).sort(), [
    "competitorLeft",
    "competitorRight",
    "showLogo",
  ]);
  assert.equal(claimed.body.payload.artDirection, undefined);
});

test("ECCW art direction accepts independent bounded overrides", async () => {
  const artDirection = validEccwArtDirection();
  const created = await request("/api/jobs/create-match-card", {
    body: validEccwPanelCreate({ artDirection }),
  });
  assert.equal(created.response.status, 202);
  let claimed = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(candidate.response.status, 200);
    if (candidate.body.id === created.body.jobId) {
      claimed = candidate;
      break;
    }
  }
  assert.ok(claimed);
  assert.deepEqual(claimed.body.payload.artDirection, artDirection);
  assert.notEqual(
    claimed.body.payload.artDirection.competitorLeft.scale,
    claimed.body.payload.artDirection.competitorRight.scale
  );
  assert.equal(
    claimed.body.payload.artDirection.topPlate.stipulation.text,
    "FIRST TO THREE RULES"
  );
});

test("ECCW art direction validates ranges, preset scope, and top-plate spacing", async () => {
  const invalidCases = [
    validEccwPanelCreate({
      artDirection: { competitorLeft: { scale: 2.26 } },
    }),
    validEccwPanelCreate({
      artDirection: { competitorRight: { xOffset: 301 } },
    }),
    validEccwPanelCreate({
      artDirection: { competitorLeft: { cutoffY: 699 } },
    }),
    validEccwPanelCreate({
      artDirection: { competitorLeft: { brightness: 4.5 } },
    }),
    validEccwPanelCreate({
      artDirection: {
        nameplates: { minimumFontSize: 80, maximumFontSize: 60 },
      },
    }),
    validEccwPanelCreate({
      artDirection: { topPlate: { date: { yOffset: -40 } } },
    }),
    validEccwPanelCreate({
      artDirection: { competitorLeft: { unexpected: true } },
    }),
    validCreateMatchCard({
      artDirection: { competitorLeft: { scale: 1.2 } },
    }),
  ];
  for (const body of invalidCases) {
    const rejected = await request("/api/jobs/create-match-card", { body });
    assert.equal(rejected.response.status, 400);
  }
});

test("read-only ECCW planning preserves requested art direction for worker resolution", async () => {
  const artDirection = validEccwArtDirection({
    competitorLeft: { scale: 1.7, xOffset: -60 },
    competitorRight: { scale: 1.15, xOffset: 75 },
  });
  const created = await request("/api/jobs/plan-match-card", {
    body: validEccwPanelCreate({ artDirection }),
  });
  assert.equal(created.response.status, 202);
  let claimed = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(candidate.response.status, 200);
    if (candidate.body.id === created.body.jobId) {
      claimed = candidate;
      break;
    }
  }
  assert.ok(claimed);
  assert.equal(claimed.body.type, "planMatchCard");
  assert.deepEqual(claimed.body.payload.artDirection, artDirection);
  assert.equal(claimed.body.requiresConfirmation, false);
});

test("ECCW VS fill schema accepts the canonical RGB control and rejects malformed RGB", async () => {
  const canonicalFill = { red: 198, green: 24, blue: 32 };
  const created = await request("/api/jobs/plan-match-card", {
    body: validEccwPanelCreate({
      artDirection: {
        vs: {
          fontSize: 76,
          xOffset: 0,
          yOffset: 8,
          fill: canonicalFill,
        },
      },
    }),
  });
  assert.equal(created.response.status, 202);
  let claimed = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = await pluginRequest({ capability: "powershell-v1" });
    assert.equal(candidate.response.status, 200);
    if (candidate.body.id === created.body.jobId) {
      claimed = candidate;
      break;
    }
  }
  assert.ok(claimed);
  assert.deepEqual(claimed.body.payload.artDirection.vs, {
    fontSize: 76,
    xOffset: 0,
    yOffset: 8,
    fill: canonicalFill,
  });

  const malformed = await request("/api/jobs/create-match-card", {
    body: validEccwPanelCreate({
      artDirection: {
        vs: { fill: { red: 256, green: 24, blue: 32 } },
      },
    }),
  });
  assert.equal(malformed.response.status, 400);
});

test("ECCW panel-template preset rejects incompatible geometry and content", async () => {
  const cases = [
    validEccwPanelCreate({ canvas: validCanvas({ width: 1672, height: 941 }) }),
    validEccwPanelCreate({ templateBackground: validTemplateBackground() }),
    validEccwPanelCreate({
      assets: {
        competitorLeft: "JordanSinner.png",
        competitorRight: "EddieSlayer.png",
        showLogo: "ECCW.png",
        beltImage: "Title.png",
      },
    }),
    validEccwPanelCreate({
      text: {
        competitorLeftName: "JORDAN SINNER",
        competitorRightName: "EDDIE SLAYER",
        matchTitle: "FIGHT",
        date: "JULY 23RD",
      },
    }),
    validEccwPanelCreate({
      text: {
        competitorLeftName: "JORDAN SINNER",
        competitorRightName: "EDDIE SLAYER",
        matchTitle: "VS",
      },
    }),
  ];
  for (const body of cases) {
    const rejected = await request("/api/jobs/create-match-card", { body });
    assert.equal(rejected.response.status, 400);
  }
});

test("premium ECCW v15 is opt-in and accepts the complete bounded art-direction contract", async () => {
  const create = await request("/api/jobs/create-match-card", {
    body: validPremiumEccwCreate(),
  });
  assert.equal(create.response.status, 202);
  const createJob = await getJob(create.body.jobId);
  assert.equal(createJob.requiresConfirmation, true);
  assert.equal(createJob.type, "createMatchCard");

  const plan = await request("/api/jobs/plan-match-card", {
    body: validPremiumEccwCreate({
      outputPsdName: "premium_plan.psd",
      outputPreviewName: "premium_plan.png",
      outputManifestName: "premium_plan.matchcard.json",
    }),
  });
  assert.equal(plan.response.status, 202);
  const planJob = await getJob(plan.body.jobId);
  assert.equal(planJob.requiresConfirmation, false);
  assert.equal(planJob.type, "planMatchCard");
});

test("premium ECCW rejects legacy top text, unsafe composition, strokes, and non-canonical red", async () => {
  const cases = [
    validPremiumEccwCreate({
      text: {
        competitorLeftName: "JORDAN SINNER",
        competitorRightName: "EDDIE SLAYER",
        matchTitle: "VS",
        date: "JULY 23RD",
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        composition: { centerGap: 50 },
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        vs: { stroke: true },
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        nameplates: {
          fill: { red: 255, green: 255, blue: 255 },
        },
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        panelMasks: { enabled: false },
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        renderGrade: { sharpening: 21 },
      },
    }),
    validPremiumEccwCreate({
      artDirection: {
        nameplates: { minimumFontSize: 90, maximumFontSize: 60 },
      },
    }),
  ];
  for (const body of cases) {
    const rejected = await request("/api/jobs/create-match-card", { body });
    assert.equal(rejected.response.status, 400);
  }
});

test("premium controls do not alter legacy ECCW or non-ECCW request behavior", async () => {
  const legacy = await request("/api/jobs/create-match-card", {
    body: validEccwPanelCreate(),
  });
  assert.equal(legacy.response.status, 202);

  const genericWithPremium = await request("/api/jobs/create-match-card", {
    body: validCreateMatchCard({
      artDirection: { composition: { centerGap: 33 } },
    }),
  });
  assert.equal(genericWithPremium.response.status, 400);
});

test("premium ECCW source structure uses alpha geometry, polygon masks, editable groups, and deterministic diagnostics", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const geometryStart = workerSource.indexOf("function premiumPanelGeometry(");
  const geometryEnd = workerSource.indexOf(
    "\n    function premiumGeometryBounds(",
    geometryStart
  );
  const boundsStart = geometryEnd + 1;
  const boundsEnd = workerSource.indexOf(
    "\n    function resolvedPremiumEccwArtDirection(",
    boundsStart
  );
  assert.ok(geometryStart >= 0);
  assert.ok(geometryEnd > geometryStart);
  assert.ok(boundsEnd > boundsStart);
  const panelGeometry = Function(
    `"use strict"; return (${workerSource.slice(geometryStart, geometryEnd).trim()});`
  )();
  const geometryBounds = Function(
    `"use strict"; return (${workerSource.slice(boundsStart, boundsEnd).trim()});`
  )();
  const left = panelGeometry("competitorLeft", 4);
  const right = panelGeometry("competitorRight", 4);
  assert.equal(left.points.length, 7);
  assert.equal(right.points.length, 7);
  assert.equal(left.inset, 4);
  assert.equal(right.inset, 4);
  assert.equal(left.dividerEdge, 942);
  assert.equal(right.dividerEdge, 978);
  assert.equal(left.nameplateTop, 850);
  assert.equal(right.nameplateTop, 850);
  assert.ok(geometryBounds(left).bottom <= 846);
  assert.ok(geometryBounds(right).bottom <= 846);

  const logoFitStart = workerSource.indexOf(
    "function calculatePremiumLogoSafeFit("
  );
  const logoFitEnd = workerSource.indexOf(
    "\n    function readPremiumPlannerPngGeometry(",
    logoFitStart
  );
  const calculateLogoFit = Function(
    `"use strict"; return (${workerSource.slice(logoFitStart, logoFitEnd).trim()});`
  )();
  const safeLogo = calculateLogoFit(1500, 1024, 14, null);
  assert.equal(safeLogo.fitResolution, "largest-safe-fit");
  assert.equal(safeLogo.contained, true);
  assert.ok(safeLogo.visibleWidth <= 452);
  assert.ok(safeLogo.visibleHeight <= 242);
  const explicitLogo = calculateLogoFit(1500, 1024, 14, 260);
  assert.equal(explicitLogo.visibleWidth, 260);
  assert.equal(explicitLogo.fitResolution, "explicit-width");

  assert.match(
    workerSource,
    /var ECCW_PREMIUM_LAYOUT_PRESET = "eccw-two-competitor-panel-premium";/
  );
  assert.match(workerSource, /function resolvePremiumEccwAssetGeometry\(/);
  assert.match(workerSource, /sourceAlphaVisibleHeight/);
  assert.match(workerSource, /targetHeightOccupancy: 0\.92, centerGap: 33/);
  assert.match(workerSource, /preferredHeightOccupancy: preferredOccupancy/);
  assert.match(workerSource, /occupancyClamped:/);
  assert.match(workerSource, /requestedGap = Number\(composition\.centerGap\)/);
  assert.match(workerSource, /function addPolygonSelectionMask\(/);
  assert.match(workerSource, /document\.selection\.select\(selectionPoints\)/);
  assert.match(workerSource, /function applyMandatoryPremiumPanelMask\(/);
  assert.match(workerSource, /verifyPremiumPanelMask\(document, layer, role, geometry\)/);
  assert.match(workerSource, /PANEL MASK \(ON SMART OBJECT\)/);
  for (const groupName of [
    "DEPTH SHADOW",
    "SMART OBJECT",
    "GRADE",
    "CENTER RIM",
    "OUTER RIM",
    "ATMOSPHERE",
    "50 - GLOBAL FINISH",
    "80 - LOWER CENTER INFO",
  ]) {
    assert.match(workerSource, new RegExp(groupName.replace(/[()]/g, "\\$&")));
  }
  assert.match(workerSource, /function setPremiumCompetitorEffects\(/);
  assert.match(workerSource, /function createPremiumDirectionalRims\(/);
  assert.match(workerSource, /function createPremiumHueSaturationAdjustment\(/);
  assert.match(workerSource, /function createPremiumRedAmbientOverlay\(/);
  assert.match(workerSource, /function applyPremiumSmartSharpen\(/);
  assert.match(workerSource, /function createPremiumGlobalFinish\(/);
  assert.match(workerSource, /function createPremiumGrainSmartObject\(/);
  assert.match(workerSource, /newPlacedLayer/);
  assert.match(workerSource, /charIDToTypeID\("AdNs"\)/);
  assert.match(workerSource, /charIDToTypeID\("Mnch"\), true/);
  assert.match(workerSource, /function validatePremiumEccwPreviewLayout\(/);
  assert.match(workerSource, /function validatePremiumGroupStructure\(/);
  assert.match(workerSource, /premiumCompetitorLeftPanelMask/);
  assert.match(workerSource, /premiumCompetitorRightPanelMask/);
  assert.match(workerSource, /center-divider breathing-room mismatch/);
  assert.match(workerSource, /Premium showLogo safe-area validation failed/);
  assert.match(workerSource, /Premium VS must not have a white outline or any stroke/);
  assert.match(workerSource, /textureReveal: 14/);
  assert.match(workerSource, /text: "FIRST TO THREE"/);
  assert.match(workerSource, /role: "lowerCenterLabel"/);
  assert.match(workerSource, /function buildPremiumEccwArtDirectionRecord\(/);
  assert.match(workerSource, /competitorComposition: competitorComposition/);
  assert.match(workerSource, /panelMasks: panelMasks/);
  assert.match(workerSource, /renderEffects: renderEffects/);
  assert.match(workerSource, /sharedGrade: cloneJsonValue\(resolved\.renderGrade\)/);
  assert.match(workerSource, /premiumDiagnostics:/);
  assert.match(workerSource, /performsPhotoshopWrite: false/);
  assert.match(workerSource, /photoshopRuntimeMeasurementsPending: isPremium/);
  assert.match(
    workerSource,
    /40 - COMPETITORS\/LEFT COMPETITOR\/PANEL MASK \(ON SMART OBJECT\)/
  );

  const premiumCreateStart = workerSource.indexOf(
    "function resolvedPremiumEccwArtDirection("
  );
  const premiumCreateEnd = workerSource.indexOf(
    "\n    function buildEccwVsFillDiagnostics(",
    premiumCreateStart
  );
  const premiumResolverSource = workerSource.slice(
    premiumCreateStart,
    premiumCreateEnd
  );
  assert.doesNotMatch(premiumResolverSource, /dateDefaults|FIRST TO THREE RULES/);
  assert.match(premiumResolverSource, /mode: "logo-only"/);
  assert.match(premiumResolverSource, /stroke: false/);
});

test("premium read-only planning uses plain metadata descriptors and leaves Photoshop runtime work pending", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const planStart = workerSource.indexOf("function planMatchCard(");
  const planEnd = workerSource.indexOf(
    "\n    var MATCH_ASSET_LAYER_NAMES",
    planStart
  );
  const planSource = workerSource.slice(planStart, planEnd);
  assert.match(planSource, /preflightPremiumPlanMatchCard\(input, payload\)/);
  assert.match(planSource, /resolvePremiumEccwPlanningGeometry\(/);
  assert.match(planSource, /performsPhotoshopWrite: false/);
  assert.match(planSource, /runtimePendingMeasurements:/);
  assert.match(planSource, /intentionalOmissions:/);
  assert.doesNotMatch(planSource, /resolvePremiumEccwAssetGeometry\(/);
  assert.doesNotMatch(planSource, /assertEccwCompetitorVisible\(/);
  assert.doesNotMatch(planSource, /inspectEccwLogoSourceAlphaGeometry\(/);
  assert.doesNotMatch(planSource, /activeLayerTransparencyBounds\(/);
  assert.doesNotMatch(planSource, /smartObjectMore|smartObjectPlacementTransform/);
  assert.doesNotMatch(planSource, /executeAction|executeActionGet/);

  const metadataStart = workerSource.indexOf(
    "function readPremiumPlannerPngGeometry("
  );
  const metadataEnd = workerSource.indexOf(
    "\n    function premiumRuntimeSourceGeometry(",
    metadataStart
  );
  const metadataSource = workerSource.slice(metadataStart, metadataEnd);
  assert.match(metadataSource, /png-ihdr-document-bounds/);
  assert.match(metadataSource, /runtimeAlphaMeasurementPending: true/);
  assert.match(
    metadataSource,
    /Premium planner cannot resolve source alpha geometry for/
  );
  assert.doesNotMatch(metadataSource, /app\.|ArtLayer|Smart Object/);
  assert.doesNotMatch(
    metadataSource,
    /ActionDescriptor|ActionReference|executeAction|smartObjectMore/
  );
  const readPlanningGeometry = Function(
    "fileExtension",
    "safeBaleStageErrorMessage",
    `"use strict"; return (${metadataSource.trim()});`
  )(
    (name) => name.slice(name.lastIndexOf(".")).toLowerCase(),
    (error) => String(error?.message || error)
  );
  const pngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader, 0);
  pngHeader.write("IHDR", 12, "ascii");
  pngHeader.writeUInt32BE(1536, 16);
  pngHeader.writeUInt32BE(1024, 20);
  const mockPng = {
    exists: true,
    name: "JordanSinner.png",
    encoding: "",
    open: () => true,
    read: () => pngHeader.toString("latin1"),
    close: () => true,
  };
  const pngGeometry = readPlanningGeometry(mockPng, "competitorLeft");
  assert.equal(pngGeometry.sourceFullWidth, 1536);
  assert.equal(pngGeometry.sourceFullHeight, 1024);
  assert.equal(pngGeometry.alphaBoundsMeasured, false);
  assert.equal(pngGeometry.runtimeAlphaMeasurementPending, true);
  assert.throws(
    () =>
      readPlanningGeometry(
        {
          ...mockPng,
          read: () => Buffer.alloc(24).toString("latin1"),
        },
        "competitorLeft"
      ),
    /Premium planner cannot resolve source alpha geometry for competitorLeft/
  );

  const competitorStart = workerSource.indexOf(
    "function resolvePremiumCompetitorGeometryDescriptor("
  );
  const competitorEnd = workerSource.indexOf(
    "\n    function resolvePremiumLogoGeometryDescriptor(",
    competitorStart
  );
  const geometryBoundsStart = workerSource.indexOf(
    "function premiumGeometryBounds("
  );
  const geometryBoundsEnd = workerSource.indexOf(
    "\n    function resolvedPremiumEccwArtDirection(",
    geometryBoundsStart
  );
  const competitorResolver = Function(
    "premiumGeometryBounds",
    "cloneJsonValue",
    `"use strict"; return (${workerSource
      .slice(competitorStart, competitorEnd)
      .trim()});`
  )(
    Function(
      `"use strict"; return (${workerSource
        .slice(geometryBoundsStart, geometryBoundsEnd)
        .trim()});`
    )(),
    (value) => structuredClone(value)
  );
  const planningSource = {
    sourceFullWidth: 1536,
    sourceFullHeight: 1536,
    planningVisibleBounds: { left: 0, top: 0, right: 1536, bottom: 1536 },
    planningVisibleWidth: 1536,
    planningVisibleHeight: 1536,
    geometryBasis: "png-ihdr-document-bounds",
    alphaBoundsMeasured: false,
    runtimeAlphaMeasurementPending: true,
  };
  const composition = { targetHeightOccupancy: 0.92, centerGap: 33 };
  const leftDirection = {
    scale: 1.02,
    xOffset: 0,
    yOffset: 0,
    headTargetY: 170,
    panelGeometry: {
      dividerEdge: 942,
      nameplateTop: 850,
      points: [
        [139, 174],
        [882, 174],
        [928, 220],
        [928, 846],
        [170, 846],
        [170, 300],
        [139, 266],
      ],
    },
  };
  const rightDirection = {
    ...structuredClone(leftDirection),
    scale: 0.98,
    panelGeometry: {
      dividerEdge: 978,
      nameplateTop: 850,
      points: [
        [992, 220],
        [1038, 174],
        [1781, 174],
        [1781, 266],
        [1750, 300],
        [1750, 846],
        [992, 846],
      ],
    },
  };
  competitorResolver(
    "competitorLeft",
    leftDirection,
    composition,
    planningSource,
    false
  );
  competitorResolver(
    "competitorRight",
    rightDirection,
    composition,
    planningSource,
    false
  );
  for (const direction of [leftDirection, rightDirection]) {
    assert.equal(
      direction.resolvedPlacement.sourceGeometry.geometryBasis,
      "png-ihdr-document-bounds"
    );
    assert.equal(
      direction.resolvedPlacement.runtimePlacementMeasurementPending,
      true
    );
    assert.equal(
      direction.resolvedPlacement.runtimePanelMaskVerificationPending,
      true
    );
    assert.ok(direction.resolvedPlacement.plannedAlphaVisibleBounds);
    assert.equal(direction.resolvedPlacement.visibleBounds, undefined);
    assert.ok(
      direction.resolvedPlacement.resolvedHeightOccupancy >= 0.9 &&
        direction.resolvedPlacement.resolvedHeightOccupancy <= 0.94
    );
    assert.ok(
      direction.resolvedPlacement.resolvedCenterGap >= 28 &&
      direction.resolvedPlacement.resolvedCenterGap <= 38
    );
  }
  const runtimeDirection = structuredClone(leftDirection);
  delete runtimeDirection.resolvedPlacement;
  competitorResolver(
    "competitorLeft",
    runtimeDirection,
    composition,
    {
      ...planningSource,
      geometryBasis: "photoshop-source-alpha-measurement",
      alphaBoundsMeasured: true,
      runtimeAlphaMeasurementPending: false,
    },
    true
  );
  assert.ok(runtimeDirection.resolvedPlacement.visibleBounds);
  assert.ok(runtimeDirection.resolvedPlacement.sourceAlphaBounds);
  assert.ok(runtimeDirection.resolvedPlacement.appliedScaleFactor > 0);
  assert.equal(
    runtimeDirection.resolvedPlacement.runtimePlacementMeasurementPending,
    false
  );

  const logoFitStart = workerSource.indexOf(
    "function calculatePremiumLogoSafeFit("
  );
  const logoFitEnd = workerSource.indexOf(
    "\n    function readPremiumPlannerPngGeometry(",
    logoFitStart
  );
  const calculateLogoFit = Function(
    `"use strict"; return (${workerSource
      .slice(logoFitStart, logoFitEnd)
      .trim()});`
  )();
  const logoStart = workerSource.indexOf(
    "function resolvePremiumLogoGeometryDescriptor("
  );
  const logoEnd = workerSource.indexOf(
    "\n    function resolvePremiumEccwGeometryDescriptors(",
    logoStart
  );
  const resolveLogo = Function(
    "calculatePremiumLogoSafeFit",
    "cloneJsonValue",
    `"use strict"; return (${workerSource.slice(logoStart, logoEnd).trim()});`
  )(calculateLogoFit, (value) => structuredClone(value));
  const logo = {
    fitMode: "largest-safe-fit",
    visibleWidth: null,
    safePadding: 14,
    xOffset: 0,
    yOffset: 0,
  };
  resolveLogo(logo, pngGeometry, false);
  assert.equal(logo.runtimeAlphaMeasurementPending, true);
  assert.equal(logo.runtimePlacementVerificationPending, true);
  assert.equal(logo.sourceGeometry.geometryBasis, "png-ihdr-document-bounds");
  assert.ok(logo.plannedVisibleBounds);
  assert.equal(logo.resolvedVisibleBounds, undefined);
  assert.ok(logo.visibleWidth <= 452);
  assert.ok(logo.visibleHeight <= 242);
  const runtimeLogo = {
    fitMode: "largest-safe-fit",
    visibleWidth: null,
    safePadding: 14,
    xOffset: 0,
    yOffset: 0,
  };
  resolveLogo(runtimeLogo, planningSource, true);
  assert.ok(runtimeLogo.resolvedVisibleBounds);
  assert.equal(runtimeLogo.runtimeAlphaMeasurementPending, false);
});

test("ECCW worker preset preserves the template and validates deterministic placement", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const proceduralStart = workerSource.indexOf("function createProceduralMatchLayers(");
  const proceduralEnd = workerSource.indexOf(
    "\n    function placeFileAsSmartObject(",
    proceduralStart
  );
  const proceduralSource = workerSource.slice(proceduralStart, proceduralEnd);
  const presetGuard = proceduralSource.indexOf(
    "style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET"
  );
  const earlyReturn = proceduralSource.indexOf("return;", presetGuard);
  const firstRectangle = proceduralSource.indexOf("createRectangleFill(");
  const placementStart = workerSource.indexOf("function deterministicEccwPlacement(");
  const placementEnd = workerSource.indexOf(
    "\n    function applyDeterministicEccwPlacements(",
    placementStart
  );
  const placementSource = workerSource.slice(placementStart, placementEnd);
  const transparencyStart = workerSource.indexOf(
    "function inspectCompetitorTransparencyBeforePlacement("
  );
  const transparencyEnd = workerSource.indexOf(
    "\n    function deterministicEccwPlacement(",
    transparencyStart
  );
  const transparencySource = workerSource.slice(transparencyStart, transparencyEnd);
  const plannedGroupsStart = workerSource.indexOf("function plannedMatchCardGroups(");
  const plannedGroupsEnd = workerSource.indexOf(
    "\n    function plannedTextMappings(",
    plannedGroupsStart
  );
  const plannedGroupsSource = workerSource.slice(plannedGroupsStart, plannedGroupsEnd);
  const planStart = workerSource.indexOf("function planMatchCard(");
  const planEnd = workerSource.indexOf(
    "\n    var MATCH_ASSET_LAYER_NAMES",
    planStart
  );
  const planSource = workerSource.slice(planStart, planEnd);

  assert.ok(proceduralStart >= 0);
  assert.ok(proceduralEnd > proceduralStart);
  assert.ok(placementStart >= 0);
  assert.ok(placementEnd > placementStart);
  assert.ok(transparencyStart >= 0);
  assert.ok(transparencyEnd > transparencyStart);
  assert.ok(plannedGroupsStart >= 0);
  assert.ok(plannedGroupsEnd > plannedGroupsStart);
  assert.ok(planStart >= 0);
  assert.ok(planEnd > planStart);
  assert.ok(presetGuard >= 0);
  assert.ok(presetGuard < earlyReturn);
  assert.ok(earlyReturn < firstRectangle);
  assert.match(workerSource, /function resolvedEccwArtDirection\(requested\)/);
  assert.match(workerSource, /scale: 1\.4, xOffset: 0, yOffset: 0, cutoffY: 850, headTargetY: 150/);
  assert.match(workerSource, /targetWidthOccupancy: 0\.82, targetHeightOccupancy: 0\.60/);
  assert.match(workerSource, /minimumHorizontalPadding: 30, maximumFontSize: 84/);
  assert.match(workerSource, /var logoDefaults = \{ visibleWidth: 260, xOffset: 0, yOffset: 0 \}/);
  assert.match(workerSource, /fontSize: 66, xOffset: 0, yOffset: 0/);
  assert.match(workerSource, /fontSize: 30, xOffset: 0, yOffset: 0/);
  assert.match(workerSource, /fontSize: 78,\s+xOffset: 0,\s+yOffset: 6,\s+fill:/);
  assert.match(workerSource, /function createMatchCardGroups\(document, layoutPreset\)/);
  assert.match(
    workerSource,
    /MATCH_GROUP_DEFINITIONS\[0\],\s+MATCH_GROUP_DEFINITIONS\[3\],\s+MATCH_GROUP_DEFINITIONS\[7\],\s+MATCH_GROUP_DEFINITIONS\[5\],\s+MATCH_GROUP_DEFINITIONS\[6\]/
  );
  assert.match(
    workerSource,
    /createMatchCardGroups\(document, payload\.style\.layoutPreset\)/
  );
  const eccwPlanStart = plannedGroupsSource.indexOf(
    "layoutPreset === ECCW_PANEL_LAYOUT_PRESET"
  );
  const genericPlanStart = plannedGroupsSource.indexOf(
    '"20 - ATMOSPHERE"',
    eccwPlanStart
  );
  const eccwPlanReturnEnd = plannedGroupsSource.indexOf("];", eccwPlanStart);
  assert.ok(eccwPlanStart >= 0);
  assert.ok(eccwPlanReturnEnd > eccwPlanStart);
  assert.ok(genericPlanStart > eccwPlanReturnEnd);
  assert.match(
    workerSource,
    /inspectCompetitorTransparencyBeforePlacement\(file, role, warnings \|\| \[\]\);/
  );
  assert.match(transparencySource, /Boolean\(sourceLayer\.isBackgroundLayer\)/);
  assert.match(transparencySource, /sourceDocument\.close\(SaveOptions\.DONOTSAVECHANGES\)/);
  assert.match(transparencySource, /is opaque in Photoshop and will remain opaque/);
  assert.doesNotMatch(placementSource, /clippingMask\s*:/);
  assert.match(placementSource, /placement\.nonGenerativeMask = true/);
  assert.match(
    workerSource,
    /function applyEccwVisibleContentPlacement\(document, layer, role, artDirection, logoSourceGeometry, placementDiagnostics\)/
  );
  assert.match(
    workerSource,
    /var initialBounds = safeTransformBounds\(layer\)/
  );
  assert.match(
    workerSource,
    /scaleRatio = \(605 \* Number\(competitorDirection\.scale\)\) \/ initial\.height/
  );
  assert.match(
    workerSource,
    /expectedCenterX = \(role === "competitorLeft" \? 480 : 1440\) \+ Number\(competitorDirection\.xOffset\)/
  );
  assert.match(
    workerSource,
    /expectedTop = Number\(competitorDirection\.headTargetY\) \+ Number\(competitorDirection\.yOffset\)/
  );
  assert.match(
    workerSource,
    /function applyMandatoryEccwCutoffMask\(document, layer, role, unmaskedBounds, cutoffY\)/
  );
  assert.match(
    workerSource,
    /addSelectionMask\(document, layer, \{\s+left: 0,\s+top: 0,\s+right: ECCW_PANEL_CANVAS_WIDTH,\s+bottom: cutoffY/
  );
  assert.match(workerSource, /activeUserMaskSelectionBounds\(document, layer\)/);
  assert.match(workerSource, /Photoshop did not create a real user layer mask/);
  assert.doesNotMatch(
    workerSource.slice(
      workerSource.indexOf("function applyMandatoryEccwCutoffMask("),
      workerSource.indexOf("\n    function findLayersNamed(")
    ),
    /createRectangleFill|applyClippingPreference/
  );
  assert.match(workerSource, /function resolveApprovedEccwFont\(fonts\)/);
  assert.match(workerSource, /isSemiBold \? 550/);
  assert.match(workerSource, /identity\.indexOf\("bahnschrift"\)/);
  assert.match(workerSource, /identity\.indexOf\("arial narrow"\)/);
  assert.match(workerSource, /identity\.indexOf\("impact"\)/);
  assert.match(workerSource, /recordApprovedEccwFont\(payload\.style, approvedEccwFont, warnings\)/);
  assert.match(workerSource, /ECCW design font selected: family=/);
  assert.match(workerSource, /PostScript=/);
  assert.match(
    workerSource,
    /layer\.textItem\.size = UnitValue\(Math\.max\(minimumPointSize, currentPointSize \* ratio \* 0\.99\), "pt"\)/
  );
  assert.match(workerSource, /targetWidth = Math\.min\(/);
  assert.match(workerSource, /plateWidth \* Number\(nameplates\.targetWidthOccupancy\)/);
  assert.match(workerSource, /textItem\.tracking = Number\(geometry\.tracking\)/);
  assert.match(
    workerSource,
    /UnitValue\(Number\(geometry\.x\) - \(\(bounds\.left \+ bounds\.right\) \/ 2\), "px"\)/
  );
  assert.match(
    workerSource,
    /UnitValue\(Number\(geometry\.y\) - \(\(bounds\.top \+ bounds\.bottom\) \/ 2\), "px"\)/
  );
  assert.match(workerSource, /rgb = \{ red: 255, green: 255, blue: 255 \}/);
  assert.match(workerSource, /effects\.putObject\(strokeKey, strokeKey, stroke\)/);
  assert.match(workerSource, /assertEccwCompetitorMaskAndOccupancy/);
  assert.match(workerSource, /function createEccwBrightnessContrastAdjustment/);
  assert.match(workerSource, /charIDToTypeID\("BrgC"\)/);
  assert.match(workerSource, /adjustmentLayer\.grouped = true/);
  assert.match(workerSource, /Configured ECCW top-plate elements overlap/);
  assert.match(workerSource, /if \(semantic\.stipulation\)/);
  assert.match(workerSource, /function buildEccwArtDirectionRecord/);
  assert.match(workerSource, /finalTextBounds: textBounds/);
  assert.match(workerSource, /competitorVisibleBounds: visibleBounds/);
  assert.match(workerSource, /adjustments: adjustments/);
  assert.match(workerSource, /artDirection: resolvedArtDirection \? \{/);
  assert.match(planSource, /resolvedEccwArtDirection\(payload\.artDirection \|\| \{\}\)/);
  assert.match(planSource, /requested: plannedRequestedArtDirection/);
  assert.match(planSource, /resolved: resolvedArtDirection/);
  assert.doesNotMatch(planSource, /installedFonts|safeTransformBounds|app\.activeDocument/);
  assert.match(workerSource, /assertEccwCompetitorVisible\(document, semantic\[assetRole\]/);
  assert.match(workerSource, /role \+ " is not above the template background\."/);
  assert.match(workerSource, /role \+ " is not below the live text and finishing groups\."/);
  assert.match(workerSource, /validateEccwPreviewLayout\(document, semantic/);
  assert.match(workerSource, /rectangleGeometry\.width \* rectangleGeometry\.height > canvasArea \* 0\.25/);
});

test("ECCW VS fill resolves, renders, validates, and records one canonical red", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const rgbEqualStart = workerSource.indexOf("function eccwRgbEqual(");
  const rgbTextStart = workerSource.indexOf(
    "\n    function eccwRgbText(",
    rgbEqualStart
  );
  assert.ok(rgbEqualStart >= 0);
  assert.ok(rgbTextStart > rgbEqualStart);
  const rgbEqual = Function(
    `"use strict"; return (${workerSource.slice(rgbEqualStart, rgbTextStart).trim()});`
  )();
  const resolveStart = workerSource.indexOf("function resolveEccwVsFill(");
  const resolveEnd = workerSource.indexOf(
    "\n    function validateEccwShadow(",
    resolveStart
  );
  assert.ok(resolveStart >= 0);
  assert.ok(resolveEnd > resolveStart);
  const canonicalFill = { red: 198, green: 24, blue: 32 };
  assert.equal(rgbEqual(canonicalFill, canonicalFill, 0), true);
  assert.equal(rgbEqual({ red: 178, green: 0, blue: 24 }, canonicalFill, 0), false);
  const resolveFill = Function(
    "ECCW_VS_APPROVED_FILL",
    "eccwRgbEqual",
    "eccwRgbText",
    "cloneJsonValue",
    `"use strict"; return (${workerSource.slice(resolveStart, resolveEnd).trim()});`
  )(
    canonicalFill,
    rgbEqual,
    (value) => `rgb(${Number(value.red)},${Number(value.green)},${Number(value.blue)})`,
    (value) => structuredClone(value)
  );
  assert.deepEqual(resolveFill(null), canonicalFill);
  assert.deepEqual(resolveFill(canonicalFill), canonicalFill);
  assert.throws(
    () => resolveFill({ red: 178, green: 0, blue: 24 }),
    /expected=rgb\(198,24,32\) actual=rgb\(178,0,24\)/
  );

  assert.match(
    workerSource,
    /var ECCW_VS_APPROVED_FILL = \{ red: 198, green: 24, blue: 32 \};/
  );
  assert.equal(
    (workerSource.match(/ECCW_VS_APPROVED_FILL = \{ red: 198, green: 24, blue: 32 \}/g) || [])
      .length,
    1
  );
  assert.match(
    workerSource,
    /assertAllowedKeys\(requirePlainObject\(value\.vs, label \+ "\.vs"\), \["fontSize", "xOffset", "yOffset", "fill"\]/
  );
  assert.match(workerSource, /validateRgb\(value\.vs\.fill, label \+ "\.vs\.fill"\)/);
  assert.match(
    workerSource,
    /fill: resolveEccwVsFill\(requested\.vs && own\(requested\.vs, "fill"\) \? requested\.vs\.fill : null\)/
  );
  assert.match(workerSource, /resolved\.vs\.fill = resolveEccwVsFill\(resolved\.vs\.fill\)/);
  assert.match(
    workerSource,
    /vsFill: buildEccwVsFillDiagnostics\(requestedArtDirection \|\| \{\}, resolvedArtDirection, null\)/
  );
  assert.match(
    workerSource,
    /style\.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "matchTitle"\) \{\s+rgb = artDirection\.vs\.fill;/
  );
  assert.match(workerSource, /var configuredVsFill = artDirection\.vs\.fill/);
  assert.doesNotMatch(workerSource, /color\.rgb\.red = 198;\s*color\.rgb\.green = 24;\s*color\.rgb\.blue = 32/);
  assert.match(workerSource, /var expectedVersusColor = artDirection\.vs\.fill/);
  assert.match(workerSource, /var versusFillPassed = eccwRgbEqual\(versusColor, expectedVersusColor, 1\)/);
  assert.match(
    workerSource,
    /"VS fill validation failed: expected=" \+ eccwRgbText\(expectedVersusColor\) \+\s+" actual=" \+ eccwRgbText\(versusColor\)/
  );
  assert.match(workerSource, /record\.vsFill = buildEccwVsFillDiagnostics/);
  assert.match(workerSource, /requestedFill: requestedFill/);
  assert.match(workerSource, /presetDefaultFill: cloneJsonValue\(ECCW_VS_APPROVED_FILL\)/);
  assert.match(workerSource, /finalResolvedFill: cloneJsonValue\(resolved\.vs\.fill\)/);
  assert.match(workerSource, /appliedPhotoshopTextLayerFill:/);
  assert.match(workerSource, /measuredValidationFill:/);
  assert.match(workerSource, /validationPassed:/);

  const createTextStart = workerSource.indexOf("function createEditableMatchText(");
  const createTextEnd = workerSource.indexOf(
    "\n    function applyApprovedEccwTextStyles(",
    createTextStart
  );
  const createTextSource = workerSource.slice(createTextStart, createTextEnd);
  assert.match(createTextSource, /var color = new SolidColor\(\), rgb = role === "championship" \? style\.metallicColor : style\.accentColor/);
  assert.match(createTextSource, /style\.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "matchTitle"/);
});

test("ECCW logo placement derives final width from transparent source pixels", () => {
  const workerSource = readFileSync(
    path.resolve(process.cwd(), "..", "local-agent", "bridge-worker.jsx"),
    "utf8"
  );
  const calculationStart = workerSource.indexOf(
    "function calculateEccwLogoScaleDiagnostics("
  );
  const formatterStart = workerSource.indexOf(
    "\n    function formatEccwLogoWidthVerificationFailure(",
    calculationStart
  );
  const placementStart = workerSource.indexOf(
    "\n    function applyEccwLogoAlphaPlacement(",
    formatterStart
  );
  const visiblePlacementStart = workerSource.indexOf(
    "\n    function applyEccwVisibleContentPlacement(",
    placementStart
  );
  const placeAssetStart = workerSource.indexOf("function placeMatchAsset(");
  const placeAssetEnd = workerSource.indexOf(
    "\n    function fontRoleForText(",
    placeAssetStart
  );
  assert.ok(calculationStart >= 0);
  assert.ok(formatterStart > calculationStart);
  assert.ok(placementStart > formatterStart);
  assert.ok(visiblePlacementStart > placementStart);
  assert.ok(placeAssetStart >= 0);
  assert.ok(placeAssetEnd > placeAssetStart);

  const calculation = Function(
    `"use strict"; return (${workerSource.slice(calculationStart, formatterStart).trim()});`
  )();
  const formatFailure = Function(
    `"use strict"; return (${workerSource.slice(formatterStart, placementStart).trim()});`
  )();

  // Runtime regression: the transparent PNG is 1,536 px wide with 1,500 px
  // of alpha-visible logo. Photoshop reports 253 px after the nominal pass,
  // requiring one relative feedback correction to converge on 260 px.
  const correctionFactor = 260 / 253;
  const initialTransform = [0, 0, 1536, 0, 1536, 1024, 0, 1024];
  const passed = calculation(
    1536,
    1500,
    260,
    1500,
    initialTransform,
    253,
    [correctionFactor],
    260,
    1
  );
  assert.equal(passed.sourceFullWidth, 1536);
  assert.equal(passed.sourceAlphaVisibleWidth, 1500);
  assert.equal(passed.requestedAlphaVisibleWidth, 260);
  assert.equal(passed.initialPlacedAlphaVisibleWidth, 1500);
  assert.deepEqual(passed.initialPlacementTransform, initialTransform);
  assert.equal(passed.nominalScaleFactor, 260 / 1500);
  assert.equal(passed.nominalScalePercent, (260 / 1500) * 100);
  assert.equal(passed.measuredWidthAfterNominalScale, 253);
  assert.equal(passed.correctionFactors.length, 1);
  assert.ok(Math.abs(passed.correctionFactors[0] - 1.0276679841897234) < 1e-12);
  assert.equal(passed.correctionIterations, 1);
  assert.ok(
    Math.abs(
      passed.cumulativeAppliedScaleFactor -
        (260 / 1500) * correctionFactor
    ) < 1e-12
  );
  assert.equal(passed.finalMeasuredAlphaVisibleWidth, 260);
  assert.equal(passed.difference, 0);
  assert.equal(passed.tolerance, 1);
  assert.equal(passed.verificationPassed, true);
  assert.equal(passed.scaleAnchor, "MIDDLECENTER");
  assert.deepEqual(passed.postScaleContainmentOrNormalization, []);

  const failed = calculation(
    1536,
    1500,
    260,
    1500,
    null,
    253,
    [260 / 253, 260 / 252, 260 / 252],
    252,
    1
  );
  assert.equal(failed.verificationPassed, false);
  assert.equal(failed.correctionIterations, 3);
  const message = formatFailure(failed);
  assert.match(message, /expected=260\.0000px/);
  assert.match(message, /measured=252\.0000px/);
  assert.match(message, /sourceAlpha=1500\.0000px/);
  assert.match(message, /sourceFull=1536\.0000px/);
  assert.match(message, /initialPlacedAlpha=1500\.0000px/);
  assert.match(message, /initialPlacementTransform=unavailable/);
  assert.match(message, /nominalScaleFactor=0\.17333333/);
  assert.match(message, /nominalScalePercent=17\.3333%/);
  assert.match(message, /measuredAfterNominal=253\.0000px/);
  assert.match(message, /correctionIterations=3/);
  assert.match(message, /cumulativeAppliedScaleFactor=/);
  assert.match(message, /difference=8\.0000px/);
  assert.match(message, /tolerance=1\.0000px/);
  assert.match(message, /verificationPassed=false/);
  assert.match(message, /scaleAnchor=MIDDLECENTER/);
  assert.match(message, /postScaleContainmentOrNormalization=none/);

  const logoPlacementSource = workerSource.slice(
    placementStart,
    visiblePlacementStart
  );
  assert.match(
    workerSource,
    /transparencyReference\.putEnumerated\(charIDToTypeID\("Chnl"\), charIDToTypeID\("Chnl"\), charIDToTypeID\("Trsp"\)\)/
  );
  assert.match(
    workerSource,
    /sourceDocument\.duplicate\("__ECCW_LOGO_ALPHA_INSPECTION__", true\)/
  );
  assert.match(
    logoPlacementSource,
    /var nominalScaleFactor = requestedWidth \/ Number\(sourceGeometry\.sourceAlphaVisibleWidth\)/
  );
  assert.match(
    logoPlacementSource,
    /var initialPlacedScaleFactor = initialWidth \/ Number\(sourceGeometry\.sourceAlphaVisibleWidth\)/
  );
  assert.match(
    logoPlacementSource,
    /var initialRelativeScaleFactor = nominalScaleFactor \/ initialPlacedScaleFactor/
  );
  assert.match(
    logoPlacementSource,
    /layer\.resize\(initialRelativeScaleFactor \* 100, initialRelativeScaleFactor \* 100, AnchorPosition\.MIDDLECENTER\)/
  );
  assert.match(
    logoPlacementSource,
    /var correctionFactor = requestedWidth \/ finalMeasuredWidth/
  );
  assert.match(
    logoPlacementSource,
    /layer\.resize\(correctionFactor \* 100, correctionFactor \* 100, AnchorPosition\.MIDDLECENTER\)/
  );
  assert.match(
    logoPlacementSource,
    /correctionFactors\.length < ECCW_LOGO_MAX_CORRECTION_ITERATIONS/
  );
  assert.match(
    logoPlacementSource,
    /activeLayerTransparencyBounds\(document, layer, "placed showLogo after offsets"\)/
  );
  assert.ok(
    logoPlacementSource.lastIndexOf("layer.resize(") <
      logoPlacementSource.indexOf("layer.translate(")
  );
  assert.match(
    logoPlacementSource,
    /var expectedCenterX = 960 \+ Number\(logoDirection\.xOffset\)/
  );
  assert.match(
    logoPlacementSource,
    /var expectedCenterY = 92 \+ Number\(logoDirection\.yOffset\)/
  );
  assert.match(
    logoPlacementSource,
    /UnitValue\(expectedCenterX - \(\(finalBounds\.left \+ finalBounds\.right\) \/ 2\), "px"\)/
  );
  assert.match(workerSource, /var ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE = 1;/);
  assert.match(workerSource, /var ECCW_LOGO_MAX_CORRECTION_ITERATIONS = 3;/);
  assert.match(workerSource, /function smartObjectPlacementTransform\(layer\)/);
  assert.match(workerSource, /stringIDToTypeID\("smartObjectMore"\)/);
  assert.match(workerSource, /stringIDToTypeID\("transform"\)/);
  assert.doesNotMatch(
    logoPlacementSource,
    /applyLayerPlacement|fitMode|maxWidth|maxHeight/
  );
  const placeAssetSource = workerSource.slice(placeAssetStart, placeAssetEnd);
  assert.match(
    placeAssetSource,
    /layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "showLogo"/
  );
  assert.match(
    placeAssetSource,
    /applyLayerPlacement\(document, layer, role, placement \|\| null, "contain", layoutPreset\)/
  );
  assert.match(workerSource, /logoPlacement: placementDiagnostics\.showLogo/);
  assert.match(workerSource, /record\.logoPlacement = cloneJsonValue\(logoPlacementDiagnostics\)/);
});

test("createMatchCard accepts every protected local asset role", async () => {
  const assets = validAssets({
    competitorCenter: "Center.png",
    promotionLogo: "Promotion.psd",
    championshipLogo: "Championship.tif",
    sponsorLogo: "Sponsor.jpg",
    suppliedCharacterArtwork: "Character.jpeg",
    suppliedPhotograph: "Photo.tiff",
  });
  const created = await request("/api/jobs/create-match-card", {
    body: validCreateMatchCard({
      style: validStyle({ layoutPreset: "three-competitor-title-center" }),
      assets,
    }),
  });
  assert.equal(created.response.status, 202);
});

test("createMatchCard requires GPT authentication", async () => {
  const result = await request("/api/jobs/create-match-card", {
    authenticated: false,
    body: validCreateMatchCard(),
  });
  assert.equal(result.response.status, 401);
});

const invalidCreateMatchCardCases = [
  ["missing templateBackground", validCreateMatchCard({ templateBackground: undefined })],
  [
    "missing showLogo",
    validCreateMatchCard({
      assets: {
        competitorLeft: "Breakker.png",
        competitorRight: "Rage.png",
      },
    }),
  ],
  [
    "missing a layout-required competitor",
    validCreateMatchCard({ assets: validAssets({ competitorRight: undefined }) }),
  ],
  [
    "unsupported layout preset",
    validCreateMatchCard({ style: validStyle({ layoutPreset: "freeform" }) }),
  ],
  [
    "malformed template extension",
    validCreateMatchCard({
      templateBackground: validTemplateBackground({ fileName: "template.png.exe" }),
    }),
  ],
  [
    "unsupported template fit mode",
    validCreateMatchCard({
      templateBackground: validTemplateBackground({ fitMode: "stretch" }),
    }),
  ],
  [
    "forward-slash traversal",
    validCreateMatchCard({ assets: validAssets({ competitorLeft: "../Breakker.png" }) }),
  ],
  [
    "backslash directory",
    validCreateMatchCard({ assets: validAssets({ competitorLeft: "renders\\Breakker.png" }) }),
  ],
  [
    "drive-qualified file name",
    validCreateMatchCard({ assets: validAssets({ competitorLeft: "C:Breakker.png" }) }),
  ],
  [
    "remote URL",
    validCreateMatchCard({
      assets: validAssets({ competitorLeft: "https://example.com/Breakker.png" }),
    }),
  ],
  [
    "base64 data URI",
    validCreateMatchCard({
      assets: validAssets({ competitorLeft: "data:image/png;base64,AAAA" }),
    }),
  ],
  [
    "null byte in asset file name",
    validCreateMatchCard({ assets: validAssets({ competitorLeft: "Break\0ker.png" }) }),
  ],
  [
    "reserved device file name",
    validCreateMatchCard({ assets: validAssets({ competitorLeft: "CON.png" }) }),
  ],
  ["invalid canvas width", validCreateMatchCard({ canvas: validCanvas({ width: 319 }) })],
  [
    "invalid canvas resolution",
    validCreateMatchCard({ canvas: validCanvas({ resolution: 35 }) }),
  ],
  [
    "excessive canvas pixels",
    validCreateMatchCard({ canvas: validCanvas({ width: 8192, height: 8192 }) }),
  ],
  [
    "invalid RGB component",
    validCreateMatchCard({
      style: validStyle({ primaryColor: { red: 256, green: 0, blue: 0 } }),
    }),
  ],
  [
    "non-integer RGB component",
    validCreateMatchCard({
      style: validStyle({ primaryColor: { red: 1.5, green: 0, blue: 0 } }),
    }),
  ],
  [
    "unknown asset role",
    validCreateMatchCard({ assets: { ...validAssets(), wrestlerLeft: "Other.png" } }),
  ],
  [
    "overlong text field",
    validCreateMatchCard({ text: validMatchCardText({ venue: "x".repeat(1001) }) }),
  ],
  [
    "excessive total text",
    validCreateMatchCard({
      text: {
        championship: "a".repeat(900),
        competitorLeftName: "b".repeat(900),
        competitorRightName: "c".repeat(900),
        matchTitle: "d".repeat(900),
        venue: "e".repeat(900),
        stipulation: "f".repeat(600),
      },
    }),
  ],
  ["empty text object", validCreateMatchCard({ text: {} })],
  ["unknown top-level property", validCreateMatchCard({ unexpected: true })],
  [
    "unknown nested style property",
    validCreateMatchCard({ style: validStyle({ photoshopDescriptor: {} }) }),
  ],
  [
    "unknown requested-font role",
    validCreateMatchCard({ style: validStyle({ fonts: { logo: "Arial" } }) }),
  ],
  [
    "overlong requested font",
    validCreateMatchCard({ style: validStyle({ fonts: { mainTitle: "x".repeat(101) } }) }),
  ],
  [
    "DEL control character in requested font",
    validCreateMatchCard({ style: validStyle({ fonts: { mainTitle: "Arial\x7f" } }) }),
  ],
  [
    "invalid normalized placement",
    validCreateMatchCard({
      placements: {
        competitorLeft: { coordinateSpace: "normalized", x: 1.1, y: 0.5 },
      },
    }),
  ],
  [
    "invalid implicit normalized placement",
    validCreateMatchCard({
      placements: { competitorLeft: { x: 1.1, y: 0.5 } },
    }),
  ],
  [
    "unpaired placement coordinates",
    validCreateMatchCard({
      placements: { competitorLeft: { coordinateSpace: "pixels", x: 100 } },
    }),
  ],
  [
    "non-integer pixel placement",
    validCreateMatchCard({
      placements: {
        competitorLeft: { coordinateSpace: "pixels", x: 100.5, y: 200 },
      },
    }),
  ],
  [
    "unsupported placement fit mode",
    validCreateMatchCard({
      placements: { competitorLeft: { fitMode: "stretch" } },
    }),
  ],
  [
    "unknown placement role",
    validCreateMatchCard({ placements: { referee: { x: 0.5, y: 0.5 } } }),
  ],
  [
    "placement for an unsupplied asset",
    validCreateMatchCard({ placements: { sponsorLogo: { x: 0.5, y: 0.5 } } }),
  ],
  ["missing output PSD", validCreateMatchCard({ outputPsdName: undefined })],
  ["missing output preview", validCreateMatchCard({ outputPreviewName: undefined })],
  ["missing output manifest", validCreateMatchCard({ outputManifestName: undefined })],
  ["drive-qualified output", validCreateMatchCard({ outputPsdName: "C:output.psd" })],
  [
    "output collision with an input asset",
    validCreateMatchCard({ outputPreviewName: "Breakker.png" }),
  ],
  ["caller disables Bale CC", validCreateMatchCard({ baleCcEnabled: false })],
  ["caller supplies Bale configuration", validCreateMatchCard({ baleCc: { enabled: false } })],
  ["caller supplies requiresConfirmation", validCreateMatchCard({ requiresConfirmation: false })],
  ["caller supplies a model prompt", validCreateMatchCard({ prompt: "generate people" })],
  ["caller supplies base64 content", validCreateMatchCard({ imageBase64: "AAAA" })],
  ["caller supplies an arbitrary script", validCreateMatchCard({ script: "alert('x')" })],
  [
    "caller supplies an arbitrary Photoshop descriptor",
    validCreateMatchCard({ photoshopDescriptor: { _obj: "placeEvent" } }),
  ],
];

for (const [name, body] of invalidCreateMatchCardCases) {
  test(`createMatchCard rejects ${name}`, async () => {
    const result = await request("/api/jobs/create-match-card", { body });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
}

test("creates a confirmed updateMatchCard job", async () => {
  const created = await request("/api/jobs/update-match-card", {
    body: validUpdateMatchCard(),
  });
  assert.equal(created.response.status, 202);
  const job = await getJob(created.body.jobId);
  assert.equal(job.type, "updateMatchCard");
  assert.equal(job.requiresConfirmation, true);
});

test("updateMatchCard accepts an explicit local template replacement", async () => {
  const created = await request("/api/jobs/update-match-card", {
    body: validUpdateMatchCard({
      changes: {
        templateBackground: {
          fileName: "ECCW_Breakker_vs_Rage_template_bg_v2.png",
          fitMode: "cover",
        },
      },
    }),
  });
  assert.equal(created.response.status, 202);
});

test("updateMatchCard requires GPT authentication", async () => {
  const result = await request("/api/jobs/update-match-card", {
    authenticated: false,
    body: validUpdateMatchCard(),
  });
  assert.equal(result.response.status, 401);
});

const invalidUpdateMatchCardCases = [
  [
    "invalid manifest extension",
    validUpdateMatchCard({ manifestFileName: "ECCW_Breakker_vs_Rage_v1.json" }),
  ],
  [
    "manifest traversal",
    validUpdateMatchCard({ manifestFileName: "../ECCW_v1.matchcard.json" }),
  ],
  [
    "drive-qualified manifest",
    validUpdateMatchCard({ manifestFileName: "C:ECCW_v1.matchcard.json" }),
  ],
  [
    "invalid replacement asset",
    validUpdateMatchCard({ changes: { assets: { competitorRight: "Rage.gif" } } }),
  ],
  [
    "replacement asset traversal",
    validUpdateMatchCard({ changes: { assets: { competitorRight: "../Rage.png" } } }),
  ],
  [
    "remote replacement asset",
    validUpdateMatchCard({
      changes: { assets: { competitorRight: "https://example.com/Rage.png" } },
    }),
  ],
  [
    "unknown asset role",
    validUpdateMatchCard({ changes: { assets: { replacementLogo: "Logo.png" } } }),
  ],
  [
    "unknown semantic visibility role",
    validUpdateMatchCard({
      changes: { visibility: [{ role: "Layer 9", visible: false }] },
    }),
  ],
  [
    "Bale visibility control",
    validUpdateMatchCard({
      changes: { visibility: [{ role: "baleCc", visible: false }] },
    }),
  ],
  [
    "duplicate visibility role",
    validUpdateMatchCard({
      changes: {
        visibility: [
          { role: "showLogo", visible: true },
          { role: "showLogo", visible: false },
        ],
      },
    }),
  ],
  [
    "unknown placement role",
    validUpdateMatchCard({ changes: { placements: { referee: { x: 0.5, y: 0.5 } } } }),
  ],
  [
    "invalid placement bounds",
    validUpdateMatchCard({
      changes: {
        placements: {
          competitorRight: { coordinateSpace: "normalized", maxWidth: 1.1 },
        },
      },
    }),
  ],
  [
    "incoherent inherited placement values",
    validUpdateMatchCard({
      changes: { placements: { competitorRight: { x: 0.5, y: 200 } } },
    }),
  ],
  [
    "invalid theme color",
    validUpdateMatchCard({
      changes: { style: { accentColor: { red: -1, green: 0, blue: 0 } } },
    }),
  ],
  [
    "unknown update font role",
    validUpdateMatchCard({ changes: { style: { fonts: { logo: "Arial" } } } }),
  ],
  [
    "overlong update text",
    validUpdateMatchCard({ changes: { text: { venue: "x".repeat(1001) } } }),
  ],
  ["empty changes", validUpdateMatchCard({ changes: {} })],
  [
    "source manifest overwrite",
    validUpdateMatchCard({ outputManifestName: "ECCW_Breakker_vs_Rage_v1.matchcard.json" }),
  ],
  ["output path traversal", validUpdateMatchCard({ outputPsdName: "../ECCW_v2.psd" })],
  ["missing output name", validUpdateMatchCard({ outputPreviewName: undefined })],
  ["unknown top-level property", validUpdateMatchCard({ unexpected: true })],
  [
    "unknown changes property",
    validUpdateMatchCard({ changes: { arbitraryLayers: [{ name: "Layer 1" }] } }),
  ],
  ["caller disables Bale CC", validUpdateMatchCard({ baleCcEnabled: false })],
  [
    "caller supplies a script",
    validUpdateMatchCard({ changes: { script: "app.activeDocument.flatten()" } }),
  ],
  [
    "caller supplies a model prompt",
    validUpdateMatchCard({ changes: { prompt: "regenerate the wrestler" } }),
  ],
];

for (const [name, body] of invalidUpdateMatchCardCases) {
  test(`updateMatchCard rejects ${name}`, async () => {
    const result = await request("/api/jobs/update-match-card", { body });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "Invalid request");
  });
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

test("existing inspect and Smart Object routes reject unknown properties", async () => {
  const inspect = await request("/api/jobs/inspect-document", {
    body: { documentName: "MatchCard.psd", script: "ignored-before-hardening" },
  });
  assert.equal(inspect.response.status, 400);
  assert.equal(inspect.body.error, "Invalid request");

  const replacement = await request("/api/jobs/replace-smart-object", {
    body: {
      documentName: "MatchCard.psd",
      layerId: 123,
      replacementFileName: "ECCW.png",
      fitMode: "contain",
      outputPsdName: "MatchCard_ECCW_v1.psd",
      outputPreviewName: "MatchCard_ECCW_v1.png",
      photoshopDescriptor: {},
    },
  });
  assert.equal(replacement.response.status, 400);
  assert.equal(replacement.body.error, "Invalid request");
});
