"use strict";

const photoshop = require("photoshop");
const uxp = require("uxp");

const { app, action, core, constants } = photoshop;
const fs = uxp.storage.localFileSystem;
const secureStorage = uxp.storage.secureStorage;

const SETTINGS = {
  relayUrl: "photoshop-gpt-bridge.relay-url",
  deviceToken: "photoshop-gpt-bridge.device-token",
  workingFolderToken: "photoshop-gpt-bridge.working-folder-token",
};

const state = {
  connected: false,
  polling: false,
  pollTimer: null,
  currentJob: null,
};

const el = {
  relayUrl: document.getElementById("relayUrl"),
  deviceToken: document.getElementById("deviceToken"),
  saveSettings: document.getElementById("saveSettings"),
  testConnection: document.getElementById("testConnection"),
  chooseFolder: document.getElementById("chooseFolder"),
  folderStatus: document.getElementById("folderStatus"),
  connectionStatus: document.getElementById("connectionStatus"),
  toggleConnection: document.getElementById("toggleConnection"),
  jobCard: document.getElementById("jobCard"),
  jobDetails: document.getElementById("jobDetails"),
  approvalButtons: document.getElementById("approvalButtons"),
  approveJob: document.getElementById("approveJob"),
  rejectJob: document.getElementById("rejectJob"),
  log: document.getElementById("log"),
};

function log(message, details) {
  const stamp = new Date().toLocaleTimeString();
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
  el.log.textContent = `[${stamp}] ${message}${suffix}\n\n${el.log.textContent}`.slice(0, 12000);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function decodeSecureValue(value) {
  if (!value) return "";
  return new TextDecoder().decode(value);
}

async function loadSettings() {
  el.relayUrl.value = localStorage.getItem(SETTINGS.relayUrl) || "";

  try {
    el.deviceToken.value = decodeSecureValue(
      await secureStorage.getItem(SETTINGS.deviceToken)
    );
  } catch (_error) {
    el.deviceToken.value = "";
  }

  await refreshFolderStatus();
}

async function saveSettings() {
  const relayUrl = normalizeBaseUrl(el.relayUrl.value);
  const deviceToken = String(el.deviceToken.value || "").trim();

  if (!/^https:\/\//i.test(relayUrl)) {
    throw new Error("Relay URL must start with https://");
  }
  if (deviceToken.length < 24) {
    throw new Error("Device token should be at least 24 characters");
  }

  localStorage.setItem(SETTINGS.relayUrl, relayUrl);
  await secureStorage.setItem(SETTINGS.deviceToken, deviceToken);
  log("Settings saved");
}

async function getConnectionSettings() {
  const relayUrl = normalizeBaseUrl(
    localStorage.getItem(SETTINGS.relayUrl) || el.relayUrl.value
  );
  let deviceToken = "";
  try {
    deviceToken = decodeSecureValue(
      await secureStorage.getItem(SETTINGS.deviceToken)
    );
  } catch (_error) {
    deviceToken = String(el.deviceToken.value || "").trim();
  }

  if (!relayUrl || !deviceToken) {
    throw new Error("Save the relay URL and device token first");
  }
  return { relayUrl, deviceToken };
}

async function apiRequest(path, options = {}) {
  const { relayUrl, deviceToken } = await getConnectionSettings();
  const response = await fetch(`${relayUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-device-token": deviceToken,
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(body.error || `Relay returned HTTP ${response.status}`);
  }
  return body;
}

async function testConnection() {
  const { relayUrl } = await getConnectionSettings();
  const response = await fetch(`${relayUrl}/health`);
  if (!response.ok) {
    throw new Error(`Health check returned HTTP ${response.status}`);
  }
  const body = await response.json();
  log("Relay health check succeeded", body);
}

async function chooseWorkingFolder() {
  const folder = await fs.getFolder();
  if (!folder) return;

  const token = await fs.createPersistentToken(folder);
  localStorage.setItem(SETTINGS.workingFolderToken, token);
  await refreshFolderStatus();
  log(`Working folder selected: ${folder.nativePath}`);
}

async function getWorkingFolder() {
  const token = localStorage.getItem(SETTINGS.workingFolderToken);
  if (!token) {
    throw new Error("Choose a working folder in the plugin first");
  }

  try {
    return await fs.getEntryForPersistentToken(token);
  } catch (_error) {
    localStorage.removeItem(SETTINGS.workingFolderToken);
    await refreshFolderStatus();
    throw new Error("Working-folder permission expired. Choose the folder again.");
  }
}

async function refreshFolderStatus() {
  const token = localStorage.getItem(SETTINGS.workingFolderToken);
  if (!token) {
    el.folderStatus.textContent = "Not selected";
    return;
  }

  try {
    const folder = await fs.getEntryForPersistentToken(token);
    el.folderStatus.textContent = folder.nativePath;
  } catch (_error) {
    el.folderStatus.textContent = "Permission expired";
  }
}

function setConnected(value) {
  state.connected = value;
  el.connectionStatus.textContent = value ? "Connected and polling" : "Disconnected";
  el.connectionStatus.className = `status ${value ? "online" : "offline"}`;
  el.toggleConnection.textContent = value ? "Disconnect" : "Connect";

  if (value) {
    schedulePoll(100);
  } else if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll(delay = 2500) {
  if (!state.connected) return;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollForJob, delay);
}

async function pollForJob() {
  if (!state.connected || state.polling || state.currentJob) {
    schedulePoll();
    return;
  }

  state.polling = true;
  try {
    const job = await apiRequest("/api/plugin/jobs/claim-next", {
      method: "POST",
      body: "{}",
    });

    if (!job) {
      schedulePoll();
      return;
    }

    state.currentJob = job;
    showJob(job);
    log(`Claimed ${job.type} job ${job.id}`);

    if (!job.requiresConfirmation) {
      await executeCurrentJob();
    }
  } catch (error) {
    log(`Polling error: ${error.message}`);
  } finally {
    state.polling = false;
    schedulePoll();
  }
}

function showJob(job) {
  el.jobCard.classList.remove("hidden");
  el.jobDetails.textContent = JSON.stringify(job, null, 2);
  el.approvalButtons.classList.toggle("hidden", !job.requiresConfirmation);
}

function clearJob() {
  state.currentJob = null;
  el.jobCard.classList.add("hidden");
  el.approvalButtons.classList.add("hidden");
  el.jobDetails.textContent = "";
}

async function completeJob(jobId, result) {
  await apiRequest(`/api/plugin/jobs/${encodeURIComponent(jobId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ result }),
  });
}

