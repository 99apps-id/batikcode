# Server installation script

$TMP_DIR="$env:TEMP\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_COMMIT="%%DISTRO_COMMIT%%"

$SERVER_APP_NAME="%%SERVER_APP_NAME%%"
$SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
$SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
$SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
$SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
$SERVER_DIR="$SERVER_DATA_DIR\bin\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\bin\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.token"
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL="%%SERVER_DOWNLOAD_URL%%"
$SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"
$AGENT_HOST_PIPE="\\.\pipe\batikcode-agent-host-$($DISTRO_COMMIT.Substring(0, [Math]::Min(12, $DISTRO_COMMIT.Length)))"

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
  "%%SCRIPT_ID%%: start"
  "exitCode==$code=="
  "listeningOn==$LISTENING_ON=="
  "connectionToken==$SERVER_CONNECTION_TOKEN=="
  "logFile==$SERVER_LOGFILE=="
  "osReleaseId==$OS_RELEASE_ID=="
  "arch==$ARCH=="
  "platform==$PLATFORM=="
  "tmpDir==$TMP_DIR=="
%%ENV_VAR_LINES%%
  "%%SCRIPT_ID%%: end"
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
if(($ARCH -ne "AMD64") -and ($ARCH -ne "IA64") -and ($ARCH -ne "ARM64")) {
  "Error architecture not supported: $ARCH"
  printInstallResults 1
  exit 0
}

# Create installation folder
if(!(Test-Path $SERVER_DIR)) {
  try {
    New-Item -ItemType Directory -Path $SERVER_DIR -Force -ErrorAction SilentlyContinue | Out-Null
  } catch {
    "Error creating server install directory - $($_.ToString())"
    exit 1
  }

  if(!(Test-Path $SERVER_DIR)) {
    "Error creating server install directory"
    exit 1
  }
}

Set-Location $SERVER_DIR

# Check if server script is already installed
if(!(Test-Path $SERVER_SCRIPT)) {
  if(Test-Path "$env:USERPROFILE\batikcode-server.tar.gz") {
    Move-Item "$env:USERPROFILE\batikcode-server.tar.gz" vscode-server.tar.gz
  } else {
    Write-Output "Server tarball not found at $env:USERPROFILE\batikcode-server.tar.gz. Downloading from release..."
    try {
      Invoke-WebRequest -Uri $SERVER_DOWNLOAD_URL -OutFile vscode-server.tar.gz
    } catch {
      # Downloading some other release would install a server this client cannot
      # talk to, so surface the failure instead.
      Write-Output "Error: could not download the server from $SERVER_DOWNLOAD_URL"
      Write-Output "Build a matching server locally with 'npm run gulp vscode-reh-win32-x64', or set remote.SSH.serverDownloadUrlTemplate to a reachable release."
      exit 1
    }
  }

  if(Test-Path "vscode-server.tar.gz") {
    tar -xf vscode-server.tar.gz --strip-components 1
    Remove-Item vscode-server.tar.gz -Force -ErrorAction SilentlyContinue
  }

  if(!(Test-Path $SERVER_SCRIPT)) {
    "Error while installing the server binary"
    exit 1
  }
}
else {
  "Server script already installed in $SERVER_SCRIPT"
}

# Extract custom extensions uploaded by the local Remote SSH resolver.
$SERVER_EXTENSIONS_DIR="$SERVER_DATA_DIR\extensions"
if(Test-Path "$env:USERPROFILE\batikcode-extensions.tar.gz") {
  New-Item -ItemType Directory -Path $SERVER_EXTENSIONS_DIR -Force | Out-Null
  tar -xf "$env:USERPROFILE\batikcode-extensions.tar.gz" -C $SERVER_EXTENSIONS_DIR
  Remove-Item "$env:USERPROFILE\batikcode-extensions.tar.gz" -Force -ErrorAction SilentlyContinue
}
if(Test-Path "$env:USERPROFILE\batikcode-provider-hub.tar.gz") {
  Write-Output "Updating BatikCode Provider Hub..."
  New-Item -ItemType Directory -Path $SERVER_EXTENSIONS_DIR -Force | Out-Null
  Remove-Item "$SERVER_EXTENSIONS_DIR\batikcode.batikcode-provider-hub" -Recurse -Force -ErrorAction SilentlyContinue
  tar -xf "$env:USERPROFILE\batikcode-provider-hub.tar.gz" -C $SERVER_EXTENSIONS_DIR
  Remove-Item "$env:USERPROFILE\batikcode-provider-hub.tar.gz" -Force -ErrorAction SilentlyContinue
}

# Modify the commit in the remote server to match the local value
if(%%MODIFY_PRODUCT_JSON%%) {
  Write-Output "Will modify product.json on remote to match the commit value"
  (Get-Content -Raw "$SERVER_DIR\product.json") -replace '"commit": "[0-9a-f]+",', ('"commit": "' + $DISTRO_COMMIT + '",') |
  Set-Content -NoNewLine "$SERVER_DIR\product.json"
}

# Try to find if server is already running. Use its command line so an Agent
# Host child process cannot be mistaken for the renderer-serving process.
$SERVER_PROCESS = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -Like "$SERVER_DIR\*" -and $_.CommandLine -Match "server-main" } |
  Select-Object -First 1

if($SERVER_PROCESS -and $SERVER_PROCESS.CommandLine -NotLike "*--agent-host-path=$AGENT_HOST_PIPE*") {
  Write-Output "Restarting server to enable the remote Agent Host"
  Stop-Process -Id $SERVER_PROCESS.ProcessId -Force -ErrorAction SilentlyContinue
  $SERVER_PROCESS = $null
}

if($SERVER_PROCESS) {
  Write-Output "Server script is already running $SERVER_SCRIPT"
}
else {
  if(Test-Path $SERVER_LOGFILE) {
    Remove-Item $SERVER_LOGFILE -Force -ErrorAction SilentlyContinue
  }
  if(Test-Path $SERVER_PIDFILE) {
    Remove-Item $SERVER_PIDFILE -Force -ErrorAction SilentlyContinue
  }
  if(Test-Path $SERVER_TOKENFILE) {
    Remove-Item $SERVER_TOKENFILE -Force -ErrorAction SilentlyContinue
  }

  $SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

  $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --agent-host-path=$AGENT_HOST_PIPE --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"

  $START_ARGUMENTS = @{
    FilePath = "powershell.exe"
    WindowStyle = "hidden"
    ArgumentList = @(
      "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
    )
    PassThru = $True
  }

  $SERVER_ID = (Start-Process @START_ARGUMENTS).ID

  if($SERVER_ID) {
    [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
  }
}

if(Test-Path $SERVER_TOKENFILE) {
  $SERVER_CONNECTION_TOKEN="$(Get-Content $SERVER_TOKENFILE)"
}
else {
  "Error server token file not found $SERVER_TOKENFILE"
  printInstallResults 1
  exit 0
}

Start-Sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
  Path = $SERVER_LOGFILE
  Pattern = "Extension host agent listening on (\d+)"
}

for($I = 1; $I -le 5; $I++) {
  if(Test-Path $SERVER_LOGFILE) {
    $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

    if($GROUPS) {
      $LISTENING_ON = $GROUPS[1].Value
      break
    }
  }

  Start-Sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
  "Error server log file not found $SERVER_LOGFILE"
  printInstallResults 1
  exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
  while($True) {
    if(!(Get-Process -Id $SERVER_ID -ErrorAction SilentlyContinue)) {
      "server died, exit"
      exit 0
    }

    Start-Sleep -Seconds 30
  }
}
