# Local Photoshop Agent Setup

The local agent polls the hosted relay with a device token, requires approval for write jobs, and invokes the fixed `local-agent/bridge-worker.jsx` through Photoshop COM automation. It does not accept arbitrary scripts, shell commands, paths, or Action Manager descriptors from callers.

## Configure

1. Open Photoshop and an input PSD.
2. Copy `local-agent/.env.example` to `local-agent/.env`.
3. Set `RELAY_URL` to the HTTPS relay origin.
4. Set `PHOTOSHOP_DEVICE_TOKEN` to the same device token configured on the relay host.
5. Set `WORKING_FOLDER` to a dedicated local folder for replacement assets and output copies.
6. Set `BALE_CC_PACKAGE_FILE` to the plain filename of the mandatory Bale CC PSD, normally `BaleCC_Master.psd`.
7. Set `BALE_CC_GROUP_NAME` to the exact single group name inside that package, normally `Bale CC`.
8. Keep `POLL_SECONDS=2` unless a different polling interval is needed.

`local-agent/.env` and `relay/.env` are ignored by Git. Do not commit, paste, or log their contents.

Start the agent by double-clicking `local-agent/start-agent.cmd`, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local-agent\agent.ps1
```

The console should report the Photoshop version, relay URL, working folder,
PowerShell capability, and polling interval without printing either secret. It
warns at startup if the Bale package or group setting is incomplete.

## Match-card working folder

Match-card inputs must be files in the top level of the configured
`WORKING_FOLDER`. Do not put the working folder inside this repository, and do
not use nested paths in requests.

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

The generated template PNG must be downloaded from the private GPT and saved
here manually. Neither the relay nor the agent calls an image-generation API,
downloads a chat image, or transfers an attachment. Enable built-in Image
Generation in the private GPT; do not configure an OpenAI API key or any other
image-service credential.

Use stable role-oriented names, for example `ECCW_show_logo_v1.png`,
`Breakker_competitor_left_v1.png`, and
`ECCW_Breakker_vs_Rage_v1.matchcard.json`. Inventory supports only `.png`,
`.jpg`, `.jpeg`, `.psd`, `.tif`, and `.tiff`.

The Bale package is mandatory. It must contain exactly one group matching
`BALE_CC_GROUP_NAME`. Creation duplicates that group into the new card and
closes it without saving only when the worker opened it. A saved package already
open by the user stays open. Update preserves an existing Bale group and imports
it only when missing. The caller cannot disable this behavior.

Use only the PowerShell agent for match-card jobs. Disconnect the optional
legacy UXP panel before queueing them; that panel does not implement the
match-card operations or the typed-`YES` approval contract.

## Match-card PowerShell requests

These examples use the GPT Action bearer key because they call the same public
relay endpoints as the private GPT. Never put the device token in these
headers. The template and every production asset below must already exist in
`WORKING_FOLDER` as a top-level file.

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$relay = "https://photoshop-gpt-bridge.onrender.com"
```

### 1. Inventory local assets

Inventory is read-only, non-recursive, and requires no local `YES`. It returns
plain filenames and safe metadata, not full local paths.

```powershell
$inventory = Invoke-RestMethod `
    -Method Post `
    -Uri "$relay/api/jobs/list-match-card-assets" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body "{}"

Invoke-RestMethod -Method Get -Uri "$relay/api/jobs/$($inventory.jobId)" -Headers $headers
```

The result covers supported PNG, JPEG, PSD, and TIFF files, dimensions when
safely readable, suggested roles based only on explicit filename rules, Bale CC
package matching, and template-background suitability.

### 2. Define and validate a complete creation

The same strict body is used for planning and creation. Unknown properties,
paths, URLs, data URIs, invalid colors/canvas values, undeclared asset roles,
and caller attempts to control Bale CC are rejected.

`templateBackground`, `showLogo`, and at least one text field are mandatory.
Two-competitor layouts require `competitorLeft` and `competitorRight`; the
three-competitor layout also requires `competitorCenter`; the single-competitor
layout requires `competitorCenter`.

