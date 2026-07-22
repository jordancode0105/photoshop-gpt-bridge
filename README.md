# Private Custom GPT to Photoshop Bridge

This project preserves seven narrowly scoped document operations:

1. Inspect an active or exactly named open document and return its complete layer tree.
2. Replace one ID- or name-addressed Smart Object, then save a new layered PSD and PNG preview.
3. Apply allowlisted Color Overlay recolors to 1 through 25 exact layer IDs, then save a new layered PSD and flattened PNG preview.
4. Replace content in 1 through 25 uniformly styled text layers, then save a new layered PSD and flattened PNG preview.
5. Export a read-only flattened PNG preview of an open document.
6. Export read-only isolated layer PNGs or a labeled contact sheet for up to 12 exact layer IDs.
7. Rename up to 50 exact layer IDs in a new layered PSD copy and export its PNG preview.

It also exposes four high-level match-card operations: read-only local asset
inventory, read-only creation planning, transactional creation, and
manifest-driven versioned updates.

The relay and local agent do not call the OpenAI API or any other
image-generation service. A private Custom GPT calls the relay through a GPT
Action. A local PowerShell agent polls the relay and invokes a fixed
ExtendScript worker through Photoshop COM automation. For match cards, only the
private GPT's built-in ChatGPT Image Generation capability may create an
original blank raster foundation under the user's ChatGPT subscription.

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
- There are no server-side model calls, image-generation endpoints, image AI SDKs, or separate usage-based image-generation charges.
- GPT and the local agent use separate secrets.
- Request schemas reject malformed and unknown fields for all new preview and rename operations.
- Inspection and preview exports are read-only and run without a prompt. Every replacement, recolor, text-update, or rename job requires the user to type exact `YES` locally.
- Write operations duplicate the document and never intentionally modify or save over the original.
- Output names must be plain filenames. The local worker refuses to overwrite an existing PSD, PNG, or match-card manifest.
- Match-card inventory is limited to supported files in the top level of the configured working folder and never returns full local paths.
- Protected production assets are supplied local files only. The worker never generates, redraws, or substitutes competitors, logos, belts, photographs, or character art.
- Match-card creation and update are high-level transactional writes. Each requires one exact local `YES`, produces new versioned outputs, and never overwrites a prior card.
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

Follow [LOCAL_AGENT_SETUP.md](LOCAL_AGENT_SETUP.md). In brief, copy `local-agent/.env.example` to `local-agent/.env`, configure the deployed relay URL, device token, dedicated working folder, `BALE_CC_PACKAGE_FILE`, and `BALE_CC_GROUP_NAME`, open Photoshop, and start `local-agent/start-agent.cmd`.

Both `relay/.env` and `local-agent/.env` are ignored by Git. Never commit, paste, or log their contents.

## Custom GPT Action setup

In the private GPT editor:

1. Add an Action using `relay/openapi.yaml`.
2. Select API key authentication with the Bearer scheme.
3. Use `GPT_ACTION_API_KEY`, never the local device token.
4. Keep the GPT private.
5. Use `CUSTOM_GPT_INSTRUCTIONS.md` as operating guidance.
6. Enable the private GPT's built-in Image Generation capability. Do not add an image API Action or API key.

The OpenAPI document intentionally contains only caller-facing GPT operations. Local-agent endpoints are not exposed.

## Subscription-only match-card production

Match-card production deliberately separates image ideation from local file
automation. The bridge never receives an image prompt and never calls OpenAI,
Adobe Firefly Services, Stability, Replicate, Midjourney, or another image
service. No image-generation SDK or API key is used.

### Stage A — create and save a blank foundation

1. Upload a WWE or other wrestling card to the private GPT as a visual
   reference.
2. Ask the GPT to retain only broad functional concepts such as composition,
   hierarchy, empty render zones, panel geometry, lighting direction, and
   broadcast energy. It must not reproduce exact trade dress, typography,
   branding, or decorative artwork.
3. The GPT uses its built-in Image Generation capability to create a clearly
   original, unbranded blank foundation. It must contain no people, character
   renders, photographs, logos, belts, sponsors, venue marks, readable event
   text, copied typography, watermarks, or supplied production assets.
4. The GPT assigns a deterministic name such as
   `ECCW_Breakker_vs_Rage_template_bg_v1.png`.
