$ErrorActionPreference = 'Stop'
$workerDirectory = $PSScriptRoot
$configPath = Join-Path $workerDirectory 'wrangler.jsonc'
$devVarsPath = Join-Path $workerDirectory '.dev.vars'
$secureToken = $null
$tokenPointer = [IntPtr]::Zero
$plainToken = $null

function Invoke-Wrangler {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & npx.cmd wrangler @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler command failed: wrangler $($Arguments -join ' ')"
    }
}

try {
    Set-Location $workerDirectory

    $accountId = (Read-Host 'Cloudflare account ID').Trim()
    if ($accountId -notmatch '^[a-fA-F0-9]{32}$') {
        throw 'The Cloudflare account ID must contain 32 hexadecimal characters.'
    }

    $secureToken = Read-Host 'Paste the restricted Cloudflare API token (input is hidden)' -AsSecureString
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    if ([string]::IsNullOrWhiteSpace($plainToken)) {
        throw 'The Cloudflare API token cannot be empty.'
    }

    $env:CLOUDFLARE_API_TOKEN = $plainToken
    $env:CLOUDFLARE_ACCOUNT_ID = $accountId
    $headers = @{ Authorization = "Bearer $plainToken" }
    $databaseEndpoint = "https://api.cloudflare.com/client/v4/accounts/$accountId/d1/database"
    $databaseList = Invoke-RestMethod -Method Get -Uri $databaseEndpoint -Headers $headers
    if (-not $databaseList.success) {
        throw 'Cloudflare could not list D1 databases with this token. Check its account scope and D1 Edit permission.'
    }

    $database = $databaseList.result | Where-Object { $_.name -eq 'url-shortener' } | Select-Object -First 1
    if (-not $database) {
        $createBody = @{ name = 'url-shortener'; primary_location_hint = 'enam' } | ConvertTo-Json
        $createdDatabase = Invoke-RestMethod -Method Post -Uri $databaseEndpoint -Headers $headers -ContentType 'application/json' -Body $createBody
        if (-not $createdDatabase.success) {
            throw 'Cloudflare did not create the D1 database.'
        }
        $database = $createdDatabase.result
        Write-Host "Created D1 database: $($database.name)"
    }
    else {
        Write-Host "Reusing D1 database: $($database.name)"
    }

    if ($database.uuid -notmatch '^[a-fA-F0-9-]{36}$') {
        throw 'Cloudflare returned an unexpected D1 database ID.'
    }

    $config = Get-Content -LiteralPath $configPath -Raw
    if ($config.Contains('REPLACE_WITH_D1_DATABASE_ID')) {
        $config = $config.Replace('REPLACE_WITH_D1_DATABASE_ID', $database.uuid)
        Set-Content -LiteralPath $configPath -Value $config -NoNewline -Encoding utf8
    }
    elseif ($config -notmatch [regex]::Escape($database.uuid)) {
        throw "wrangler.jsonc already points to a different database. Expected $($database.uuid)."
    }

    if (-not (Test-Path -LiteralPath $devVarsPath)) {
        $secretBytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $random.GetBytes($secretBytes)
        }
        finally {
            $random.Dispose()
        }
        $shortCodeSecret = [Convert]::ToBase64String($secretBytes)
        [IO.File]::WriteAllText($devVarsPath, "SHORT_CODE_SECRET=$shortCodeSecret`n", [Text.UTF8Encoding]::new($false))
        [Array]::Clear($secretBytes, 0, $secretBytes.Length)
        Write-Host 'Generated and saved a private 32-byte short-code secret in cloudflare-worker/.dev.vars (ignored by Git). Keep this file for future deployments.'
    }

    $secretLine = Get-Content -LiteralPath $devVarsPath | Where-Object { $_ -match '^SHORT_CODE_SECRET=' } | Select-Object -Last 1
    if (-not $secretLine) {
        $secretBytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $random.GetBytes($secretBytes)
        }
        finally {
            $random.Dispose()
        }
        $shortCodeSecret = [Convert]::ToBase64String($secretBytes)
        Add-Content -LiteralPath $devVarsPath -Value "SHORT_CODE_SECRET=$shortCodeSecret" -Encoding utf8
        [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    }
    else {
        $shortCodeSecret = $secretLine -replace '^SHORT_CODE_SECRET=', ''
    }
    if ([Text.Encoding]::UTF8.GetByteCount($shortCodeSecret) -lt 32) {
        throw 'SHORT_CODE_SECRET in .dev.vars must be at least 32 bytes. Keep this value stable after links have been created.'
    }

    Invoke-Wrangler -Arguments @('d1', 'migrations', 'apply', 'url-shortener', '--remote')
    $shortCodeSecret | & npx.cmd wrangler secret put SHORT_CODE_SECRET
    if ($LASTEXITCODE -ne 0) {
        throw 'Wrangler could not upload SHORT_CODE_SECRET.'
    }
    Invoke-Wrangler -Arguments @('deploy')

    Write-Host ''
    Write-Host 'Deployment finished. Copy the workers.dev URL above and set it as BACKEND_API_URL in the Vercel project, then redeploy the frontend.'
}
finally {
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    $plainToken = $null
    $shortCodeSecret = $null
    if ($tokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    if ($secureToken) {
        $secureToken.Dispose()
    }
}