Canvas width/height are 320–8192 pixels, total area is at most 40,000,000
pixels, and resolution is 36–600. RGB channels are integers 0–255. Each text
value is at most 1,000 characters and the total is at most 5,000. Normalized
placement coordinates/bounds are 0–1; pixel coordinates are integers from
-16384 through 16384 and pixel bounds are positive integers up to 16384.
Placement scale is an absolute fit-relative multiplier from 0.05–10; update
patches preserve omitted placement fields, and `x` and `y` must be supplied together.

```powershell
$createBody = @{
    briefName = "ECCW Breakker vs Rage"
    canvas = @{
        width = 1920
        height = 1080
        resolution = 72
    }
    templateBackground = @{
        fileName = "ECCW_Breakker_vs_Rage_template_bg_v1.png"
        fitMode = "cover"
    }
    style = @{
        description = "premium red black white wrestling broadcast presentation"
        primaryColor = @{ red = 190; green = 0; blue = 28 }
        secondaryColor = @{ red = 8; green = 8; blue = 10 }
        accentColor = @{ red = 245; green = 245; blue = 242 }
        metallicColor = @{ red = 142; green = 148; blue = 154 }
        layoutPreset = "two-competitor-title-center"
        fonts = @{
            mainTitle = "Arial-BoldMT"
            competitorNames = "Arial-BoldMT"
            venue = "ArialMT"
        }
    }
    assets = @{
        showLogo = "ECCW.png"
        competitorLeft = "Breakker.png"
        competitorRight = "Rage.png"
        beltImage = "IC_Title.png"
        venueLogo = "MGM.png"
    }
    text = @{
        championship = "INTERCONTINENTAL CHAMPIONSHIP"
        competitorLeftName = "BREAKKER"
        competitorRightName = "RAGE"
        matchTitle = "BREAKKER`nRAGE"
        stipulation = "FIRST TO FIVE"
        date = "SUNDAY · JULY 20"
        time = "2 PM EST | 1 PM CST | 7 PM GMT"
        venue = "LIVE! FROM THE MGM GRAND ARENA IN LAS VEGAS"
    }
    placements = @{
        competitorLeft = @{
            coordinateSpace = "normalized"
            x = 0.25
            y = 0.58
            fitMode = "contain"
            scale = 1.0
            maxWidth = 0.46
            maxHeight = 0.88
            nonGenerativeMask = $true
            dropShadow = $true
        }
        competitorRight = @{
            coordinateSpace = "normalized"
            x = 0.75
            y = 0.58
            fitMode = "contain"
            scale = 1.0
            maxWidth = 0.46
            maxHeight = 0.88
            nonGenerativeMask = $true
            outerGlow = $true
        }
    }
    outputPsdName = "ECCW_Breakker_vs_Rage_v1.psd"
    outputPreviewName = "ECCW_Breakker_vs_Rage_v1.png"
    outputManifestName = "ECCW_Breakker_vs_Rage_v1.matchcard.json"
}

$createJson = $createBody | ConvertTo-Json -Depth 12

$plan = Invoke-RestMethod `
    -Method Post `
    -Uri "$relay/api/jobs/plan-match-card" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $createJson

Invoke-RestMethod -Method Get -Uri "$relay/api/jobs/$($plan.jobId)" -Headers $headers
```

Planning performs no Photoshop write and requires no local approval. Confirm
that it reports all files present, Bale CC available, the expected semantic
groups, text mappings, and unused output names before creating.

### 3. Create the match card

```powershell
$create = Invoke-RestMethod `
    -Method Post `
    -Uri "$relay/api/jobs/create-match-card" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $createJson