5. Download the generated image and manually save it under that exact name in
   the top level of the configured `WORKING_FOLDER`.
6. Tell the GPT `Saved, continue.` The GPT cannot save or transfer the file and
   must stop until this checkpoint.

The foundation may contain original abstract or arena scenery, smoke,
particles, light streaks, glows, generic frames, non-branded textures, and
empty logo/title/belt/event-information zones.

### Stage B — verify, plan, and build

After the save checkpoint, the GPT calls `listPhotoshopMatchCardAssets` and
verifies the exact template and production filenames. It never invents or
substitutes a missing file. It then calls `planPhotoshopMatchCard` to validate
the proposed creation without modifying Photoshop documents. The plan reports missing
files, Bale CC availability, semantic groups, text mappings, and output names.

Every creation requires a PNG `templateBackground`, `showLogo`, at least one
text field, and all competitors implied by the layout: left plus right for a
two-competitor preset, left plus center plus right for the three-competitor
preset, and center for the single-competitor preset.

Once the plan is valid, the GPT queues one `createPhotoshopMatchCard` job. The
PowerShell window prints the complete payload. Review it and type uppercase
`YES` exactly once. Any other response rejects the job. The GPT must wait until
you confirm local approval before checking status, and it must not claim
completion until the status is `succeeded`.

Planning and creation use the same complete request body:

```json
{
  "briefName": "ECCW Breakker vs Rage",
  "canvas": { "width": 1920, "height": 1080, "resolution": 72 },
  "templateBackground": {
    "fileName": "ECCW_Breakker_vs_Rage_template_bg_v1.png",
    "fitMode": "cover"
  },
  "style": {
    "description": "premium red black white wrestling broadcast presentation",
    "primaryColor": { "red": 190, "green": 0, "blue": 28 },
    "secondaryColor": { "red": 8, "green": 8, "blue": 10 },
    "accentColor": { "red": 245, "green": 245, "blue": 242 },
    "metallicColor": { "red": 142, "green": 148, "blue": 154 },
    "layoutPreset": "two-competitor-title-center",
    "fonts": {
      "mainTitle": "Arial-BoldMT",
      "competitorNames": "Arial-BoldMT"
    }
  },
  "assets": {
    "showLogo": "ECCW.png",
    "competitorLeft": "Breakker.png",
    "competitorRight": "Rage.png",
    "beltImage": "IC_Title.png",
    "venueLogo": "MGM.png"
  },
  "text": {
    "championship": "INTERCONTINENTAL CHAMPIONSHIP",
    "competitorLeftName": "BREAKKER",
    "competitorRightName": "RAGE",
    "matchTitle": "BREAKKER\nRAGE",
    "stipulation": "FIRST TO FIVE",
    "date": "SUNDAY · JULY 20",
    "time": "2 PM EST | 1 PM CST | 7 PM GMT",
    "venue": "LIVE! FROM THE MGM GRAND ARENA IN LAS VEGAS"
  },
  "outputPsdName": "ECCW_Breakker_vs_Rage_v1.psd",
  "outputPreviewName": "ECCW_Breakker_vs_Rage_v1.png",
  "outputManifestName": "ECCW_Breakker_vs_Rage_v1.matchcard.json"
}
```

A complete versioned update request looks like:

```json
{
  "manifestFileName": "ECCW_Breakker_vs_Rage_v1.matchcard.json",
  "changes": {
    "style": {
      "accentColor": { "red": 255, "green": 210, "blue": 30 },
      "fonts": { "mainTitle": "Arial-BoldMT" }
    },
    "assets": { "competitorRight": "Rage_v2.png" },
    "text": { "stipulation": "STEEL CAGE" },
    "placements": {
      "competitorRight": {
        "coordinateSpace": "normalized",
        "x": 0.76,
        "y": 0.57,
        "scale": 1.05,
        "dropShadow": true
      }
    },
    "visibility": [{ "role": "venueLogo", "visible": false }]
  },
  "outputPsdName": "ECCW_Breakker_vs_Rage_v2.psd",
  "outputPreviewName": "ECCW_Breakker_vs_Rage_v2.png",
  "outputManifestName": "ECCW_Breakker_vs_Rage_v2.matchcard.json"
}
```

