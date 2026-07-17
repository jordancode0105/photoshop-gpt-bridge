# Private Custom GPT → Photoshop UXP Bridge

This starter project implements a deliberately narrow first version:

1. Inspect the active/open PSD layer tree.
2. Replace one named or ID-addressed Smart Object.
3. Fit the replacement to the old layer bounds.
4. Save a **new layered PSD copy**.
5. Export a local PNG preview.
6. Require approval inside Photoshop before any write operation.

The relay does not call the OpenAI API. Your private Custom GPT calls the relay through a GPT Action.

## Architecture

```text
Private Custom GPT Action
        |
        | HTTPS + Bearer GPT action key
        v
Node/Express relay
        ^
        | HTTPS + separate device token
        |
Photoshop UXP plugin
        |
        v
Open PSD + user-approved working folder
```

## Security decisions in this starter

- No arbitrary JavaScript, shell, or filesystem endpoints.
- GPT and Photoshop use separate secrets.
- The plugin only accesses a folder selected through the UXP folder picker.
- Inspection runs automatically; replacement requires approval in the Photoshop panel.
- The original PSD is never intentionally overwritten.
- Output names must be plain file names, not paths.
- Jobs expire from the relay.
- The starter relay stores jobs in memory. Replace this with Redis/Postgres before relying on it for durable production work.

---

## Step 1 — Generate two secrets

Run this twice in PowerShell or Command Prompt:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use one result as `GPT_ACTION_API_KEY` and the other as `PHOTOSHOP_DEVICE_TOKEN`.

Never use the same value for both.

## Step 2 — Run the relay locally first

```bash
cd relay
copy .env.example .env
```

Edit `.env`, then:

```bash
npm install
npm start
```

Confirm:

```text
http://localhost:3000/health
```

A Custom GPT cannot call localhost. Local mode is only for checking the server. Deploy it to an HTTPS host before configuring the GPT Action.

## Step 3 — Deploy the relay

Render is one option:

1. Push this project to a private GitHub repository.
2. Create a new Render Blueprint from `render.yaml`, or create a Node web service with `relay` as the root directory.
3. Add both secret environment variables.
4. Confirm `https://YOUR-SERVICE/health` returns JSON.

The relay has no database in this MVP. A service restart clears pending jobs.

## Step 4 — Configure the UXP plugin

Edit:

```text
plugin/manifest.json
```

Replace both occurrences of:

```text
https://YOUR-RELAY-DOMAIN.example.com
```

with the exact deployed relay origin, with no trailing slash.

Do not use `network.domains: "all"`.

## Step 5 — Load the plugin into Photoshop

Install the latest Photoshop and **UXP Developer Tool** through Creative Cloud.

In UXP Developer Tool:

1. Choose **Add Plugin**.
2. Select `plugin/manifest.json`.
3. Launch or reload the plugin.
4. In Photoshop, open **Plugins → Photoshop GPT Bridge**.

Inside the panel:

1. Enter the HTTPS relay URL.
2. Enter `PHOTOSHOP_DEVICE_TOKEN`.
3. Select a dedicated working folder.
4. Put replacement files such as `ECCW.png` in that folder.
5. Click **Connect**.

## Step 6 — Configure the private Custom GPT Action

Edit:

```text
relay/openapi.yaml
```

Replace:

```text
https://YOUR-RELAY-DOMAIN.example.com
```

with the deployed relay origin.

In the GPT editor:

1. Create a private GPT.
2. Add a new Action.
3. Paste `openapi.yaml`.
4. Authentication: **API key → Bearer**.
5. Use `GPT_ACTION_API_KEY`, not the Photoshop device token.
6. Keep the GPT private.

Suggested GPT instructions are in `CUSTOM_GPT_INSTRUCTIONS.md`.

## Step 7 — First test

Open a PSD in Photoshop and keep the bridge connected.

Ask the GPT:

```text
Inspect the active Photoshop document. Return the document information and identify every Smart Object layer with its layer ID and full group path.
```

The GPT should:

1. Call `inspectPhotoshopDocument`.
2. Receive a `jobId`.
3. Poll `getPhotoshopJobStatus`.
4. Return the layer tree after the plugin completes the job.

Then test a replacement:

```text
Replace Smart Object layer ID 123 with ECCW.png. Use contain fitting. Save CataclysmMatchCard_ECCW_v1.psd and CataclysmMatchCard_ECCW_v1.png. Do not overwrite the original.
```

Approve the pending job in the Photoshop panel.

---

## Important Smart Object note

Photoshop does not currently expose Smart Object replacement through the high-level UXP DOM. The plugin uses the lower-level `placedLayerReplaceContents` `batchPlay` command.

Adobe recommends using DOM APIs first and `batchPlay` for functionality not exposed in the DOM. Action descriptors can be version-sensitive. If replacement fails on your Photoshop build:

1. Enable developer mode/menu recording.
2. Create a temporary Smart Object.
3. Record **Replace Contents** in the Actions panel.
4. Use **Copy As JavaScript**.
5. Compare the copied descriptor with `replaceSelectedSmartObject()` in `plugin/index.js`.

The plugin deliberately selects the target layer before replacement because this command may require the Smart Object to be the sole active layer.

## Known MVP limitations

- The relay is in-memory.
- The PNG preview remains on your computer; it is not uploaded back to the GPT.
- Only Smart Object replacement is implemented.
- Duplicate layer names require using a layer ID.
- Hidden layer filters or unusual Smart Object states can make Photoshop reject replacement.
- Output files are overwritten if an earlier output copy has the same name. The original open document is protected by a name check, but use versioned output names.
- Recoloring is intentionally not included yet. It should be added only after inspection and replacement work reliably.

## Recommended next operations

After the MVP works, add separate allowlisted operations:

- `updateTextLayer`
- `setLayerVisibility`
- `renameLayer`
- `transformLayer`
- `updateSolidFill`
- `updateHueSaturation`
- `recolorNamedLayers`
- preview upload through private object storage

Do not add `executeJavaScript`, raw `batchPlay`, a generic filesystem endpoint, or shell/process access.
