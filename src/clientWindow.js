// Follows the League client window so the pick bar can sit in its corner.
// One small PowerShell loop reports the window rectangle twice a second while the bar is open.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RbWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[RbWin]::SetProcessDPIAware() | Out-Null
while ($true) {
  $p = Get-Process LeagueClientUx -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $r = New-Object RbWin+RECT
    [RbWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $min = [RbWin]::IsIconic($p.MainWindowHandle)
    [Console]::Out.WriteLine("$($r.L),$($r.T),$($r.R),$($r.B),$min")
  } else {
    [Console]::Out.WriteLine("none")
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 500
}
`;

// The script is written out as a readable .ps1 file in RuneBook's own folder and run from there
// (antivirus tools treat hidden, encoded PowerShell commands as suspicious).
// onRect({ x, y, width, height, minimized } in physical pixels) or onRect(null) when no client window.
function watchClientWindow(onRect, dir) {
  if (process.platform !== 'win32') return () => {};
  const file = path.join(dir, 'clientWindow.ps1');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== SCRIPT) fs.writeFileSync(file, SCRIPT);
  } catch { return () => {}; }
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  ps.on('error', () => {});
  let buf = '';
  let last = '';
  ps.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === last) continue;
      last = t;
      if (t === 'none') { onRect(null); continue; }
      const [l, top, r, b, min] = t.split(',');
      const x = +l, y = +top, width = +r - +l, height = +b - +top;
      if ([x, y, width, height].some(Number.isNaN)) continue;
      onRect({ x, y, width, height, minimized: min === 'True' });
    }
  });
  return () => { try { ps.kill(); } catch {} };
}

module.exports = { watchClientWindow };