Exact inventory, planning, creation, update, approval, and polling PowerShell
commands are in [LOCAL_AGENT_SETUP.md](LOCAL_AGENT_SETUP.md).

### Required working-folder contents

Use a dedicated folder outside this repository. All input names are plain
filenames and all inputs must be top-level files; the worker does not accept
caller-provided directories, URLs, base64 data, or recursive searches.

```text
C:\Users\YOUR_NAME\Documents\PhotoshopBridge\
  BaleCC_Master.psd
  ECCW_Breakker_vs_Rage_template_bg_v1.png
  ECCW.png
  Breakker.png
  Rage.png
  IC_Title.png
  MGM.png
```

The Bale package and group are mandatory for every match card:

```dotenv
BALE_CC_PACKAGE_FILE=BaleCC_Master.psd
BALE_CC_GROUP_NAME=Bale CC
```

The package must contain exactly one group with the configured name. Creation
duplicates that group into the new card. A package document opened by the
worker is closed without saving; a saved package already open by the user is
left open.
Updates preserve the existing group and import it only when missing; they never
create a duplicate. A caller cannot disable Bale CC.

Recommended filenames use a stable project/role/name/version pattern, for
example `ECCW_show_logo_v1.png`, `Breakker_competitor_left_v1.png`, and
`ECCW_Breakker_vs_Rage_v1.matchcard.json`. Supported inventory extensions are
`.png`, `.jpg`, `.jpeg`, `.psd`, `.tif`, and `.tiff`.

### Protected asset policy

These roles are protected: `competitorLeft`, `competitorRight`,
`competitorCenter`, `showLogo`, `promotionLogo`, `championshipLogo`,
`beltImage`, `sponsorLogo`, `venueLogo`, `suppliedCharacterArtwork`, and
`suppliedPhotograph`. Every protected role must reference a real file already
present in `WORKING_FOLDER`. Only `templateBackground` may refer to an image
generated with ChatGPT's built-in capability.

Protected assets may be imported as Smart Objects, scaled, transformed,
aligned, positioned, masked, feathered, clipped, shown or hidden, or given
non-generative shadows and glows. They must never be generated, redrawn,
restyled, expanded with invented content, altered to change a person or
character, or replaced by a similar-looking logo or belt.

Role defaults place left/right competitors toward their lower corners, a
center competitor centrally, the show logo on the top-center plate, the belt
near the central title, and a venue logo in the lower event-information area.
Optional overrides use either normalized coordinates or validated pixel values
and may specify contain/cover fitting, an absolute fit-relative scale, maximum bounds, clipping or
non-generative masks, drop shadow, and outer glow.

### Hybrid editable PSD

The generated PNG is a flat raster foundation, not a fully editable design.
Photoshop builds editable production layers above it, including live text,
placed Smart Objects, panels, borders, masks, effects, and these semantic
top-level groups:

```text
00 - BALE CC
10 - TEMPLATE BACKGROUND
20 - ATMOSPHERE
30 - FRAMES AND PANELS
40 - COMPETITOR RENDERS
50 - CHAMPIONSHIP AND BELT
60 - MATCH TITLE
70 - EVENT INFORMATION
80 - SHOW LOGO
90 - FINISHING EFFECTS
```

Standard role names include `GENERATED TEMPLATE BACKGROUND`,
`FULL FRAME ATMOSPHERE`, `LOWER THIRD PANEL`, `TITLE BACKING`,
`SHOW LOGO PLATE`, `SHOW LOGO - SMART OBJECT`,
`COMPETITOR LEFT - SMART OBJECT`, `COMPETITOR RIGHT - SMART OBJECT`,
`CHAMPIONSHIP BELT - SMART OBJECT`, `CHAMPIONSHIP LABEL`,
`COMPETITOR LEFT NAME`, `COMPETITOR RIGHT NAME`, `MAIN MATCH TITLE`,
`MATCH STIPULATION`, `EVENT DATE`, `EVENT TIME`, `EVENT VENUE`,
`LOWER LIGHT STRIP`, `TOP BORDER`, `BOTTOM BORDER`, and `FINISHING GLOW`.
The workflow does not create generic `Layer 1` or `copy 2` names.

Every supplied text field becomes a live Photoshop text layer with line breaks
preserved and safe role-based defaults. Requested fonts are verified locally;
an unavailable font produces a warning and safe fallback. Text is never
rasterized or baked into the generated background.

