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
- **Layer does not support the effect:** start with a conventional visible layer. Some special Photoshop layer states reject Color Overlay effects.
- **Existing effects cannot be preserved:** layers with multiple Color Overlay instances are rejected explicitly. Other effects are merged and preserved; if Photoshop cannot safely read or write the descriptor, the job fails without saving the duplicate.
- **Output exists:** use the next version number for both output filenames. The agent never overwrites an existing PSD or PNG.
- **Approval rejected:** queue a new job and type uppercase `YES` exactly after reviewing it.
- **Text layer is unsupported:** inspect `textInfo.unsupportedReason`. Mixed or unreadable style ranges must be simplified manually before using content-only replacement.
- **Text overflows:** shorten the replacement or resize/reformat manually in Photoshop; this operation never changes font size, bounds, transform, or paragraph settings.

Photoshop runtime behavior must be verified manually against the installed version. Color Overlay uses Action Manager, while text updates combine read-only Action Manager style-range inspection with DOM content replacement.