async function failJob(jobId, error) {
  await apiRequest(`/api/plugin/jobs/${encodeURIComponent(jobId)}/fail`, {
    method: "POST",
    body: JSON.stringify({ error: String(error).slice(0, 4000) }),
  });
}

async function executeCurrentJob() {
  const job = state.currentJob;
  if (!job) return;

  el.approvalButtons.classList.add("hidden");

  try {
    let result;
    if (job.type === "inspectDocument") {
      result = await inspectDocument(job.payload);
    } else if (job.type === "replaceSmartObject") {
      result = await replaceSmartObject(job.payload);
    } else {
      throw new Error(`Unsupported job type: ${job.type}`);
    }

    await completeJob(job.id, result);
    log(`Completed ${job.type}`, result);
  } catch (error) {
    await failJob(job.id, error.message || String(error));
    log(`Job failed: ${error.message || error}`);
  } finally {
    clearJob();
  }
}

function getDocument(documentName) {
  if (!app.documents.length) {
    throw new Error("No Photoshop document is open");
  }

  if (!documentName) return app.activeDocument;

  const exact = app.documents.find(
    (document) =>
      document.title === documentName ||
      document.name === documentName
  );
  if (!exact) {
    throw new Error(`Open document not found: ${documentName}`);
  }
  return exact;
}

function numeric(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  if (value && typeof value._value === "number") return value._value;
  return null;
}

