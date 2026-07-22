# Private Custom GPT to Photoshop Bridge

This project exposes seven narrowly scoped Photoshop operations:

1. Inspect an active or exactly named open document and return its complete layer tree.
2. Replace one ID- or name-addressed Smart Object, then save a new layered PSD and PNG preview.
3. Apply allowlisted Color Overlay recolors to 1 through 25 exact layer IDs, then save a new layered PSD and flattened PNG preview.
4. Replace content in 1 through 25 uniformly styled text layers, then save a new layered PSD and flattened PNG preview.
5. Export a read-only flattened PNG preview of an open document.
6. Export read-only isolated layer PNGs or a labeled contact sheet for up to 12 exact layer IDs.
7. Rename up to 50 exact layer IDs in a new layered PSD copy and export its PNG preview.

The relay does not call the OpenAI API. A private Custom GPT calls the relay through a GPT Action. A local PowerShell agent polls the relay and invokes a fixed ExtendScript worker through Photoshop COM automation.

```text
Private Custom GPT Action
        |
        | HTTPS + bearer GPT action key
        v
Node/Express relay
        ^
        | HTTPS + separate device token
        |
Local PowerShell agent
        |
        | Photoshop COM automation
        v
Fixed ExtendScript worker -> open PSD + configured working folder
```

## Security model

- There are no arbitrary JavaScript, Action Manager descriptor, shell, process, path, or filesystem endpoints.
- GPT and the local agent use separate secrets.
- Request schemas reject malformed and unknown fields for all new preview and rename operations.
- Inspection and preview exports are read-only and run without a prompt. Every replacement, recolor, text-update, or rename job requires the user to type exact `YES` locally.
- Write operations duplicate the document and never intentionally modify or save over the original.
- Output names must be plain filenames. The local worker refuses to overwrite an existing PSD or PNG.
- Jobs expire from the relay. Jobs are held in memory, so a relay restart clears them.

## Relay setup

Generate two different secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use one as `GPT_ACTION_API_KEY` and the other as `PHOTOSHOP_DEVICE_TOKEN`. Never reuse a secret.

For a local relay check:

```powershell
Set-Location relay
Copy-Item .env.example .env
npm install
npm start
```

Confirm `http://localhost:3000/health`. A Custom GPT cannot call localhost, so deploy the relay to an HTTPS host before configuring the Action. `relay/render.yaml` provides one Render configuration; add both secrets to the host environment. The checked-in server URL is already configured for this project and should only be changed when the deployment origin changes.

## Local agent setup

Follow [LOCAL_AGENT_SETUP.md](LOCAL_AGENT_SETUP.md). In brief, copy `local-agent/.env.example` to `local-agent/.env`, configure the deployed relay URL, device token, and dedicated working folder, open Photoshop, and start `local-agent/start-agent.cmd`.

Both `relay/.env` and `local-agent/.env` are ignored by Git. Never commit, paste, or log their contents.

## Custom GPT Action setup

In the private GPT editor:

1. Add an Action using `relay/openapi.yaml`.
2. Select API key authentication with the Bearer scheme.
3. Use `GPT_ACTION_API_KEY`, never the local device token.
4. Keep the GPT private.
5. Use `CUSTOM_GPT_INSTRUCTIONS.md` as operating guidance.

The OpenAPI document intentionally contains only caller-facing GPT operations. Local-agent endpoints are not exposed.

## Inspect and replace workflow

Open a PSD and keep the local agent running. First request an inspection and wait for the `inspectPhotoshopDocument` job to succeed. Prefer numeric layer IDs from that result.

For Smart Object replacement, provide the exact layer ID, a replacement filename already present in the configured working folder, a fit mode (`contain`, `cover`, or `keep-transform`), and versioned PSD/PNG names. Review the local payload and type `YES` to approve. Existing inspection and replacement behavior remains unchanged.

## Export previews for visual identification

