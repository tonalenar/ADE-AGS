<#
  Aceite da janela (plano computer use v2, Fase 1): N rodadas com a janela da instância isolada MINIMIZADA e N com uma
  PÁGINA PESADA aberta (scripts/bench-fixture/pesada.html: 2000 artigos, laço de 800 ms por segundo, relayout contínuo).

    pwsh scripts/window-rounds.ps1 -Exe <ade-ags.exe de debug> -Out <arquivo.json> [-Rounds 15] [-MaxActs 8] [-JevBudget 20]

  Cada rodada: criar portal → wait --idle → snapshot → type → click → wait --idle → screenshot → (às vezes) UM `act` com o
  Jev → ags portals (lê o pior lag do batimento desde a rodada anterior) → close. Sem Amazon, sem login, sem compra.
  A instância é a SUA: dados (ADE_AGS_DATA_DIR) e perfil do WebView2 próprios; nunca toca o app instalado.
  `ags` vem de $env:CARGO_TARGET_DIR\debug\ags.exe (ou -Ags). O servidor das fixtures sobe sozinho (npx tsx scripts/jev-bench.ts --serve).
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Rounds = 15,
  [int]$MaxActs = 8,
  [int]$JevBudget = 20,
  [int]$Port = 8765,
  [string]$Tag = "aceite",
  [string[]]$Modes = @("minimizada", "pesada"),
  [string]$Ags = (Join-Path $env:CARGO_TARGET_DIR "debug\ags.exe")
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'

# Servidor das fixtures.
$server = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "scripts/jev-bench.ts", "--serve", "--port", "$Port" -WorkingDirectory $root -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 30; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/pesada.html" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 } }