function serializeBounds(bounds) {
  if (!bounds) return null;
  return {
    left: numeric(bounds.left),
    top: numeric(bounds.top),
    right: numeric(bounds.right),
    bottom: numeric(bounds.bottom),
  };
}

function serializeLayer(layer, path = []) {
  const item = {
    id: layer.id,
    name: layer.name,
    path: [...path, layer.name].join(" / "),
    kind: String(layer.kind),
    isSmartObject: layer.kind === constants.LayerKind.SMARTOBJECT,
    isGroup: layer.kind === constants.LayerKind.GROUP,
    visible: layer.visible,
    opacity: layer.opacity,
    locked: layer.locked,
    bounds: serializeBounds(layer.bounds),
    children: [],
  };

  if (item.isGroup && layer.layers) {
    item.children = Array.from(layer.layers).map((child) =>
      serializeLayer(child, [...path, layer.name])
    );
  }
  return item;
}

async function inspectDocument(payload) {
  const document = getDocument(payload.documentName);
  const layers = Array.from(document.layers).map((layer) => serializeLayer(layer));

  return {
    document: {
      id: document.id,
      title: document.title,
      width: numeric(document.width),
      height: numeric(document.height),
      resolution: document.resolution,
      saved: document.saved,
      path: document.path || null,
    },
    layers,
    guidance:
      "Use a returned numeric layer ID for write operations whenever possible. Layer names may be duplicated.",
  };
}

function flattenLayers(layers) {
  const result = [];
  for (const layer of Array.from(layers)) {
    result.push(layer);
    if (layer.kind === constants.LayerKind.GROUP && layer.layers) {
      result.push(...flattenLayers(layer.layers));
    }
  }
  return result;
}

function resolveTargetLayer(document, payload) {
  const all = flattenLayers(document.layers);

  if (payload.layerId) {
    const match = all.find((layer) => layer.id === payload.layerId);
    if (!match) {
      throw new Error(`Layer ID ${payload.layerId} was not found`);
    }
    return match;
  }

  const exact = all.filter((layer) => layer.name === payload.layerName);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `Multiple layers are named "${payload.layerName}". Inspect the document and use layerId.`
    );
  }

  const insensitive = all.filter(
    (layer) => layer.name.toLowerCase() === payload.layerName.toLowerCase()
  );
  if (insensitive.length === 1) return insensitive[0];

  throw new Error(`Layer not found: ${payload.layerName}`);
}

async function getWorkingFile(folder, fileName) {
  if (/[\\/]/.test(fileName)) {
    throw new Error("Only a file name is allowed, not a path");
  }
  try {
    const entry = await folder.getEntry(fileName);
    if (!entry.isFile) throw new Error(`${fileName} is not a file`);
    return entry;
  } catch (_error) {
    throw new Error(`Replacement file not found in working folder: ${fileName}`);
  }
}

