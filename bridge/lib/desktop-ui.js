const { spawn } = require("node:child_process");

function sendToCodexDesktop(text, options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Desktop UI delivery is only supported on Windows.");
  }
  const message = String(text || "");
  if (!message.trim()) throw new Error("Cannot send an empty message to Codex Desktop.");

  const env = {
    ...process.env,
    CRW_DESKTOP_TEXT_B64: Buffer.from(message, "utf16le").toString("base64"),
    CRW_DESKTOP_PROCESS_PATTERN: options.processNamePattern || "Codex|codex",
    CRW_DESKTOP_TITLE_PATTERN: options.windowTitlePattern || "Codex",
    CRW_DESKTOP_PREFER_FOREGROUND: options.preferForeground === false ? "0" : "1",
    CRW_DESKTOP_ALLOW_NON_CODEX_FOREGROUND: options.allowNonCodexForeground ? "1" : "0",
    CRW_DESKTOP_ALLOW_FOREGROUND: options.allowForegroundFallback === false ? "0" : "1",
    CRW_DESKTOP_RESTORE_CLIPBOARD: options.restoreClipboard === false ? "0" : "1",
    CRW_DESKTOP_SUBMIT_KEYS: options.submitKeys || "{ENTER}",
    CRW_DESKTOP_FOCUS_DELAY_MS: String(options.focusDelayMs || 700),
    CRW_DESKTOP_PASTE_DELAY_MS: String(options.pasteDelayMs || 250),
    CRW_DESKTOP_POST_SUBMIT_DELAY_MS: String(options.postSubmitDelayMs || 800)
  };

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      desktopDeliveryScript()
    ], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while sending message to Codex Desktop UI."));
    }, options.timeoutMs || 15000);

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim() });
      else reject(new Error((stderr || stdout || `Desktop UI delivery failed with code ${code}`).trim()));
    });
  });
}

function desktopDeliveryScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class CrwWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

function Find-CodexWindow {
  $processPattern = $env:CRW_DESKTOP_PROCESS_PATTERN
  $titlePattern = $env:CRW_DESKTOP_TITLE_PATTERN
  $windowHandles = New-Object 'System.Collections.Generic.List[System.IntPtr]'

  $callback = [CrwWin32+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [CrwWin32]::IsWindowVisible($hWnd)) { return $true }

    $windowProcessId = [uint32]0
    [CrwWin32]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId) | Out-Null
    try {
      $proc = Get-Process -Id $windowProcessId -ErrorAction Stop
    } catch {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder 512
    [CrwWin32]::GetWindowText($hWnd, $builder, $builder.Capacity) | Out-Null
    $title = $builder.ToString()

    if (($proc.ProcessName -match $processPattern) -or ($title -and $title -match $titlePattern)) {
      [void]$windowHandles.Add($hWnd)
    }
    return $true
  }

  [CrwWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  if ($windowHandles.Count -gt 0) { return $windowHandles[0] }
  return [IntPtr]::Zero
}

function Get-WindowInfo {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) {
    return @{ ProcessName = ""; Title = ""; ProcessId = 0 }
  }

  $windowProcessId = [uint32]0
  [CrwWin32]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId) | Out-Null
  $processName = ""
  try {
    $processName = (Get-Process -Id $windowProcessId -ErrorAction Stop).ProcessName
  } catch {
    $processName = ""
  }

  $builder = New-Object System.Text.StringBuilder 512
  [CrwWin32]::GetWindowText($Handle, $builder, $builder.Capacity) | Out-Null
  return @{
    ProcessName = $processName
    Title = $builder.ToString()
    ProcessId = $windowProcessId
  }
}

function Test-CodexWindow {
  param([IntPtr]$Handle)
  $info = Get-WindowInfo -Handle $Handle
  return (($info.ProcessName -match $env:CRW_DESKTOP_PROCESS_PATTERN) -or ($info.Title -and $info.Title -match $env:CRW_DESKTOP_TITLE_PATTERN))
}

$target = [IntPtr]::Zero
if ($env:CRW_DESKTOP_PREFER_FOREGROUND -eq '1') {
  $foreground = [CrwWin32]::GetForegroundWindow()
  if ($foreground -ne [IntPtr]::Zero -and (Test-CodexWindow -Handle $foreground)) {
    $target = $foreground
  } elseif ($foreground -ne [IntPtr]::Zero -and $env:CRW_DESKTOP_ALLOW_NON_CODEX_FOREGROUND -eq '1') {
    $target = $foreground
  } else {
    $info = Get-WindowInfo -Handle $foreground
    throw "Foreground window is not Codex. Put Codex Desktop in front and focus its input box. Foreground process='$($info.ProcessName)', title='$($info.Title)', pid='$($info.ProcessId)'."
  }
} else {
  $target = Find-CodexWindow
  if ($target -eq [IntPtr]::Zero -and $env:CRW_DESKTOP_ALLOW_FOREGROUND -eq '1') {
    $target = [CrwWin32]::GetForegroundWindow()
  }
}
if ($target -eq [IntPtr]::Zero) {
  throw "Could not find a Codex Desktop window, and foreground fallback is disabled."
}

$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:CRW_DESKTOP_TEXT_B64))
$submitKeys = $env:CRW_DESKTOP_SUBMIT_KEYS
$focusDelay = [int]$env:CRW_DESKTOP_FOCUS_DELAY_MS
$pasteDelay = [int]$env:CRW_DESKTOP_PASTE_DELAY_MS
$postSubmitDelay = [int]$env:CRW_DESKTOP_POST_SUBMIT_DELAY_MS
$restoreClipboard = $env:CRW_DESKTOP_RESTORE_CLIPBOARD -eq '1'
$targetInfo = Get-WindowInfo -Handle $target

[CrwWin32]::ShowWindowAsync($target, 9) | Out-Null
[CrwWin32]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds $focusDelay

$previousClipboard = $null
$hadTextClipboard = $false
try {
  $previousClipboard = Get-Clipboard -Raw
  $hadTextClipboard = $true
} catch {
  $hadTextClipboard = $false
}

Set-Clipboard -Value $text
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $pasteDelay
[System.Windows.Forms.SendKeys]::SendWait($submitKeys)
Start-Sleep -Milliseconds $postSubmitDelay

if ($restoreClipboard -and $hadTextClipboard) {
  Set-Clipboard -Value $previousClipboard
}

Write-Output "sent targetProcess=$($targetInfo.ProcessName) targetTitle=$($targetInfo.Title) targetPid=$($targetInfo.ProcessId)"
`;
}

module.exports = { sendToCodexDesktop };