### Outputs, manifest, and rollback

Successful creation writes a layered PSD, flattened PNG preview, and adjacent
`.matchcard.json` manifest into `WORKING_FOLDER`, then leaves the PSD open. The
manifest records schema version, plain output/input filenames, canvas, style,
Bale configuration, semantic layer roles and IDs, protected asset mappings,
text values, and creation time. It contains no secrets, user profile data, or
arbitrary local paths.

`updatePhotoshopMatchCard` uses that manifest and semantic roles to change
validated text, assets, colors, visibility, placement, or an explicitly named
template foundation. It preserves unrelated layers, live text, Smart Objects,
and Bale CC, and always writes new versioned PSD, PNG, and manifest files.

Creation and update preflight every input, Bale package/group, and output name
before Photoshop editing. On failure they close temporary/partial documents
without saving and remove job-created partial outputs where safe. Source
assets, the Bale package, the previous PSD, and prior outputs remain untouched.

### One-shot GPT prompts

Start Stage A with:

> Use this uploaded WWE card only as a broad composition reference. Generate
> an original blank ECCW-ready template with no people, logos, belts, or
> readable branding. Leave space for two renders, a top logo, central title,
> championship image, and lower event information. Use 16:9 at 1920×1080.

After manually saving the generated PNG in `WORKING_FOLDER`:

> Saved, continue. Use ECCW.png, Breakker.png, Rage.png, IC_Title.png, and
> MGM.png. Build ECCW Breakker vs Rage at 1920×1080 and show me the validated
> plan before queueing it.

For a revision:

> Update ECCW_Breakker_vs_Rage_v1.matchcard.json. Change the stipulation to
> STEEL CAGE, use Rage_v2.png for competitorRight, and write new `_v2` PSD,
> PNG, and manifest outputs. Preserve everything else.

### Match-card troubleshooting

- **Template or asset is missing:** save/copy the exact reported filename into
  the top level of `WORKING_FOLDER`, run inventory again, and never substitute
  another file silently.
- **Bale package is missing:** place the configured `BaleCC_Master.psd` in the
  folder and verify `BALE_CC_PACKAGE_FILE` spelling.
- **Bale group is missing or ambiguous:** open the package manually and ensure
  exactly one group is named exactly as `BALE_CC_GROUP_NAME`; do not ask the
  caller to disable the requirement.
- **Output already exists:** increment all three output versions. Existing
  files are never overwritten.
- **Approval was rejected:** queue a new job and type uppercase `YES` only after
  reviewing its full payload.
- **Requested font is unavailable:** review the returned warning and the safe
  fallback font; text remains editable.
- **Creation/update failed:** use the stage-specific error to correct the input
  and submit a new job. Do not reuse partial outputs.

### Updating the private GPT

After deploying the relay changes, replace the private GPT Action schema with
the complete current `relay/openapi.yaml`; do not paste only the new paths.
Confirm that the four operation IDs appear, keep Bearer authentication set to
`GPT_ACTION_API_KEY`, and leave the server origin unchanged unless the actual
deployment origin changed. Then replace the GPT's instructions with the full
contents of `CUSTOM_GPT_INSTRUCTIONS.md`, enable built-in Image Generation,
save the GPT as private, and run the two-stage test above.

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

The `plugin/` directory and packaged `dist/` artifact contain the earlier UXP panel. The PowerShell/COM/ExtendScript agent is the current path for `recolorLayers`, `updateTextLayers`, preview export, `renameLayers`, and every match-card operation. Disconnect the legacy panel before queueing match-card jobs: it does not implement the high-level operations or exact typed-`YES` contract. If it is used separately for its older operations, keep its manifest network origin narrow and load it with UXP Developer Tool. The checked-in `dist/` artifact is already tracked; it remains untouched and `dist/` is ignored for future package output.

## Development

Run relay tests with:

```powershell
Set-Location relay
npm test
```

Smart Object replacement and Color Overlay use Action Manager only where the Photoshop DOM lacks the required operation. Text updates use the DOM only after read-only style-range preflight. Preview and rename workflows use disposable document duplicates and the DOM. These behaviors require manual runtime verification against the installed Photoshop build.

Do not add generic code execution, raw batch operations, arbitrary paths, a generic filesystem interface, or shell/process access.
