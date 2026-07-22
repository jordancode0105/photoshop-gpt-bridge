# Local Photoshop Agent Setup

The local agent polls the hosted relay with a device token, requires approval for write jobs, and invokes the fixed `local-agent/bridge-worker.jsx` through Photoshop COM automation. It does not accept arbitrary scripts, shell commands, paths, or Action Manager descriptors from callers.

## Configure

1. Open Photoshop and an input PSD.
2. Copy `local-agent/.env.example` to `local-agent/.env`.
3. Set `RELAY_URL` to the HTTPS relay origin.
4. Set `PHOTOSHOP_DEVICE_TOKEN` to the same device token configured on the relay host.
5. Set `WORKING_FOLDER` to a dedicated local folder for replacement assets and output copies.
6. Keep `POLL_SECONDS=2` unless a different polling interval is needed.

`local-agent/.env` and `relay/.env` are ignored by Git. Do not commit, paste, or log their contents.

Start the agent by double-clicking `local-agent/start-agent.cmd`, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local-agent\agent.ps1
```

The console should report the Photoshop version, relay URL, working folder, and polling interval.

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
