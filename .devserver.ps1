param(
    [string]$Root = (Join-Path $PSScriptRoot 'sites\main-platform'),
    [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.mjs'  = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2'= 'font/woff2'
    '.ttf'  = 'font/ttf'
    '.otf'  = 'font/otf'
    '.txt'  = 'text/plain; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
}

$rootResolved = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$prefixes = @("http://localhost:$Port/", "http://127.0.0.1:$Port/", "http://[::1]:$Port/")
foreach ($p in $prefixes) {
    try { $listener.Prefixes.Add($p) } catch { Write-Host "Skipping prefix ${p}: $($_.Exception.Message)" }
}
$listener.Start()

Write-Host "Serving $rootResolved at:"
foreach ($p in $listener.Prefixes) { Write-Host "  $p" }
Write-Host "(Ctrl+C to stop)"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            $rel = [System.Web.HttpUtility]::UrlDecode($req.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
            $path = Join-Path $rootResolved $rel
            $full = [System.IO.Path]::GetFullPath($path)

            if (-not $full.StartsWith($rootResolved, [StringComparison]::OrdinalIgnoreCase)) {
                $res.StatusCode = 403
            } elseif (Test-Path -LiteralPath $full -PathType Container) {
                $idx = Join-Path $full 'index.html'
                if (Test-Path -LiteralPath $idx) { $full = $idx } else { $res.StatusCode = 404 }
            }

            if ($res.StatusCode -eq 200 -and (Test-Path -LiteralPath $full -PathType Leaf)) {
                $ext = [System.IO.Path]::GetExtension($full).ToLower()
                $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } elseif ($res.StatusCode -eq 200) {
                $res.StatusCode = 404
                $msg = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
                $res.OutputStream.Write($msg, 0, $msg.Length)
            }
            Write-Host ("{0} {1} -> {2}" -f $req.HttpMethod, $req.Url.AbsolutePath, $res.StatusCode)
        } catch {
            try { $res.StatusCode = 500 } catch {}
            Write-Host "ERR $($req.Url.AbsolutePath): $($_.Exception.Message)"
        } finally {
            try { $res.OutputStream.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