Preview jobs are read-only, run without local `YES` approval, and write PNGs into the configured `WORKING_FOLDER`. Use versioned names because existing files are never overwritten. The relay and GPT receive output paths, not image pixels: upload the resulting PNG or contact sheet into the GPT chat before asking for visual conclusions.

Export the whole open document as a flattened PNG:

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    outputPreviewName = "RWCMatchCard_preview_v1.png"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/export-document-preview" -Headers $headers -ContentType "application/json" -Body $body
$job
```

After a fresh inspection, export exact layer IDs:

```powershell
$body = @{
    documentName = "RWCMatchCard.psd"
    layerIds = @(31, 53, 90)
    mode = "contact-sheet"
    marginPx = 40
    baseOutputName = "candidate_layers_v1"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/export-layer-previews" -Headers $headers -ContentType "application/json" -Body $body
$job
```

The layer modes are:

- `isolated-transparent`: hides unrelated layers, trims to visible pixels, and adds the requested transparent margin.
- `isolated-on-canvas`: hides unrelated layers but retains the original canvas size and placement.
- `contact-sheet`: creates one deterministic transparent PNG with labeled tiles for comparing candidates.

Clipped layers retain their required clipping-base context where Photoshop exposes it. Each result includes the source layer ID, name, full path, and local output path. Deterministic filenames are `<base>_layer_<id>.png` or `<base>_contact_sheet.png`.

Poll either preview job until completion:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

If candidates remain ambiguous, upload the exported images to the GPT chat and request a comparison. Do not treat a local path as visual evidence.

## Clean up ambiguous layer names

Use a fresh inspection, and preview uncertain candidates before renaming. Present old and proposed names first. Role-based names such as `SHOW LOGO - SMART OBJECT`, `LOWER THIRD LIGHT STRIP`, `FULL FRAME ATMOSPHERE`, and `MAIN EVENT TITLE` make later targeted edits safer.

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    edits = @(
        @{
            layerId = 100
            newName = "SHOW LOGO - SMART OBJECT"
        }
    )
    outputPsdName = "RWCMatchCard_Renamed_v1.psd"
    outputPreviewName = "RWCMatchCard_Renamed_v1.png"
} | ConvertTo-Json -Depth 5
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/rename-layers" -Headers $headers -ContentType "application/json" -Body $body
$job
```

Review the full payload in the local-agent window and type uppercase `YES` exactly. The worker resolves all source IDs first, duplicates the document, renames by stable index path, saves a new layered PSD and PNG, and leaves the renamed PSD open. It preserves Unicode names and fails the whole job if an ID is stale, a requested name is not retained exactly, or either output exists.

## Recolor one layer safely

Inspect the open document **immediately before recoloring**. Copy the exact numeric layer ID from that fresh result; do not guess or reuse an ID after the document structure changes. Start with one test layer, review the new PSD and PNG, and only then submit a larger request.

Each recolor edit has its own RGB color, opacity, and blend mode. Allowed modes are `normal`, `color`, `multiply`, `overlay`, and `screen`. Opacity is 0 through 100 and defaults to 100.

Use this PowerShell request after replacing the sample document name, layer ID, and placeholder key:

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    edits = @(
        @{
            layerId = 123
            color = @{ red = 190; green = 20; blue = 25 }
            opacity = 100
            blendMode = "color"
        }
    )
    outputPsdName = "RWCMatchCard_ECCW_Recolor_v1.psd"
    outputPreviewName = "RWCMatchCard_ECCW_Recolor_v1.png"
} | ConvertTo-Json -Depth 6
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/recolor-layers" -Headers $headers -ContentType "application/json" -Body $body
$job
```

The relay returns HTTP 202 and a `jobId`. In the local-agent window, inspect the complete payload and type `YES` exactly. Then poll the existing job-status operation:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

Poll until `status` is `succeeded` or `failed`. Success returns the original document name, the edited PSD copy left open, per-layer IDs, names, paths and settings, both output paths, and `originalPreserved: true`.

The worker resolves every requested source ID and stable index path before editing, duplicates the source document, resolves equivalent duplicate layers by index path, merges a Color Overlay into each existing effects descriptor, saves the layered PSD, and exports the flattened PNG from a temporary duplicate.

### Recolor troubleshooting

- **Layer ID was not found uniquely:** inspect again immediately and use the new exact ID.
- **Unsupported layer:** test one ordinary pixel, text, shape, Smart Object, or group layer. Some special background, video, or 3D states may reject layer effects.
- **Multiple Color Overlay effects:** Photoshop's multi-instance Color Overlay representation is refused because rewriting it could erase or reorder existing styles. Simplify the style manually or choose another layer.
- **Other existing layer effects:** unrelated effects are retained when the Color Overlay is merged. If Photoshop cannot safely expose or reapply the style descriptor, the job fails instead of replacing it.
- **Output already exists:** increment both versioned filenames, for example from `_v1` to `_v2`. Existing output files are never overwritten.
- **Approval rejected:** queue a new job and type uppercase `YES` exactly after reviewing it.

## Update one text layer safely

Inspect the open document **immediately before planning the edit**. Text layers include a `textInfo` object without exposing Photoshop descriptors. Optional values are null when they cannot be read safely. A typical uniformly styled layer looks like:

```json
{
  "contents": "OLD TEXT",
  "textType": "TextType.POINTTEXT",
  "justification": "Justification.CENTER",
  "font": { "postScriptName": "Arial-BoldMT" },
  "size": { "value": 24, "unit": "pt" },
  "color": { "red": 255, "green": 255, "blue": 255 },
  "hasMultipleTextStyleRanges": false,
  "hasMultipleParagraphStyleRanges": false,
  "safeForContentOnlyReplacement": true,
  "unsupportedReason": null
}
```

Start with one test layer. Use only a fresh numeric layer ID whose `safeForContentOnlyReplacement` value is `true`. The worker rejects mixed character or paragraph style ranges rather than flattening their formatting.

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    edits = @(
        @{
            layerId = 123
            text = "NEW TEXT"
        }
    )
    outputPsdName = "RWCMatchCard_Text_v1.psd"
    outputPreviewName = "RWCMatchCard_Text_v1.png"
} | ConvertTo-Json -Depth 6
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/update-text-layers" -Headers $headers -ContentType "application/json" -Body $body
$job
```