# A instância isolada (a nossa).
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA "ade-ags-dev-localwebview-$Tag"
$dataDir = Join-Path $env:LOCALAPPDATA "ade-ags-dev-data-$Tag"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$env:ADE_AGS_DATA_DIR = $dataDir
$appLog = [IO.Path]::ChangeExtension($Out, ".app-stderr.log")
$appCode = [IO.Path]::ChangeExtension($Out, ".app-exitcode.txt")
Remove-Item $appCode -ErrorAction SilentlyContinue
# Pelo cmd, para guardar o código de saída do app (quem fecha o app sozinho deixa o código aqui).
$wrapper = Start-Process cmd.exe -ArgumentList "/c", "`"`"$Exe`" 2> `"$appLog`" & echo %errorlevel% > `"$appCode`"`"" -PassThru -WindowStyle Hidden
$app = $null
for ($i = 0; $i -lt 40 -and -not $app; $i++) { Start-Sleep -Milliseconds 500; $app = Get-Process ([IO.Path]::GetFileNameWithoutExtension($Exe)) -ErrorAction SilentlyContinue | Select-Object -First 1 }
Start-Sleep 12
$tab = (& $Ags tab create $root --agent bash | ConvertFrom-Json).tabId
$env:ADE_TAB_ID = $tab

function Invoke-Step([string]$StepName, [scriptblock]$Block) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $text = (& $Block 2>&1 | Out-String)
  $ok = ($LASTEXITCODE -eq 0) -and ($text -notmatch '"error"')
  $errText = $null
  if (-not $ok) { $errText = ($text -replace '\s+', ' ').Trim(); if ($errText.Length -gt 400) { $errText = $errText.Substring(0, 400) } }
  [pscustomobject]@{ step = $StepName; ms = $sw.ElapsedMilliseconds; ok = $ok; error = $errText; text = $text }
}

$results = @()
$jev = 0
$acts = 0
$hwnd = $app.MainWindowHandle
[void](& $Ags portals)   # zera o pico de lag

foreach ($mode in $Modes) {
  for ($n = 1; $n -le $Rounds; $n++) {
    if ($mode -eq "minimizada") { [void][N.W]::ShowWindowAsync($hwnd, 6); Start-Sleep -Milliseconds 800 } else { [void][N.W]::ShowWindowAsync($hwnd, 9); Start-Sleep -Milliseconds 500 }
    $iconic = [N.W]::IsIconic($hwnd)
    $page = if ($mode -eq "minimizada") { "busca-botao.html" } else { "pesada.html" }
    $name = "$Tag-$mode-$n"
    $steps = @()
    $steps += Invoke-Step "create" { & $Ags portal create $name "http://127.0.0.1:$Port/$page" }
    $steps += Invoke-Step "wait" { & $Ags portal wait $name --idle --timeoutMs 15000 }
    $snap = Invoke-Step "snapshot" { & $Ags portal snapshot $name }
    $steps += $snap
    $field = $null; $button = $null
    if ($snap.ok) {
      $page_text = (($snap.text | ConvertFrom-Json).text)
      if ($page_text -match '(?m)^\s*- (?:searchbox|textbox|combobox|input)[^\n]*\[ref=(e\d+)\]') { $field = $Matches[1] }
      if ($page_text -match '(?m)^\s*- button "Buscar"[^\n]*\[ref=(e\d+)\]') { $button = $Matches[1] }
    }
    if ($field) { $steps += Invoke-Step "type" { & $Ags portal type $name "@$field" "caneca" } } else { $steps += [pscustomobject]@{ step = "type"; ms = 0; ok = $false; error = "campo de busca não achado no snapshot"; text = "" } }
    if ($button) { $steps += Invoke-Step "click" { & $Ags portal click $name "@$button" } } else { $steps += [pscustomobject]@{ step = "click"; ms = 0; ok = $false; error = "botão Buscar não achado no snapshot"; text = "" } }
    $steps += Invoke-Step "wait2" { & $Ags portal wait $name --idle --timeoutMs 15000 }
    $steps += Invoke-Step "screenshot" { & $Ags portal screenshot $name }
    $actInfo = $null
    if ($acts -lt $MaxActs -and $jev -lt ($JevBudget - 3) -and ($n % 2 -eq 0)) {
      $act = Invoke-Step "act" { & $Ags portal act $name "digite caneca na busca e aperte Buscar" --steps 2 }
      $acts++
      $queries = 0; $lag = $null
      if ($act.text -match 'consultas\\?":(\d+)') { $queries = [int]$Matches[1] }
      if ($act.text -match 'lag m\\u00e1x (\d+) ms|lag máx (\d+) ms') { $lag = [int]($Matches[1] + $Matches[2]) }
      $jev += $queries
      $steps += $act
      $actInfo = [pscustomobject]@{ queries = $queries; lagMaxMs = $lag; head = (($act.text -replace '\s+', ' ') -replace '^(.{0,160}).*$', '$1') }
    }
    $appAlive = -not $app.HasExited
    if (-not $appAlive) { Start-Sleep 1; Write-Host "O APP SAIU (código $(if (Test-Path $appCode) { (Get-Content $appCode -Raw).Trim() } else { '?' })) antes do fim da rodada $mode $n." }
    # Memória (MB) do app e dos processos do WebView2 desta instância: uma queda por falta de memória aparece como crescimento.
    $memMb = [int]((Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "msedgewebview2.exe" -and $_.CommandLine -match "localwebview-$Tag" } | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
    $appMb = if ($appAlive) { [int]($app.WorkingSet64 / 1MB) } else { 0 }
    $p = & $Ags portals | ConvertFrom-Json
    $win = $p.window
    [void](& $Ags portal close $name)
    $failed = @($steps | Where-Object { -not $_.ok })
    $results += [pscustomobject]@{
      mode = $mode; round = $n; iconic = $iconic; page = $page; appAlive = $appAlive; webviewMb = $memMb; appMb = $appMb
      # Foto com a janela minimizada não é travamento: a página não está à vista (limite conhecido, a mensagem diz o que fazer).
      timeout = [bool]($failed | Where-Object { $_.step -ne 'screenshot' -and $_.error -match 'não respondeu|parou de responder|oculta|ocupada|sem sinal|janela' })
      screenshotOk = [bool](-not ($failed | Where-Object { $_.step -eq 'screenshot' }))
      failures = @($failed | ForEach-Object { "$($_.step): $($_.error)" })
      stepMs = ($steps | ForEach-Object { "$($_.step)=$($_.ms)" }) -join " "
      lagPeakMs = $win.lagPeakMs; lastLagMs = $win.lastLagMs; hidden = $win.hidden; silentMs = $win.silentMs; bridgeTimeouts = $win.timeouts
      act = $actInfo
    }
    Write-Host ("[{0} {1}/{2}] iconic={3} falhas={4} lagPico={5} ms webview={7} MB app={8} MB passos: {6}" -f $mode, $n, $Rounds, $iconic, $failed.Count, $win.lagPeakMs, (($steps | ForEach-Object { "$($_.step)=$($_.ms)" }) -join " "), $memMb, $appMb)
    if (-not $appAlive) { break }
  }
}

[pscustomobject]@{ exe = $Exe; rounds = $Rounds; jevQueries = $jev; acts = $acts; results = $results } | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding utf8
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'jev-bench' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Resultado em $Out (consultas ao Jev: $jev, acts: $acts)"