$create
```

The agent prints the complete high-level job. Review it, then type uppercase
`YES` exactly once. Do not poll until approval finishes. Afterward:

```powershell
Invoke-RestMethod -Method Get -Uri "$relay/api/jobs/$($create.jobId)" -Headers $headers
```

On success, the folder contains the new layered PSD, flattened PNG, and JSON
manifest, and the PSD remains open. The generated PNG foundation is a flat
raster. Production assets above it remain Smart Objects; text remains live;
panels, borders, masks, and effects remain separately editable where supported.

### 4. Create a versioned update

Update reads the prior manifest and addresses semantic roles instead of
guessing layer names. This example changes text, a supplied render, an accent
color, placement, font preference, and visibility while preserving everything
else. Place `Rage_v2.png` in `WORKING_FOLDER` before submitting it.

```powershell
$updateBody = @{
    manifestFileName = "ECCW_Breakker_vs_Rage_v1.matchcard.json"
    changes = @{
        style = @{
            accentColor = @{ red = 255; green = 210; blue = 30 }
            fonts = @{ mainTitle = "Arial-BoldMT" }
        }
        assets = @{
            competitorRight = "Rage_v2.png"
        }
        text = @{
            stipulation = "STEEL CAGE"
        }
        placements = @{
            competitorRight = @{
                coordinateSpace = "normalized"
                x = 0.76
                y = 0.57
                scale = 1.05
                maxWidth = 0.46
                maxHeight = 0.88
                dropShadow = $true
            }
        }
        visibility = @(
            @{ role = "venueLogo"; visible = $false }
        )
    }
    outputPsdName = "ECCW_Breakker_vs_Rage_v2.psd"
    outputPreviewName = "ECCW_Breakker_vs_Rage_v2.png"
    outputManifestName = "ECCW_Breakker_vs_Rage_v2.matchcard.json"
}

$update = Invoke-RestMethod `
    -Method Post `
    -Uri "$relay/api/jobs/update-match-card" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body ($updateBody | ConvertTo-Json -Depth 12)

$update
```

Review the update payload and type exact `YES`. Only after approval completes,
poll `$relay/api/jobs/$($update.jobId)`. The input manifest and prior PSD/PNG
are never overwritten.

## Match-card safety and rollback

Protected roles are `competitorLeft`, `competitorRight`, `competitorCenter`,
`showLogo`, `promotionLogo`, `championshipLogo`, `beltImage`, `sponsorLogo`,
`venueLogo`, `suppliedCharacterArtwork`, and `suppliedPhotograph`. These files
may be placed, transformed, masked, clipped, shown/hidden, or given
non-generative shadows and glows. They are never generated, redrawn, restyled,
expanded with invented pixels, or silently replaced. Only
`templateBackground` may be generated by ChatGPT, and it must be manually saved
before inventory.

Before editing, create/update validates every field, named input, Bale package
and group, manifest, and output conflict. If a later stage fails, the worker
closes job-created temporary or partial documents without saving and removes
partial outputs where safe. Source assets, the Bale package, the original
document, and prior versions remain untouched. A failure includes the stage
that needs correction.

The manifest stores schema version, plain filenames, canvas and theme, Bale
configuration, semantic layer roles/IDs, asset mappings, text values, warnings,
and creation time. It does not store tokens, secrets, user profile data, or
arbitrary local paths.

## Match-card troubleshooting

- **Generated PNG is absent:** manually save the exact deterministic filename
  into `WORKING_FOLDER`, rerun inventory, and do not claim the chat transferred
  it automatically.
- **A supplied asset is absent:** copy the exact named file into the folder.
  Never generate or substitute a replacement.
- **Bale package is absent:** verify `BALE_CC_PACKAGE_FILE` and place that PSD in
  the folder.
- **Bale group is missing or ambiguous:** ensure the package has exactly one
  group matching `BALE_CC_GROUP_NAME`; save or close any unsaved package document.
- **Output exists:** increment all three output filenames to the next version.
- **Font warning:** install the requested font or accept the reported safe
  fallback. The text layer remains editable.
- **Approval rejected:** queue a new job and type uppercase `YES` only after
  reviewing its full payload.
- **Partial-stage error:** correct the named stage/input and queue a new version;
  do not reuse any partial file.

Photoshop-specific creation and rollback behavior must be verified manually
against the installed Windows Photoshop build. Static checks cannot prove COM,
Smart Object, font, layer-effect, or renderer behavior.

## Private GPT setup and match-card test

In the private GPT editor, replace the Action schema with the complete deployed
`relay/openapi.yaml`, keep Bearer authentication configured with
`GPT_ACTION_API_KEY`, and verify that `listPhotoshopMatchCardAssets`,
`planPhotoshopMatchCard`, `createPhotoshopMatchCard`, and
`updatePhotoshopMatchCard` appear. Replace the GPT instructions with the full
contents of `CUSTOM_GPT_INSTRUCTIONS.md`, enable built-in Image Generation, and
keep the GPT private. Do not add an image-generation Action or API key.

Upload a visual reference and test Stage A with:

> Use this uploaded WWE card only as a broad composition reference. Generate
> an original blank ECCW-ready template with no people, logos, belts, or
> readable branding. Leave space for two renders, a top logo, central title,
> championship image, and lower event information. Use 16:9 at 1920×1080.

Verify that the GPT assigns a deterministic filename, tells you to save it
manually into `WORKING_FOLDER`, does not claim it transferred the image, and
stops. After saving it, test Stage B with:

> Saved, continue. Use ECCW.png, Breakker.png, Rage.png, IC_Title.png, and
> MGM.png. Show the inventory-backed validated plan before queueing one
> complete create job.

Verify that the GPT inventories exact filenames, plans without approval,
queues only after the plan, reports the job ID, asks for uppercase local `YES`,
and waits for your approval confirmation before polling.

## Preview workflow

Document and layer preview jobs are read-only, so the agent executes them without asking for `YES`. PNGs are exported into `WORKING_FOLDER`; the GPT can report their local paths but cannot see the pixels until you upload the files into the chat.

Export a flattened document preview:

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    outputPreviewName = "RWCMatchCard_preview_v1.png"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/export-document-preview" -Headers $headers -ContentType "application/json" -Body $body
```

