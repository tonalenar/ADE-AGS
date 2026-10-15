<#
  Build local de debug para testar mudanças sem PR nem instalador.

  Convive com o app INSTALADO (o versionado): este script só mexe no executável de debug desta árvore
  (src-tauri\target\debug\ade-ags.exe) e nunca encerra o app instalado, que roda de outro caminho.

    pwsh scripts/dev-local.ps1            # compila (frontend + Rust) e deixa pronto
    pwsh scripts/dev-local.ps1 -Run       # compila e (re)abre só a instância de debug desta árvore
    pwsh scripts/dev-local.ps1 -Run -SkipBuild

  Antes de trocar o executável guarda a versão anterior em target\debug\ade-ags-before-<hora>.exe
  (mantém as 5 últimas), para voltar atrás copiando um arquivo.
#>
param(
  [switch]$Run,
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "src-tauri"
$exe = Join-Path $tauri "target\debug\ade-ags.exe"

# Só os processos DESTA árvore: o app instalado (AppData\Local\ADE AGS) fica de fora.
function Get-DebugProcs {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $exe) }
}

# Um executável em uso não pode ser trocado: com -Run a instância de debug anterior fecha antes de compilar.
if ((-not $SkipBuild) -and (Get-DebugProcs)) {
  if (-not $Run) { throw "A instância de debug está aberta e trava o executável. Feche-a, ou use -Run para fechar e reabrir." }
  Write-Host "[dev-local] fechando a instância de debug anterior para trocar o executável…"
  Get-DebugProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

# A versão anterior do executável fica guardada ANTES de o build a trocar (as 5 últimas).
if ((-not $SkipBuild) -and (Test-Path $exe) -and -not (Get-DebugProcs)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item $exe (Join-Path (Split-Path $exe) "ade-ags-before-$stamp.exe")
  Get-ChildItem (Split-Path $exe) -Filter "ade-ags-before-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force
}

if (-not $SkipBuild) {
  Push-Location $root
  try {
    Write-Host "[dev-local] tauri build --debug --no-bundle (frontend embutido, sem instalador)…"
    bun x tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build falhou" }
  } finally { Pop-Location }
}

if ($Run) {
  $running = @(Get-DebugProcs)
  if ($running.Count -gt 0) {
    Write-Host "[dev-local] encerrando a instância de debug anterior ($($running.Count) processo(s))…"
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
  # Perfil do WebView2 PRÓPRIO: com o mesmo identificador do app instalado (e de outras instâncias de debug) o
  # perfil seria compartilhado, e o estado salvo por outra versão (abas, canvas) quebrava telas desta.
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA "ade-ags-dev-localwebview"
  Start-Process $exe
  Write-Host "[dev-local] aberto: $exe"
}
