# ShowParty

ShowParty is a private, locally hosted synchronized video-sharing web application built with Node.js, Express, Socket.IO, and vanilla HTML/CSS/JavaScript. It allows two people—either on the same Wi-Fi network or anywhere on the internet via **Cloudflare Tunnel**—to watch the same locally hosted `.mp4` video simultaneously with shared playback controls and real-time chat.

---

## Project Structure

```text
Show-Party/
├── server/
│   ├── server.js            # Express HTTP server, Range streaming, auth routes, and Socket.IO handlers
│   ├── authManager.js       # Room access code verification, HttpOnly sessions, rate limiting, and host role checks
│   ├── playbackManager.js   # Authoritative server-side playback state manager
│   └── tunnelLauncher.js    # Unified Node.js + Cloudflare Quick Tunnel launcher
├── public/
│   ├── index.html           # ShowParty player, room access gate, host room controls, and chat interface
│   ├── style.css            # Translucent dark UI, room gate, and responsive layout styling
│   ├── aurora.js            # Vanilla WebGL2 Aurora background shader
│   ├── aurora.css           # Aurora background container styles
│   ├── cometDial.js         # Vanilla JS + CSS spring-physics CometDial volume overlay
│   ├── cometDial.css        # CometDial styling
│   └── script.js            # Player controls, shortcuts, auth gate, host controls, chat wave, and Socket.IO sync
├── videos/
│   ├── .gitkeep
│   └── sample.mp4           # 30-second sample MP4 video for immediate testing
├── start-showparty-public.bat  # Double-click on Windows to start ShowParty + Cloudflare Quick Tunnel
├── start-showparty-local.bat   # Double-click on Windows to start ShowParty for local/Wi-Fi use only
├── .env.example             # Optional environment configuration template (ROOM_CODE, MAX_UPLOAD_MB, PORT)
├── package.json
├── .gitignore
└── README.md
```

---

## Quick Start (Stage One — Local / Same Wi-Fi)

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Place your `.mp4` videos in the `videos/` folder** (a `sample.mp4` file is already included for testing). As the host on `http://localhost:3000`, you can also drag and drop an `.mp4` file directly onto the video player or click **Add MP4 File**.

3. **Start the server locally:**
   - Double-click **`start-showparty-local.bat`**, or run:
     ```bash
     npm start
     ```

4. **Open ShowParty in your browser:**
   - **Host computer:** `http://localhost:3000` (automatically granted **Host** access without needing a room code).
   - **Second device on the same Wi-Fi:** visit `http://<HOST_IPV4>:3000` (printed in the terminal and footer) and enter the **Room Access Code** shown in the Host's top toolbar.

---

## Stage Two: Public Internet Access with Cloudflare Tunnel

Stage Two lets you host ShowParty on your Windows PC and share a temporary `https://*.trycloudflare.com` link with a friend anywhere on the internet. Your friend only needs a web browser—they do **not** need to install Node.js, Cloudflare, or any other software.

### 1. Installing `cloudflared` on Windows

`start-showparty-public.bat` automatically checks for `cloudflared.exe` in the project folder, your system `PATH`, and standard Windows installation folders.

If `cloudflared` is not yet installed on your PC, install it using either method below:

- **Option A — WinGet (Recommended on Windows 10/11):**
  Open PowerShell or Command Prompt and run:
  ```powershell
  winget install --id Cloudflare.cloudflared
  ```
- **Option B — Standalone Executable (No installer required):**
  Download [`cloudflared-windows-amd64.exe`](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe) from the official Cloudflare GitHub Releases page, rename it to `cloudflared.exe`, and place it directly inside the `Show-Party` project folder.

### 2. Starting ShowParty with Cloudflare Quick Tunnel

You can start both the ShowParty server and the Cloudflare Quick Tunnel in one step:

- **Option A — Double-Click Batch File (Recommended for Windows):**
  Double-click **`start-showparty-public.bat`** in File Explorer.
- **Option B — Terminal / npm Script:**
  ```bash
  npm run start:public
  ```

### 3. Finding & Sharing the Public URL

When `start-showparty-public.bat` (or `npm run start:public`) starts, it launches the Node.js server on `http://localhost:3000`, starts `cloudflared tunnel --url http://localhost:3000`, and prints a banner in the console once the tunnel is live:

```text
============================================================
  SHOWPARTY PUBLIC TUNNEL IS LIVE!
============================================================
  1. Host (open on your PC):     http://localhost:3000
  2. Friend (share this link):   https://example-words-here.trycloudflare.com
  3. Room Access Code:           Click "Show" or "Copy" in
                                 the header at http://localhost:3000
------------------------------------------------------------
  HOW TO STOP:
  Press Ctrl+C in this window (or close the window) to
  cleanly stop both the Cloudflare Tunnel and ShowParty.
============================================================
```

### 4. Configuring or Viewing the Room Access Code

ShowParty protects your room with a private **Room Access Code** so strangers who discover your public URL cannot view your videos, join your Socket.IO room, or use your chat.

- **Viewing or Copying the Code in the Host UI:**
  When you open `http://localhost:3000` on the host computer, look at the top toolbar:
  - Click **Show** to reveal the current Room Code, or click **Copy** to copy it to your clipboard.
  - Click **Set Code** at any time to type a custom code (4–32 characters) or leave it blank to generate a fresh random 8-character code. Changing the code immediately logs out any previously connected guests.
