[CmdletBinding()]
param(
    [string]$EnvPath
)

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

if ([string]::IsNullOrWhiteSpace($EnvPath)) {
    $EnvPath = Join-Path $ScriptDirectory ".env"
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-BridgeLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "OK")][string]$Level = "INFO"
    )
    $stamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$stamp][$Level] $Message"
}

function Read-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Configuration file not found: $Path`nCopy .env.example to .env and edit it."
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }

        $equals = $trimmed.IndexOf("=")
        if ($equals -lt 1) { continue }

        $key = $trimmed.Substring(0, $equals).Trim()
        $value = $trimmed.Substring($equals + 1).Trim()
        if ((($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or (($value.StartsWith("'")) -and ($value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

function Require-ConfigValue {
    param([hashtable]$Config, [string]$Name)
    if (-not $Config.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Config[$Name])) {
        throw "Missing required setting '$Name' in $EnvPath"
    }
    return [string]$Config[$Name]
}

function ConvertTo-JsxStringLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    $escaped = $Value.Replace("\", "\\").Replace('"', '\"').Replace("`r", "\r").Replace("`n", "\n")
    return '"' + $escaped + '"'
}

$config = Read-DotEnv -Path $EnvPath
$relayUrl = (Require-ConfigValue -Config $config -Name "RELAY_URL").TrimEnd("/")
$deviceToken = Require-ConfigValue -Config $config -Name "PHOTOSHOP_DEVICE_TOKEN"
$workingFolder = Require-ConfigValue -Config $config -Name "WORKING_FOLDER"
$baleCcPackageFile = if ($config.ContainsKey("BALE_CC_PACKAGE_FILE")) { [string]$config["BALE_CC_PACKAGE_FILE"] } else { "" }
$baleCcGroupName = if ($config.ContainsKey("BALE_CC_GROUP_NAME")) { [string]$config["BALE_CC_GROUP_NAME"] } else { "" }
$pollSeconds = if ($config.ContainsKey("POLL_SECONDS")) { [Math]::Max(1, [int]$config["POLL_SECONDS"]) } else { 2 }

if (-not ($relayUrl -match "^https://") -and -not ($relayUrl -match "^http://(localhost|127\.0\.0\.1)(:\d+)?$")) {
    throw "RELAY_URL must use HTTPS, except localhost during local testing."
}
if ($deviceToken.Length -lt 24) { throw "PHOTOSHOP_DEVICE_TOKEN should be at least 24 characters." }
if (-not [string]::IsNullOrWhiteSpace($baleCcPackageFile)) {
    if (
        $baleCcPackageFile.Length -gt 255 -or
        $baleCcPackageFile -match '[\\/\x00-\x1f<>:"|?*]' -or
        $baleCcPackageFile.Contains("..") -or
        $baleCcPackageFile.StartsWith(".") -or
        -not $baleCcPackageFile.EndsWith(".psd", [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "BALE_CC_PACKAGE_FILE must be a plain .psd filename without a path."
    }
}
if (-not [string]::IsNullOrWhiteSpace($baleCcGroupName)) {
    if ($baleCcGroupName.Length -gt 255 -or $baleCcGroupName.IndexOf([char]0) -ge 0) {
        throw "BALE_CC_GROUP_NAME must contain 1 through 255 safe characters."
    }
}
if (-not (Test-Path -LiteralPath $workingFolder -PathType Container)) {
    New-Item -ItemType Directory -Path $workingFolder -Force | Out-Null
    Write-BridgeLog "Created working folder: $workingFolder" "OK"
}

$workerPath = Join-Path $ScriptDirectory "bridge-worker.jsx"
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) { throw "Missing worker script: $workerPath" }
$headers = @{
    "x-device-token" = $deviceToken
    "x-photoshop-bridge-agent" = "powershell-v1"
}

# The local agent, not the relay payload, is the final authority on which
# operations require typed approval. Unknown operation types fail closed.
$readOnlyJobTypes = @(
    "inspectDocument",
    "exportDocumentPreview",
    "exportLayerPreviews",
    "listMatchCardAssets",
    "planMatchCard"
)
$writeJobTypes = @(
    "replaceSmartObject",
    "recolorLayers",
    "updateTextLayers",
    "renameLayers",
    "createMatchCard",
    "updateMatchCard"
)
$baleConfigRequiredJobTypes = @("createMatchCard", "updateMatchCard")

function ConvertTo-SafeRelayResponseBody {
    param([AllowNull()][object]$Body)

    if ($null -eq $Body) { return "<empty>" }
    $safe = [string]$Body
    if ([string]::IsNullOrWhiteSpace($safe)) { return "<empty>" }

    # Relay error bodies are useful diagnostics, but they are still untrusted
    # text. Redact credential-shaped values and local paths before logging.
    if (-not [string]::IsNullOrEmpty($deviceToken)) {
        $safe = $safe.Replace($deviceToken, "[REDACTED]")
    }
    $safe = [regex]::Replace($safe, '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]')
    $safe = [regex]::Replace(
        $safe,
        '(?i)(?:"?(?:authorization|x-device-token|device[_-]?token|photoshop_device_token|gpt_action_api_key|api[_-]?key|secret)"?\s*[:=]\s*)(?:"[^"]*"|[^,\s;}]+)',
        '[REDACTED]'
    )
    $safe = [regex]::Replace(
        $safe,
        '(?i)\b(?:GPT_ACTION_API_KEY|PHOTOSHOP_DEVICE_TOKEN|DEVICE_TOKEN)\b',
        '[REDACTED_SETTING]'
    )
    $safe = [regex]::Replace($safe, '[A-Za-z]:[\\/][^"\r\n,}]*', '[local path omitted]')
    $safe = [regex]::Replace($safe, '\\\\[^\\\r\n]+\\[^"\r\n,}]*', '[local path omitted]')
    $safe = [regex]::Replace($safe, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '?')
    $safe = [regex]::Replace($safe, '\s+', ' ').Trim()

    if ($safe.Length -gt 2000) {
        $safe = $safe.Substring(0, 2000) + "...[truncated]"
    }
    return $safe
}

function Get-RelayHttpErrorDetails {
    param([Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord)

    $responseProperty = $ErrorRecord.Exception.PSObject.Properties["Response"]
    $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
    $statusCode = "unavailable"
    $bodyCandidates = @()

    if ($null -ne $response) {
        try {
            $statusProperty = $response.PSObject.Properties["StatusCode"]
            if ($null -ne $statusProperty -and $null -ne $statusProperty.Value) {
                $statusCode = [string]([int]$statusProperty.Value)
            }
        }
        catch {
            # Diagnostics must never replace the original relay exception.
        }
    }

    if ($null -ne $ErrorRecord.ErrorDetails -and
        -not [string]::IsNullOrWhiteSpace($ErrorRecord.ErrorDetails.Message)) {
        $bodyCandidates += [string]$ErrorRecord.ErrorDetails.Message
    }

    if ($null -ne $response) {
        try {
            $contentProperty = $response.PSObject.Properties["Content"]
            if ($null -ne $contentProperty -and $null -ne $contentProperty.Value) {
                $content = $contentProperty.Value
                if ($content -is [string]) {
                    $bodyCandidates += [string]$content
                }
                elseif ($null -ne $content.PSObject.Methods["ReadAsStringAsync"]) {
                    $contentTask = $content.ReadAsStringAsync()
                    $contentAwaiter = $contentTask.GetAwaiter()
                    $bodyCandidates += [string]$contentAwaiter.GetResult()
                }
            }
        }
        catch {
            # Fall through to the Windows PowerShell response stream path.
        }

        try {
            if ($null -ne $response.PSObject.Methods["GetResponseStream"]) {
                $stream = $response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = [System.IO.StreamReader]::new($stream)
                    try {
                        $bodyCandidates += [string]$reader.ReadToEnd()
                    }
                    finally {
                        $reader.Dispose()
                    }
                }
            }
        }
        catch {
            # Some response implementations expose no readable stream.
        }
    }

    $responseBody = $null
    foreach ($candidate in $bodyCandidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $responseBody = $candidate
            break
        }
    }

    return [PSCustomObject]@{
        StatusCode = $statusCode
        ResponseBody = ConvertTo-SafeRelayResponseBody -Body $responseBody
    }
}

function Invoke-Relay {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("GET", "POST")][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body = $null,
        [switch]$AllowNoContent,
        [string]$JobId = "",
        [string]$OperationType = ""
    )

    $uri = "$relayUrl$Path"
    try {
        if ($Method -eq "GET") {
            return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 65
        }
        $json = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 30 -Compress }
        return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec 65
    }
    catch {
        $responseProperty = $_.Exception.PSObject.Properties["Response"]
        $response = if ($null -ne $responseProperty) { $responseProperty.Value } else { $null }
        if ($AllowNoContent -and $null -ne $response -and [int]$response.StatusCode -eq 204) { return $null }

        $diagnostic = Get-RelayHttpErrorDetails -ErrorRecord $_
        $context = ""
        if (-not [string]::IsNullOrWhiteSpace($JobId)) { $context += "; jobId=$JobId" }
        if (-not [string]::IsNullOrWhiteSpace($OperationType)) { $context += "; operation=$OperationType" }
        Write-BridgeLog (
            "Relay request failed: HTTP status $($diagnostic.StatusCode)$context; " +
            "response body: $($diagnostic.ResponseBody)"
        ) "ERROR"
        throw
    }
}

function Complete-Job {
    param([string]$JobId, [string]$OperationType, [object]$Result)
    Invoke-Relay -Method POST -Path "/api/plugin/jobs/$([Uri]::EscapeDataString($JobId))/complete" -Body @{ result = $Result } -JobId $JobId -OperationType $OperationType | Out-Null
}

function Fail-Job {
    param([string]$JobId, [string]$OperationType, [string]$ErrorMessage)
    if ($ErrorMessage.Length -gt 3900) { $ErrorMessage = $ErrorMessage.Substring(0, 3900) }
    Invoke-Relay -Method POST -Path "/api/plugin/jobs/$([Uri]::EscapeDataString($JobId))/fail" -Body @{ error = $ErrorMessage } -JobId $JobId -OperationType $OperationType | Out-Null
}

function Invoke-PhotoshopJob {
    param([object]$Job, $Photoshop)

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("photoshop-gpt-bridge-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    try {
        $inputPath = Join-Path $tempRoot "input.json"
        $outputPath = Join-Path $tempRoot "output.json"
        $wrapperPath = Join-Path $tempRoot "run-job.jsx"

        $workerInput = @{
            type = [string]$Job.type
            payload = $Job.payload
            workingFolder = (Resolve-Path -LiteralPath $workingFolder).Path
        }
        if (-not [string]::IsNullOrWhiteSpace($baleCcPackageFile)) {
            $workerInput["baleCcPackageFile"] = $baleCcPackageFile
        }
        if (-not [string]::IsNullOrWhiteSpace($baleCcGroupName)) {
            $workerInput["baleCcGroupName"] = $baleCcGroupName
        }
        $workerInput |
            ConvertTo-Json -Depth 40 |
            Set-Content -LiteralPath $inputPath -Encoding UTF8

        $wrapperHeader = @"
#target photoshop
var BRIDGE_INPUT_PATH = $(ConvertTo-JsxStringLiteral -Value $inputPath);
var BRIDGE_OUTPUT_PATH = $(ConvertTo-JsxStringLiteral -Value $outputPath);
"@
        $workerSource = Get-Content -LiteralPath $workerPath -Raw
        ($wrapperHeader + "`r`n" + $workerSource) | Set-Content -LiteralPath $wrapperPath -Encoding UTF8

        # COM method return values participate in the PowerShell output
        # pipeline. Suppress this one so the worker result remains the sole
        # object returned by Invoke-PhotoshopJob.
        $null = $Photoshop.BringToFront()
        $null = $Photoshop.DoJavaScriptFile($wrapperPath, @(), 1)

        if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw "Photoshop completed without creating a result file." }
        $resultText = Get-Content -LiteralPath $outputPath -Raw
        if ([string]::IsNullOrWhiteSpace($resultText)) { throw "Photoshop returned an empty result." }
        $envelope = $resultText | ConvertFrom-Json
        if (-not $envelope.ok) { throw [string]$envelope.error }
        return $envelope.result
    }
    finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Confirm-WriteJob {
    param([object]$Job)
    Write-Host ""
    Write-Host "A Photoshop write job is waiting for approval:" -ForegroundColor Yellow
    Write-Host ($Job | ConvertTo-Json -Depth 20)
    Write-Host ""
    return (Read-Host "Approve this operation? Type YES to continue") -ceq "YES"
}

Write-BridgeLog "Connecting to Photoshop COM automation..."
$photoshop = New-Object -ComObject Photoshop.Application
Write-BridgeLog "Photoshop $($photoshop.Version) connected." "OK"
Write-BridgeLog "Relay: $relayUrl"
Write-BridgeLog "Working folder: $workingFolder"
Write-BridgeLog "Agent capability: powershell-v1"
if ([string]::IsNullOrWhiteSpace($baleCcPackageFile) -or [string]::IsNullOrWhiteSpace($baleCcGroupName)) {
    Write-BridgeLog "Bale CC settings are not complete; createMatchCard and updateMatchCard will fail until configured." "WARN"
}
Write-BridgeLog "Polling every $pollSeconds second(s). Press Ctrl+C to stop."

while ($true) {
    try {
        $job = Invoke-Relay -Method POST -Path "/api/plugin/jobs/claim-next" -Body @{} -AllowNoContent
        # PowerShell 5.1 can represent an HTTP 204 response as an empty string
# instead of $null.
if (
    $null -eq $job -or
    ($job -is [string] -and [string]::IsNullOrWhiteSpace($job))
) {
    Start-Sleep -Seconds $pollSeconds
    continue
}

# Guard against an unexpected relay response.
$propertyNames = @($job.PSObject.Properties.Name)

if (
    -not ($propertyNames -contains "type") -or
    -not ($propertyNames -contains "id")
) {
    Write-BridgeLog (
        "Relay returned an unexpected response: " +
        ($job | ConvertTo-Json -Depth 10 -Compress)
    ) "WARN"

    Start-Sleep -Seconds $pollSeconds
    continue
}

        $jobType = [string]$job.type
        $isReadOnlyJob = $readOnlyJobTypes -contains $jobType
        $isWriteJob = $writeJobTypes -contains $jobType
        if (-not $isReadOnlyJob -and -not $isWriteJob) {
            Fail-Job -JobId $job.id -OperationType $jobType -ErrorMessage "Unsupported operation type rejected by the local Photoshop agent: $jobType"
            Write-BridgeLog "Rejected unsupported job type: $jobType" "WARN"
            continue
        }

        if ($propertyNames -contains "executor") {
            $executor = [string]$job.executor
            if ($executor -ne "any" -and $executor -ne "powershell-v1") {
                Fail-Job -JobId $job.id -OperationType $jobType -ErrorMessage "Unexpected executor rejected by the local Photoshop agent: $executor"
                Write-BridgeLog "Rejected job for unexpected executor: $executor" "WARN"
                continue
            }
        }

        if (
            $baleConfigRequiredJobTypes -contains $jobType -and
            ([string]::IsNullOrWhiteSpace($baleCcPackageFile) -or [string]::IsNullOrWhiteSpace($baleCcGroupName))
        ) {
            Fail-Job -JobId $job.id -OperationType $jobType -ErrorMessage "BALE_CC_PACKAGE_FILE and BALE_CC_GROUP_NAME must be configured locally before running this operation."
            Write-BridgeLog "Rejected $jobType because Bale CC is not configured." "WARN"
            continue
        }

        Write-BridgeLog "Claimed $jobType job $($job.id)" "OK"
        if ($isWriteJob -and -not (Confirm-WriteJob -Job $job)) {
            Fail-Job -JobId $job.id -OperationType $jobType -ErrorMessage "Rejected by user in the local Photoshop agent."
            Write-BridgeLog "Job rejected." "WARN"
            continue
        }

        try {
            $result = Invoke-PhotoshopJob -Job $job -Photoshop $photoshop
            Complete-Job -JobId $job.id -OperationType $jobType -Result $result
            Write-BridgeLog "Completed job $($job.id)" "OK"
            Write-Host ($result | ConvertTo-Json -Depth 30)
        }
        catch {
            $message = $_.Exception.Message
            try { Fail-Job -JobId $job.id -OperationType $jobType -ErrorMessage $message } catch { Write-BridgeLog "Could not report job failure: $($_.Exception.Message)" "ERROR" }
            Write-BridgeLog "Job failed: $message" "ERROR"
        }
    }
    catch {
        Write-BridgeLog "Polling error: $($_.Exception.Message)" "ERROR"
        Start-Sleep -Seconds ([Math]::Max(5, $pollSeconds))
    }
}