The relay returns HTTP 202. Stop and review the complete request in the local-agent window, then type exact `YES`. After local approval is complete, poll:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

Success returns the original and open output document names, source/output layer IDs, full paths, previous/new text, and local PSD/PNG paths. Outputs are written to the configured working folder under the versioned names.

Text editing changes content only. It does not resize the type layer, change its bounding box, scale the font, or fit overflowing paragraph text. Review both the flattened PNG and layered PSD. Mixed-style layers, unreadable style ranges, stale IDs, and existing output filenames fail the whole job without leaving job-created output files.

An intentionally empty string is allowed to clear a supported text layer. Tabs, Unicode, spaces, and visible line breaks are retained; line endings are normalized for Photoshop.

## Optional legacy UXP panel

The `plugin/` directory and packaged `dist/` artifact contain the earlier UXP panel. The PowerShell/COM/ExtendScript agent is the current path for `recolorLayers`, `updateTextLayers`, preview export, and `renameLayers`. If the optional panel is used for its existing operations, configure its manifest network origin narrowly and load it with UXP Developer Tool.

## Development

Run relay tests with:

```powershell
Set-Location relay
npm test
```

Smart Object replacement and Color Overlay use Action Manager only where the Photoshop DOM lacks the required operation. Text updates use the DOM only after read-only style-range preflight. Preview and rename workflows use disposable document duplicates and the DOM. These behaviors require manual runtime verification against the installed Photoshop build.

Do not add generic code execution, raw batch operations, arbitrary paths, a generic filesystem interface, or shell/process access.
