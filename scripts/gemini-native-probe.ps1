param(
    [ValidateRange(8, 120)][int]$Seconds = 25,
    [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows is required.' }
$candidates = @(Get-Process -Name Gemini -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq 'Gemini'
})
if ($candidates.Count -ne 1) { throw "Open one Gemini main window first; found $($candidates.Count)." }
$geminiProcess = $candidates[0]
$signature = Get-AuthenticodeSignature -LiteralPath $geminiProcess.Path
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Google LLC') {
    throw 'Expected the installed Gemini executable with a valid Google LLC signature.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'gemini-native-probe.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Xml
if ($InspectOnly) {
    [AdeGeminiProbe]::Inspect($geminiProcess.MainWindowHandle) | ConvertTo-Json
} else {
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
        throw 'Run with Windows PowerShell: powershell.exe -NoProfile -STA -File scripts/gemini-native-probe.ps1'
    }
    [AdeGeminiProbe]::Run($geminiProcess.MainWindowHandle, $Seconds) | ConvertTo-Json -Depth 4
}
