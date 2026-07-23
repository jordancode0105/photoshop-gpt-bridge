[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Contract {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$agentPath = Join-Path $PSScriptRoot "agent.ps1"
$tokens = $null
$parseErrors = $null
$agentAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $agentPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "Could not parse agent.ps1 for the inventory result contract test."
}

foreach ($functionName in @("ConvertTo-JsxStringLiteral", "Invoke-PhotoshopJob", "Complete-Job")) {
    $definition = $agentAst.Find(
        {
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq $functionName
        },
        $true
    )
    if ($null -eq $definition) { throw "Missing agent function: $functionName" }
    . ([ScriptBlock]::Create($definition.Extent.Text))
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("photoshop-bridge-inventory-contract-" + [Guid]::NewGuid())
$workingFolder = Join-Path $testRoot "working"
$workerPath = Join-Path $testRoot "bridge-worker.jsx"
$baleCcPackageFile = ""
$baleCcGroupName = ""

try {
    New-Item -ItemType Directory -Path $workingFolder -Force | Out-Null
    "// Inventory contract test worker placeholder." |
        Set-Content -LiteralPath $workerPath -Encoding UTF8

    $script:workerEnvelopeJson = @'
{
  "ok": true,
  "result": {
    "assets": [],
    "baleCcConfigured": false,
    "baleCcPackageFileName": null,
    "supportedExtensions": [".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"],
    "recursive": false
  }
}
'@

    $photoshop = [PSCustomObject]@{}
    $photoshop | Add-Member -MemberType ScriptMethod -Name BringToFront -Value {
        return "COM focus return value that must not enter the result pipeline"
    }
    $photoshop | Add-Member -MemberType ScriptMethod -Name DoJavaScriptFile -Value {
        param($wrapperPath, $arguments, $dialogMode)
        $outputPath = Join-Path (Split-Path -Parent $wrapperPath) "output.json"
        $script:workerEnvelopeJson | Set-Content -LiteralPath $outputPath -Encoding UTF8
        return "COM script return value that is already suppressed"
    }

    $job = [PSCustomObject]@{
        id = "inventory-contract-job"
        type = "listMatchCardAssets"
        payload = [PSCustomObject]@{}
    }

    $result = Invoke-PhotoshopJob -Job $job -Photoshop $photoshop
    Assert-Contract -Condition ($result -is [PSCustomObject]) -Message "Inventory producer returned an array or scalar."
    Assert-Contract -Condition (-not ($result -is [array])) -Message "Inventory producer result was enumerated into an array."
    Assert-Contract -Condition (-not ($result -is [string])) -Message "Inventory producer returned a JSON string."

    $expectedProperties = @(
        "assets",
        "baleCcConfigured",
        "baleCcPackageFileName",
        "recursive",
        "supportedExtensions"
    ) | Sort-Object
    $actualProperties = @($result.PSObject.Properties.Name) | Sort-Object
    Assert-Contract -Condition ($null -eq (Compare-Object $expectedProperties $actualProperties)) -Message "Inventory result properties changed."
    Assert-Contract -Condition ($result.assets -is [array]) -Message "Inventory assets must remain an array."
    Assert-Contract -Condition ($result.baleCcConfigured -is [bool]) -Message "baleCcConfigured must remain a boolean."
    Assert-Contract -Condition ($null -eq $result.baleCcPackageFileName) -Message "Unconfigured Bale CC filename must remain null."
    Assert-Contract -Condition ($result.recursive -is [bool] -and -not $result.recursive) -Message "Inventory must remain non-recursive."
    Assert-Contract -Condition (
        (@($result.supportedExtensions) -join ",") -eq ".png,.jpg,.jpeg,.psd,.tif,.tiff"
    ) -Message "Supported extension reporting changed."

    $script:capturedCompletionBody = $null
    function Invoke-Relay {
        param(
            [string]$Method,
            [string]$Path,
            [object]$Body,
            [switch]$AllowNoContent,
            [string]$JobId,
            [string]$OperationType
        )
        $script:capturedCompletionBody = $Body
    }

    Complete-Job -JobId $job.id -OperationType $job.type -Result $result
    Assert-Contract -Condition ($null -ne $script:capturedCompletionBody) -Message "Completion body was not produced."
    Assert-Contract -Condition (
        $script:capturedCompletionBody.result -is [PSCustomObject]
    ) -Message "Completion body result is not one object."
    Assert-Contract -Condition (
        -not ($script:capturedCompletionBody.result -is [array])
    ) -Message "Completion body contains the assets array directly."

    $completionJson = $script:capturedCompletionBody | ConvertTo-Json -Depth 30 -Compress
    $roundTrip = $completionJson | ConvertFrom-Json
    Assert-Contract -Condition ($roundTrip.result -is [PSCustomObject]) -Message "Serialized completion result is not a JSON object."
    Assert-Contract -Condition (-not ($roundTrip.result -is [string])) -Message "Serialized completion result is a JSON string."
    Write-Output $completionJson
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