After a fresh inspection, export candidate layers:

```powershell
$body = @{
    documentName = "RWCMatchCard.psd"
    layerIds = @(31, 53, 90)
    mode = "contact-sheet"
    marginPx = 40
    baseOutputName = "candidate_layers_v1"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/export-layer-previews" -Headers $headers -ContentType "application/json" -Body $body
```

Use `isolated-transparent` for a cropped transparent asset, `isolated-on-canvas` to retain placement on the source canvas, or `contact-sheet` for one labeled comparison image. Names are deterministic and never overwritten, so increment the version in `outputPreviewName` or `baseOutputName` for every retry. Check the job and upload its PNG output into the GPT chat for visual reasoning:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

## Layer-renaming workflow

1. Inspect the document immediately before planning names.
2. If identities are ambiguous, export candidate previews and upload them to the GPT chat.
3. Review a list of each exact ID, full path, old name, and proposed new name.
4. Queue `POST /api/jobs/rename-layers` with fresh versioned PSD and PNG names.
5. Review the complete payload in the local-agent window and type uppercase `YES` exactly.
6. After local approval, poll the job status and review the new layered PSD left open plus its PNG preview.

Example:

```powershell
$headers = @{ Authorization = "Bearer YOUR_GPT_ACTION_API_KEY" }
$body = @{
    documentName = "RWCMatchCard.psd"
    edits = @(
        @{ layerId = 100; newName = "SHOW LOGO - SMART OBJECT" }
    )
    outputPsdName = "RWCMatchCard_Renamed_v1.psd"
    outputPreviewName = "RWCMatchCard_Renamed_v1.png"
} | ConvertTo-Json -Depth 5
$job = Invoke-RestMethod -Method Post -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/rename-layers" -Headers $headers -ContentType "application/json" -Body $body
```

Role-based names such as `LOWER THIRD LIGHT STRIP`, `FULL FRAME ATMOSPHERE`, and `MAIN EVENT TITLE` improve later inspection and exact-ID workflows. The source remains untouched; the operation renames only a duplicate and fails transactionally on stale IDs or output conflicts.

