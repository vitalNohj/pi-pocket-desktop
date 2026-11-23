param(
    [Parameter(Mandatory)] [string] $Artifacts
)

$ErrorActionPreference = 'Stop'
$setup = @(Get-ChildItem -LiteralPath $Artifacts -Filter 'pi-pocket-gui-win-*.exe' -File)
if ($setup.Count -ne 1) { throw "Expected one Windows installer, found $($setup.Count)." }

$root = Join-Path $env:RUNNER_TEMP "pi-pocket-smoke-$([Guid]::NewGuid().ToString('N'))"
$install = Join-Path $root 'Pi Pocket'
$env:PI_POCKET_GUI_USER_DATA = Join-Path $root 'desktop'
$data = Join-Path $root 'server-data'
$port = 18787
$devToolsPort = 19333
New-Item -ItemType Directory -Path $env:PI_POCKET_GUI_USER_DATA | Out-Null
@{ local = @{ port = $port; data = $data; folder = $root } } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $env:PI_POCKET_GUI_USER_DATA 'config.json') -Encoding utf8

try {
    # NSIS requires /D= last and unquoted, even when the path contains spaces.
    $setupProcess = Start-Process -FilePath $setup[0].FullName -ArgumentList '/S', '--currentuser', "/D=$install" -Wait -PassThru
    if ($setupProcess.ExitCode -ne 0) { throw "Setup exited with $($setupProcess.ExitCode)." }
    $exe = Join-Path $install 'pi-pocket-gui.exe'
    $uninstaller = @(Get-ChildItem -LiteralPath $install -Filter 'Uninstall *.exe' -File)
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or $uninstaller.Count -ne 1) {
        throw 'Setup did not install the app and its uninstaller.'
    }
    Write-Host 'The NSIS installer completed silently.'

    # No new app mode: use the same Install button and sign-in flow as a normal first run.
    $desktop = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$devToolsPort" -WorkingDirectory $root -PassThru
    node (Join-Path $PSScriptRoot 'windows-smoke.mjs') $port $devToolsPort
    if ($LASTEXITCODE -ne 0) { throw 'The desktop app smoke check failed.' }

    if ($desktop.HasExited) { throw 'The app must still be running when the uninstaller starts.' }
    $uninstallProcess = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList '/S' -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstallProcess.ExitCode)." }
    if (-not $desktop.WaitForExit(15000)) { throw 'The uninstaller left the desktop app running.' }
    if (Test-Path -LiteralPath $install) { throw 'The uninstaller left the installation directory.' }
    if (-not (Test-Path -LiteralPath (Join-Path $data 'config.json'))) { throw 'The uninstaller removed Pi Pocket data.' }
    Write-Host 'The silent uninstaller stopped and removed the desktop app. Pi Pocket data stays.'
} catch {
    foreach ($log in @('diagnostics.log', 'server\server.log')) {
        $path = Join-Path $env:PI_POCKET_GUI_USER_DATA $log
        if (Test-Path -LiteralPath $path) {
            Write-Host "--- $log ---"
            Get-Content -LiteralPath $path -Tail 60 | ForEach-Object { $_ -replace '([?&]token=)[^\s&]+', '$1[redacted]' }
        }
    }
    throw
}
