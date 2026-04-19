Add-Type -AssemblyName System.Drawing

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$icoPath = Join-Path $root 'public\favicon-KA.ico'
$pngPath = Join-Path $root 'public\favicon-KA.png'

if (-not (Test-Path $icoPath)) {
    Write-Error "ICO not found: $icoPath"
    exit 1
}

$bytes = [System.IO.File]::ReadAllBytes($icoPath)
if ($bytes.Length -lt 6) {
    Write-Error "ICO file too small to parse"
    exit 1
}

# Parse ICONDIR + ICONDIRENTRY[]
$count = [BitConverter]::ToUInt16($bytes, 4)
$entries = @()
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + ($i * 16)
    $w = $bytes[$off]
    $h = $bytes[$off + 1]
    if ($w -eq 0) { $w = 256 }
    if ($h -eq 0) { $h = 256 }
    $size = [BitConverter]::ToUInt32($bytes, $off + 8)
    $offset = [BitConverter]::ToUInt32($bytes, $off + 12)
    $entries += [pscustomobject]@{ W = $w; H = $h; Size = $size; Offset = $offset }
}

# Prefer the largest frame whose payload starts with the PNG signature;
# otherwise fall back to the largest BMP/DIB frame that System.Drawing can rasterize.
$pngSig = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
$sorted = $entries | Sort-Object -Property @{Expression = 'W'; Descending = $true}, @{Expression = 'H'; Descending = $true}

$extractedFromPng = $false
foreach ($e in $sorted) {
    $isPng = $true
    for ($j = 0; $j -lt 8; $j++) {
        if ($bytes[$e.Offset + $j] -ne $pngSig[$j]) { $isPng = $false; break }
    }
    if ($isPng) {
        Write-Host "Using embedded PNG frame $($e.W)x$($e.H) ($($e.Size) bytes)"
        $buf = New-Object byte[] $e.Size
        [Array]::Copy($bytes, $e.Offset, $buf, 0, $e.Size)
        [System.IO.File]::WriteAllBytes($pngPath, $buf)
        $extractedFromPng = $true
        break
    }
}

if (-not $extractedFromPng) {
    $fallback = $sorted | Where-Object { $_.W -le 128 } | Select-Object -First 1
    if (-not $fallback) { $fallback = $sorted | Select-Object -Last 1 }
    Write-Host "No PNG frame found; rasterising BMP frame $($fallback.W)x$($fallback.H) via GDI+"
    $icon = New-Object System.Drawing.Icon($icoPath, $fallback.W, $fallback.H)
    $bmp = $icon.ToBitmap()
    $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $icon.Dispose()
}

$info = Get-Item $pngPath
Write-Host "Wrote $($info.FullName) ($($info.Length) bytes)"