function rectSize(bounds) {
  const left = numeric(bounds.left);
  const top = numeric(bounds.top);
  const right = numeric(bounds.right);
  const bottom = numeric(bounds.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

async function selectSingleLayer(layerId) {
  await action.batchPlay(
    [
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: layerId }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    {}
  );
}

async function replaceSelectedSmartObject(file) {
  const token = fs.createSessionToken(file);

  /*
   * Smart Object replacement is not exposed in the high-level Photoshop DOM.
   * This batchPlay descriptor should be verified against your Photoshop build
   * with Actions panel -> Copy As JavaScript if Adobe changes the descriptor.
   */
  await action.batchPlay(
    [
      {
        _obj: "placedLayerReplaceContents",
        null: {
          _path: token,
          _kind: "local",
        },
        _options: {
          dialogOptions: "dontDisplay",
        },
      },
    ],
    {}
  );
}

async function fitLayerToBounds(layer, originalBounds, fitMode) {
  if (fitMode === "keep-transform") return;

  const target = rectSize(originalBounds);
  const current = rectSize(layer.bounds);

  if (
    !Number.isFinite(target.width) ||
    !Number.isFinite(target.height) ||
    !Number.isFinite(current.width) ||
    !Number.isFinite(current.height) ||
    target.width <= 0 ||
    target.height <= 0 ||
    current.width <= 0 ||
    current.height <= 0
  ) {
    throw new Error("Cannot calculate Smart Object bounds for fitting");
  }

  const containRatio = Math.min(
    target.width / current.width,
    target.height / current.height
  );
  const coverRatio = Math.max(
    target.width / current.width,
    target.height / current.height
  );
  const ratio = fitMode === "cover" ? coverRatio : containRatio;

  await layer.scale(
    ratio * 100,
    ratio * 100,
    constants.AnchorPosition.MIDDLECENTER
  );

  const resized = rectSize(layer.bounds);
  await layer.translate(
    target.centerX - resized.centerX,
    target.centerY - resized.centerY
  );
}

async function replaceSmartObject(payload) {
  const document = getDocument(payload.documentName);
  const layer = resolveTargetLayer(document, payload);

  if (layer.kind !== constants.LayerKind.SMARTOBJECT) {
    throw new Error(`Target layer "${layer.name}" is not a Smart Object`);
  }

  if (payload.outputPsdName === document.title || payload.outputPsdName === document.name) {
    throw new Error("Output PSD name must not match the original document");
  }

  const folder = await getWorkingFolder();
  const replacementFile = await getWorkingFile(folder, payload.replacementFileName);
  const originalBounds = layer.bounds;

  let psdFile;
  let previewFile;

  await core.executeAsModal(
    async () => {
      await selectSingleLayer(layer.id);
      await replaceSelectedSmartObject(replacementFile);
      await fitLayerToBounds(layer, originalBounds, payload.fitMode || "contain");

      psdFile = await folder.createFile(payload.outputPsdName, { overwrite: true });
      previewFile = await folder.createFile(payload.outputPreviewName, {
        overwrite: true,
      });

      await document.saveAs.psd(
        psdFile,
        { embedColorProfile: true },
        true
      );
      await document.saveAs.png(previewFile, {}, true);
    },
    {
      commandName: "GPT Bridge: Replace Smart Object and Save Copy",
      timeOut: 10,
    }
  );

  return {
    documentTitle: document.title,
    layerId: layer.id,
    layerName: layer.name,
    replacementFileName: payload.replacementFileName,
    fitMode: payload.fitMode || "contain",
    outputPsdName: psdFile.name,
    outputPsdPath: psdFile.nativePath,
    outputPreviewName: previewFile.name,
    outputPreviewPath: previewFile.nativePath,
    originalPreserved: true,
  };
}

el.saveSettings.addEventListener("click", async () => {
  try {
    await saveSettings();
  } catch (error) {
    log(`Settings error: ${error.message}`);
  }
});

el.testConnection.addEventListener("click", async () => {
  try {
    await saveSettings();
    await testConnection();
  } catch (error) {
    log(`Connection test failed: ${error.message}`);
  }
});

el.chooseFolder.addEventListener("click", async () => {
  try {
    await chooseWorkingFolder();
  } catch (error) {
    log(`Folder error: ${error.message}`);
  }
});

el.toggleConnection.addEventListener("click", async () => {
  try {
    if (!state.connected) {
      await saveSettings();
      await testConnection();
      await getWorkingFolder();
      setConnected(true);
    } else {
      setConnected(false);
    }
  } catch (error) {
    setConnected(false);
    log(`Could not connect: ${error.message}`);
  }
});

el.approveJob.addEventListener("click", executeCurrentJob);

el.rejectJob.addEventListener("click", async () => {
  const job = state.currentJob;
  if (!job) return;

  try {
    await failJob(job.id, "Rejected by user in Photoshop");
    log(`Rejected job ${job.id}`);
  } catch (error) {
    log(`Could not report rejection: ${error.message}`);
  } finally {
    clearJob();
  }
});

loadSettings().catch((error) => log(`Startup error: ${error.message}`));
