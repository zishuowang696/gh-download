<#
.SYNOPSIS
  通用 GitHub 下载器（Windows / PowerShell 版）。
  多镜像测速 + Range 校验 -> aria2 多源并行 -> 断点续传 ->（有则）sha256 校验。

.EXAMPLE
  ./gh-download.ps1 BurntSushi/ripgrep 14.1.0 -Pattern '*x86_64-pc-windows-msvc.zip' -Dir .\dl
  ./gh-download.ps1 https://github.com/<owner>/<repo>/releases/download/<tag>/<file>

.NOTES
  依赖：curl.exe（Win10+ 自带）；aria2c（推荐：winget install aria2.aria2）；gh（按 owner/repo 列资产时）。
  环境变量：EMBEDAI_MIRRORS（空格分隔，须支持 Range）、EMBEDAI_JOBS、EMBEDAI_CONN。
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Positional,
  [string[]]$Pattern,
  [string]$Dir = "."
)

$ErrorActionPreference = "Stop"

$MirrorsRaw = if ($env:EMBEDAI_MIRRORS) { $env:EMBEDAI_MIRRORS } else { "https://ghproxy.net https://ghfast.top" }
$Mirrors = $MirrorsRaw -split '\s+' | Where-Object { $_ }
$Jobs = if ($env:EMBEDAI_JOBS) { $env:EMBEDAI_JOBS } else { "4" }
$Conn = if ($env:EMBEDAI_CONN) { $env:EMBEDAI_CONN } else { "8" }
$DevNull = if ($env:OS -eq "Windows_NT") { "NUL" } else { "/dev/null" }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Push-Location $Dir
try {
  # 1) 组装资产清单：name<TAB>url
  $assets = @()
  if ($Positional.Count -eq 1 -and $Positional[0] -match '^http') {
    $u = $Positional[0]
    $assets += [pscustomobject]@{ Name = ($u -split '/')[-1]; Url = $u }
  }
  elseif ($Positional.Count -ge 2) {
    $repo = $Positional[0]; $tag = $Positional[1]
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
      $lines = & gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | [.name, .browser_download_url] | @tsv'
      foreach ($l in $lines) { $p = $l -split "`t"; $assets += [pscustomobject]@{ Name = $p[0]; Url = $p[1] } }
    }
    else {
      $json = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers @{ "User-Agent" = "gh-download" }
      foreach ($a in $json.assets) { $assets += [pscustomobject]@{ Name = $a.name; Url = $a.browser_download_url } }
    }
  }
  else {
    Write-Host "用法: gh-download.ps1 <owner/repo> <tag> [-Pattern GLOB]... [-Dir DIR]"
    Write-Host "   或: gh-download.ps1 <GitHub 下载 URL> [-Dir DIR]"
    exit 1
  }

  if ($Pattern) {
    $assets = $assets | Where-Object { $n = $_.Name; ($Pattern | Where-Object { $n -like $_ }).Count -gt 0 }
  }
  if ($assets.Count -eq 0) { Write-Host "没有匹配的资产"; exit 1 }
  Write-Host "资产数: $($assets.Count)"

  # 2) Range 校验：对第一个资产探测各镜像
  $first = $assets[0].Url
  $good = @()
  foreach ($m in $Mirrors) {
    $probe = "$($m.TrimEnd('/'))/$first"
    $code = & curl -s -o $DevNull -w "%{http_code}" -r 0-0 --max-time 20 $probe 2>$null
    if ($code -eq "206") { $good += $m; Write-Host "镜像可用(Range): $m" }
  }
  if ($good.Count -eq 0) { Write-Host "无支持 Range 的镜像，改用直连（不并行分段）"; $good = @("") }

  # 3) 组装 aria2 输入（同一文件的多个镜像放同一行、TAB 分隔 -> 视为镜像并行）
  $aria = @()
  foreach ($a in $assets) {
    $uris = @()
    foreach ($m in $good) { $uris += $(if ($m) { "$($m.TrimEnd('/'))/$($a.Url)" } else { $a.Url }) }
    $aria += ($uris -join "`t")
    $aria += "  out=$($a.Name)"
  }
  Set-Content -Path "dl.aria2" -Value ($aria -join "`n") -Encoding ASCII

  # 4) 下载
  Write-Host "开始下载 -> $((Get-Location).Path)"
  if (Get-Command aria2c -ErrorAction SilentlyContinue) {
    & aria2c -c -j $Jobs -x $Conn -s $Conn -k 1M --file-allocation=none --summary-interval=30 --console-log-level=warn -i dl.aria2
  }
  else {
    Write-Host "！未找到 aria2c —— 单连接会非常慢。安装： winget install aria2.aria2"
    foreach ($a in $assets) { & curl -L -C - --retry 5 -o $a.Name $a.Url }
  }

  # 5) 校验（若同批里有 SHA256SUMS）
  $sums = ($assets | Where-Object { $_.Name -like "SHA256SUMS*" } | Select-Object -First 1)
  if ($sums -and (Test-Path $sums.Name)) {
    Write-Host "校验 SHA256SUMS ..."
    foreach ($line in Get-Content $sums.Name) {
      if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+)$') {
        $want = $Matches[1].ToLower(); $file = $Matches[2].Trim()
        if (Test-Path $file) {
          $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
          if ($got -eq $want) { Write-Host "OK   $file" } else { Write-Host "FAIL $file" }
        }
      }
    }
  }
  else { Write-Host "（无 SHA256SUMS，跳过校验）" }

  Remove-Item -ErrorAction SilentlyContinue dl.aria2
  Write-Host "完成 -> $((Get-Location).Path)"
}
finally { Pop-Location }
