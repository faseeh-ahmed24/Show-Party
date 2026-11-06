# ShowParty

ShowParty is a private, locally hosted synchronized video-sharing web application built with Node.js, Express, Socket.IO, and vanilla HTML/CSS/JavaScript. It allows two people on the same local network (or two browser windows on the same computer) to watch the same locally hosted `.mp4` video simultaneously with shared playback controls and real-time chat.

---

## Project Structure

```text
Show-Party/
├── server/
│   ├── server.js            # Express HTTP server, Range streaming, video management, and Socket.IO handlers
│   └── playbackManager.js   # Authoritative server-side playback state manager
├── public/
│   ├── index.html           # ShowParty player and real-time chat interface
│   ├── style.css            # Dark neutral, responsive player & chat styling
│   └── script.js            # Custom player controls, shortcuts, video removal, chat, and Socket.IO sync
├── videos/
│   ├── .gitkeep
│   └── sample.mp4           # 30-second sample MP4 video for immediate testing
├── package.json
├── .gitignore
└── README.md
```

---

## Installation and Startup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Place your `.mp4` videos in the `videos/` folder** (a `sample.mp4` file is already included for testing). You can also drag and drop an `.mp4` file directly onto the video player in your browser, or click **Add MP4 File**, which streams the file into the server's `videos/` folder so both users can watch it.

3. **Start the server:**

   ```bash
   npm start
   ```

4. **Open ShowParty in your browser:**
   - On the host computer: `http://localhost:3000`
   - On another device connected to the same Wi-Fi network: use the `http://<HOST_IPV4>:3000` address printed in the terminal when the server starts (also shown in the footer of the webpage).

---

## Features

### 1. Real-Time Synchronized Video Playback
- **Play, Pause, and Seek:** Synchronized across all connected browsers via Socket.IO.
- **HTTP Range Streaming (`206 Partial Content`):** Supports instant seeking and buffering without loading entire video files into memory.
- **Full Windows MP4 Filename Support:** Supports spaces, multiple periods (e.g., `lethal company video..mp4`, `video.part1.mp4`), parentheses (`My Video (2026).mp4`), hyphens, and underscores while blocking directory traversal outside `/videos`.

### 2. Video Management (Selecting & Removing Videos)
- Open the **Video file** selector in the top toolbar to choose any `.mp4` stored in `/videos`.
- Click the **Remove** button beside any video in the selector to delete it from `/videos` after confirmation.
- If you attempt to remove the video that is currently active, ShowParty displays an explicit warning. Upon confirmation, the file is deleted from `/videos`, playback stops, the current selection is cleared, and all connected users are notified.

### 3. Real-Time Chat & `/name` Command
- Connected users are automatically assigned a default username (`User 1`, `User 2`, etc.) stored authoritatively on the server.
- Send messages using the **Enter** key or **Send** button.
- Change your display name at any time using the slash command:
  ```text
  /name FireyDragon222
  ```
- Usernames are validated on the server (1–20 characters, trimmed, control characters stripped, duplicates automatically disambiguated).

---

## Finding Your Host IPv4 Address on Windows (`ipconfig`)

When the server starts, it automatically detects and prints your local network URL. You can also verify your computer's local IPv4 address manually on Windows:

1. Open **Command Prompt** or **PowerShell**.
2. Run:

   ```powershell
   ipconfig
   ```

3. Scroll to the section labeled **Wireless LAN adapter Wi-Fi** (or **Ethernet adapter** if wired).
4. Look for the line labeled **IPv4 Address** (for example, `192.168.1.140`).
5. On the second device connected to the same Wi-Fi network, open a browser and visit:

   ```text
   http://<YOUR_IPV4_ADDRESS>:3000
   ```

---

## Allowing Node.js Through Windows Firewall (Private Network)

If your second device on the same Wi-Fi network cannot reach `http://<YOUR_IPV4_ADDRESS>:3000`, Windows Defender Firewall may be blocking inbound connections to Node.js on port `3000`.

### Option A: Windows Security GUI
1. Open the Start Menu and search for **Allow an app through Windows Firewall**.
2. Click **Change settings** (requires administrator permission).
3. Find **Node.js JavaScript Runtime** in the list.
   - If it is not listed, click **Allow another app...** -> **Browse...** -> select `C:\Program Files\nodejs\node.exe` -> click **Add**.
4. Ensure the **Private** checkbox is checked next to **Node.js JavaScript Runtime**.
5. Make sure your Wi-Fi network profile in Windows Settings (**Network & internet** -> **Wi-Fi** -> your network properties) is set to **Private network** rather than Public.
6. Click **OK**.

### Option B: PowerShell (Run as Administrator)
Alternatively, you can open PowerShell as Administrator and allow inbound TCP port `3000` on Private networks:

```powershell
New-NetFirewallRule -DisplayName "ShowParty Node Server (Port 3000)" -Direction Inbound -LocalPort 3000 -Protocol TCP -Profile Private -Action Allow
```

---

## Keyboard Shortcuts

Keyboard shortcuts work whenever the page has focus and you are not typing in the chat input or interacting with a modal dialog:

| Key | Action | Synchronized? |
| --- | --- | --- |
| `Space` | Play / Pause | Yes (both users) |
| `Left Arrow` | Seek backward 5 seconds | Yes (both users) |
| `Right Arrow` | Seek forward 5 seconds | Yes (both users) |
| `Up Arrow` | Increase volume by 5% | Local to each user |
| `Down Arrow` | Decrease volume by 5% | Local to each user |
| `M` | Mute / Unmute audio | Local to each user |
| `F` | Toggle fullscreen | Local to each user |
| `Enter` | Send Chat | Local to each user |
| `X` | Open quick chat input while in fullscreen (`Enter` to send, `Esc` to close) | Sends to all users |
