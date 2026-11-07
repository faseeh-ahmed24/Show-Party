/**
 * server/tunnelLauncher.js
 *
 * Starts the ShowParty Node.js server (on http://localhost:3000) and launches
 * a Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:3000`).
 *
 * Highlights the generated https://*.trycloudflare.com public URL in the
 * console and cleanly shuts down both processes when the user presses Ctrl+C
 * or closes the terminal window.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const LOCAL_URL = `http://localhost:${PORT}`;
const PROJECT_ROOT = path.join(__dirname, '..');

/**
 * Resolves the path to the `cloudflared` executable on Windows / macOS / Linux.
 * Checks:
 *   1. Local project folder (./cloudflared.exe or ./cloudflared)
 *   2. System PATH (`cloudflared`)
 *   3. Common Windows installation paths (Program Files, WinGet packages)
 *
 * @returns {string|null} Executable path or null if not found
 */
function findCloudflaredBinary() {
  // 1. Check project root directory first
  const localCandidates = [
    path.join(PROJECT_ROOT, 'cloudflared.exe'),
    path.join(PROJECT_ROOT, 'cloudflared')
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Check system PATH
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    // Not directly on PATH; continue checking common Windows install locations
  }

  // 3. Check standard Windows Program Files and WinGet locations
  const windowsCandidates = [];
  if (process.env.ProgramFiles) {
    windowsCandidates.push(path.join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'));
    windowsCandidates.push(path.join(process.env.ProgramFiles, 'Cloudflare', 'cloudflared', 'cloudflared.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    windowsCandidates.push(path.join(process.env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    const wingetDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetDir)) {
      try {
        const entries = fs.readdirSync(wingetDir);
        for (const entry of entries) {
          if (entry.toLowerCase().includes('cloudflare.cloudflared')) {
            const pkgPath = path.join(wingetDir, entry, 'cloudflared.exe');
            windowsCandidates.push(pkgPath);
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }
  }

  for (const candidate of windowsCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Checks if ShowParty is already running on localhost:PORT.
 * @returns {Promise<boolean>}
 */
function isShowPartyAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${LOCAL_URL}/api/auth/session`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Waits until the local ShowParty server responds on localhost:PORT.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForServerReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await isShowPartyAlreadyRunning();
    if (ready) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('============================================================');
  console.log('  ShowParty — Public Watch Party Launcher (Cloudflare Tunnel)');
  console.log('============================================================\n');

  const cloudflaredBin = findCloudflaredBinary();
  if (!cloudflaredBin) {
    console.error('[ERROR] Could not find "cloudflared" on this computer.\n');
    console.error('To install Cloudflare Tunnel on Windows, run this command in PowerShell:');
    console.error('  winget install --id Cloudflare.cloudflared\n');
    console.error('Or download cloudflared-windows-amd64.exe from:');
    console.error('  https://github.com/cloudflare/cloudflared/releases/latest');
    console.error('and place it in this folder as "cloudflared.exe".\n');
    process.exit(1);
  }

  let serverChild = null;
  const alreadyRunning = await isShowPartyAlreadyRunning();

  if (alreadyRunning) {
    console.log(`[1/2] ShowParty server is already running at ${LOCAL_URL}`);
  } else {
    console.log(`[1/2] Starting ShowParty Node.js server at ${LOCAL_URL}...`);
    serverChild = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env }
    });

    serverChild.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`\n[ShowParty] Server process exited (code ${code}). Stopping tunnel...`);
        cleanupAndExit(code || 1);
      }
    });

    const ready = await waitForServerReady(10000);
    if (!ready) {
      console.error('[ERROR] ShowParty server did not respond on port 3000 within 10 seconds.');
      cleanupAndExit(1);
      return;
    }
  }

  console.log(`[2/2] Starting Cloudflare Quick Tunnel (-> ${LOCAL_URL})...\n`);

  const tunnelChild = spawn(
    cloudflaredBin,
    ['tunnel', '--url', LOCAL_URL, '--no-autoupdate'],
    {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let publicUrlDisplayed = false;
  let shuttingDown = false;

  function handleTunnelOutput(chunk) {
    const text = chunk.toString('utf8');

    // Match the generated https://<random-words>.trycloudflare.com URL
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrlDisplayed) {
      publicUrlDisplayed = true;
      const publicUrl = match[0];

      console.log('\n============================================================');
      console.log('  SHOWPARTY PUBLIC TUNNEL IS LIVE!');
      console.log('============================================================');
      console.log(`  1. Host (open on your PC):     ${LOCAL_URL}`);
      console.log(`  2. Friend (share this link):   ${publicUrl}`);
      console.log('  3. Room Access Code:           Click "Show" or "Copy" in');
      console.log(`                                 the header at ${LOCAL_URL}`);
      console.log('------------------------------------------------------------');
      console.log('  HOW TO STOP:');
      console.log('  Press Ctrl+C in this window (or close the window) to');
      console.log('  cleanly stop both the Cloudflare Tunnel and ShowParty.');
      console.log('============================================================\n');
    }

    // Print notable tunnel errors if any occur
    if (text.includes('ERR') || text.includes('error')) {
      process.stderr.write(`[cloudflared] ${text}`);
    }
  }

  tunnelChild.stdout.on('data', handleTunnelOutput);
  tunnelChild.stderr.on('data', handleTunnelOutput);

  tunnelChild.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`\n[cloudflared] Tunnel process exited (code ${code}).`);
      cleanupAndExit(code || 0);
    }
  });

  function cleanupAndExit(exitCode = 0) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\nShutting down ShowParty and Cloudflare Tunnel...');

    try {
      if (tunnelChild && !tunnelChild.killed) {
        tunnelChild.kill('SIGTERM');
      }
    } catch {}

    try {
      if (serverChild && !serverChild.killed) {
        serverChild.kill('SIGTERM');
      }
    } catch {}

    setTimeout(() => {
      process.exit(exitCode);
    }, 300);
  }

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
}

main().catch((err) => {
  console.error('Unexpected error in tunnelLauncher:', err);
  process.exit(1);
});