- **Setting a Fixed Code via `.env` (Optional):**
  Copy `.env.example` to `.env` in the project root and set `ROOM_CODE`:
  ```env
  ROOM_CODE=my-secret-watch-code
  MAX_UPLOAD_MB=2048
  PORT=3000
  ```
  If `ROOM_CODE` is left blank or `.env` is not created, ShowParty automatically generates a new random 8-character code each time the server starts.

### 5. How the Host and Friend Join

1. **How the Host Joins (`Host` Role):**
   - Open `http://localhost:3000` in your browser on the computer running the server.
   - Direct `localhost` connections are automatically recognized as the **Host** (indicated by the purple **Host** badge in the top bar).
   - Only the **Host** can upload MP4 files, delete videos from `/videos`, switch the active video from the library dropdown, or view/change the Room Access Code.
2. **How Your Friend Joins (`Guest` Role):**
   - Send your friend the `https://*.trycloudflare.com` URL and your **Room Access Code**.
   - When your friend opens the URL, they will see the **Private Watch Party** access screen.
   - Once they enter the Room Access Code, they receive an encrypted `HttpOnly` session cookie and enter the watch party as a **Guest**.
   - **Both Host and Guest** can play, pause, seek, resync, adjust their own local volume (`Up`/`Down` arrows for the CometDial overlay), toggle fullscreen (`F`), use fullscreen quick chat (`T`), send chat messages, and change their display name with `/name <username>`.

### 6. How to Stop the Server and Tunnel Cleanly

- In the **ShowParty — Public Watch Party** terminal window opened by `start-showparty-public.bat` (or `npm run start:public`), press **`Ctrl+C`** or simply **close the window**.
- Closing or stopping the launcher automatically terminates both the `cloudflared` tunnel process and the Node.js ShowParty server.

### 7. Important Limitations & Performance Notes

- **Temporary Quick Tunnel URLs:** Cloudflare Quick Tunnel (`trycloudflare.com`) generates a new random subdomain every time the tunnel starts. Whenever you restart `start-showparty-public.bat`, share the new `https://*.trycloudflare.com` link with your friend.
- **Host Upload Speed Matters:** Because the MP4 video is streamed directly from your computer through Cloudflare Tunnel to your friend's browser (`HTTP 206 Partial Content`), smooth playback depends on your internet connection's **upload speed** and the video's bitrate. If your friend experiences buffering on large high-bitrate files (e.g., 4K 60fps clips), use a 1080p or 720p H.264 `.mp4` encode.

### 8. Troubleshooting Public Access

| Symptom | Cause & Solution |
| --- | --- |
| `[ERROR] Could not find "cloudflared"` | Install `cloudflared` with `winget install --id Cloudflare.cloudflared` or place `cloudflared.exe` in the project root folder. |
| Friend sees `Server Unreachable` or `502 Bad Gateway` | Make sure the `start-showparty-public.bat` window is still open and the Node.js server is running on port `3000`. If you restarted the script, send your friend the **new** `https://*.trycloudflare.com` URL. |
| Friend gets `Too many failed attempts` | Brute-force protection locks out an IP for 5 minutes after 5 wrong room code guesses. Wait 5 minutes or restart the server to reset the rate limiter. |
| Host sees the Room Code prompt instead of `Host` badge | Open `http://localhost:3000` on the host PC rather than the `https://*.trycloudflare.com` link (traffic through the Cloudflare Tunnel is treated as external visitor traffic). |

---

## Finding Your Host IPv4 Address on Windows (`ipconfig`)

For local Wi-Fi sessions without Cloudflare Tunnel, the server prints your local network URL on startup. You can also check it manually:

1. Open **Command Prompt** or **PowerShell** and run:
   ```powershell
   ipconfig
   ```
2. Look under **Wireless LAN adapter Wi-Fi** (or **Ethernet adapter**) for **IPv4 Address** (e.g., `192.168.1.140`).
3. On the second device on the same Wi-Fi network, open `http://<YOUR_IPV4_ADDRESS>:3000`.

---

## Allowing Node.js Through Windows Firewall (Local Wi-Fi Only)

*(Note: Cloudflare Quick Tunnel makes an outbound connection from your PC, so you do **not** need to open any router ports or firewall rules for Cloudflare Tunnel. The steps below only apply if a second device on your home Wi-Fi cannot connect directly to `http://<YOUR_IPV4_ADDRESS>:3000`.)*

```powershell
New-NetFirewallRule -DisplayName "ShowParty Node Server (Port 3000)" -Direction Inbound -LocalPort 3000 -Protocol TCP -Profile Private -Action Allow
```

---

## Keyboard Shortcuts

Keyboard shortcuts work whenever the page has focus and you are not typing in an input or modal dialog:

| Key | Action | Synchronized? |
| --- | --- | --- |
| `Space` | Play / Pause | Yes (both users) |
| `Left Arrow` | Seek backward 5 seconds | Yes (both users) |
| `Right Arrow` | Seek forward 5 seconds | Yes (both users) |
| `Up Arrow` | Increase volume by 5% (opens CometDial overlay) | Local to each user |
| `Down Arrow` | Decrease volume by 5% (opens CometDial overlay) | Local to each user |
| `M` | Mute / Unmute audio | Local to each user |
| `F` | Toggle fullscreen | Local to each user |
| `Enter` | Send Chat | Local to each user |
| `T` | Open quick chat input while in fullscreen (`Enter` to send, `Esc` to close) | Sends to all users |