## Recolor workflow

1. Queue and complete `POST /api/jobs/inspect-document` immediately before recoloring.
2. Choose one exact numeric layer ID from that fresh result for the first test.
3. Queue `POST /api/jobs/recolor-layers` with versioned `.psd` and `.png` output names.
4. Review the complete job payload printed in the agent window.
5. Type `YES` exactly to approve. Any other response rejects the job.
6. Poll `GET /api/jobs/{jobId}` with the GPT bearer token until it succeeds or fails.
7. Review the flattened PNG and the layered PSD copy left open in Photoshop before attempting more layers.

Example request:

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
```

Check the result:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

## Text-update workflow

1. Complete `POST /api/jobs/inspect-document` immediately before planning the text edit.
2. Find the exact numeric ID, current `textInfo.contents`, and `textInfo.safeForContentOnlyReplacement` value.
3. Start with one layer whose safety flag is `true`; mixed-style layers are intentionally unsupported.
4. Use fresh versioned PSD and PNG output names in `POST /api/jobs/update-text-layers`.
5. Review the complete job printed in the agent window and type uppercase `YES` exactly.
6. After local approval is complete, poll `GET /api/jobs/{jobId}` until it succeeds or fails.
7. Review the PNG and the layered PSD copy left open in Photoshop. Both files are written to `WORKING_FOLDER`.

Example:

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
```

After typing `YES`, check the result:

```powershell
Invoke-RestMethod -Method Get -Uri "https://photoshop-gpt-bridge.onrender.com/api/jobs/$($job.jobId)" -Headers $headers
```

Inspection reports `textInfo.contents`, text type, justification, uniform font/size/color when available, mixed-style flags, and a content-replacement safety flag. Optional metadata failures return null or an unsupported reason instead of failing the full inspection.

Content replacement does not resize or fit text. Longer content can overflow a paragraph box or extend off-canvas. Always test one layer first and inspect both outputs. Existing output names are never overwritten, and mixed character/paragraph styles fail instead of being flattened.

## Troubleshooting

- **No job appears:** verify the relay URL, device token, and `/health`, then confirm the relay process was not restarted (jobs are in memory).
- **Layer ID is missing or ambiguous:** the document changed after inspection. Inspect again and use the new ID.
- **Layer identity is visually ambiguous:** export `isolated-on-canvas` previews or a `contact-sheet`, wait for completion, and upload the PNG to the GPT chat before selecting a write target.
- **Preview is blank:** the layer may be empty, fully transparent, hidden by Photoshop-specific clipping/blending behavior, or dependent on unsupported context. Try `isolated-on-canvas`; otherwise inspect the PSD manually.
- **Contact-sheet labels are clipped or use fallback glyphs:** shorten unusually long names/paths or rename layers manually; font availability and text rendering vary by Photoshop installation.
- **Layer does not support the effect:** start with a conventional visible layer. Some special Photoshop layer states reject Color Overlay effects.
- **Existing effects cannot be preserved:** layers with multiple Color Overlay instances are rejected explicitly. Other effects are merged and preserved; if Photoshop cannot safely read or write the descriptor, the job fails without saving the duplicate.
- **Output exists:** use the next version number for both output filenames. The agent never overwrites an existing PSD or PNG.
- **Approval rejected:** queue a new job and type uppercase `YES` exactly after reviewing it.
- **Text layer is unsupported:** inspect `textInfo.unsupportedReason`. Mixed or unreadable style ranges must be simplified manually before using content-only replacement.
- **Text overflows:** shorten the replacement or resize/reformat manually in Photoshop; this operation never changes font size, bounds, transform, or paragraph settings.

Photoshop runtime behavior must be verified manually against the installed version. Color Overlay uses Action Manager, text updates combine read-only Action Manager style-range inspection with DOM content replacement, and preview/contact-sheet rendering depends on the installed Photoshop DOM, color modes, fonts, clipping groups, and layer effects.
