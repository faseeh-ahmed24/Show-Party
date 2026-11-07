/**
 * server.js
 *
 * Express + Socket.IO server for ShowParty.
 * Responsibilities:
 *   1. Serve the static frontend from /public
 *   2. List, stream (HTTP 206 Partial Content), upload, and delete MP4 files in /videos
 *   3. Coordinate real-time playback synchronization across connected browsers via Socket.IO
 *   4. Manage real-time chat and server-authoritative usernames (/name command)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');
const playbackManager = require('./playbackManager');
const authManager = require('./authManager');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const VIDEOS_DIR = path.resolve(__dirname, '..', 'videos');

const MAX_USERNAME_LENGTH = 20;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const MAX_CHAT_HISTORY = 100;

// Ensure the /videos directory exists
if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

// Serve static frontend assets (index.html, style.css, script.js, aurora.js, cometDial.js)
app.use(express.static(PUBLIC_DIR));

/**
 * Security helper: validates that a requested filename is a single .mp4 filename
 * located strictly inside the /videos directory (prevents directory traversal).
 *
 * Supports valid Windows MP4 filenames including spaces, multiple periods
 * (e.g. "lethal company video..mp4", "video.part1.mp4"), parentheses, hyphens,
 * and underscores, while rejecting path separators, control characters, and
 * parent directory references.
 */
function resolveSafeVideoPath(rawFilename) {
  if (typeof rawFilename !== 'string') {
    return null;
  }

  const trimmed = rawFilename.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') {
    return null;
  }

  // Reject any forward or backward slashes (treat input strictly as a single filename, not a path)
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return null;
  }

  // Reject control characters and characters illegal in Windows filenames (< > : " | ? *)
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(trimmed)) {
    return null;
  }

  // Ensure path.basename matches the exact filename
  const baseName = path.basename(trimmed);
  if (baseName !== trimmed) {
    return null;
  }

  // Only allow .mp4 files with at least 1 character before the .mp4 extension
  if (!baseName.toLowerCase().endsWith('.mp4') || baseName.length <= 4) {
    return null;
  }

  const fullPath = path.resolve(VIDEOS_DIR, baseName);
  const relative = path.relative(VIDEOS_DIR, fullPath);

  // Verify the resolved path stays strictly inside VIDEOS_DIR
  if (
    !relative ||
    relative === '' ||
    relative === '.' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith('../') ||
    path.isAbsolute(relative) ||
    path.dirname(fullPath) !== VIDEOS_DIR
  ) {
    return null;
  }

  return {
    filename: baseName,
    fullPath
  };
}

/**
 * Helper to scan the /videos directory and return available .mp4 files with their byte sizes.
 */
function getAvailableVideos() {
  try {
    const entries = fs.readdirSync(VIDEOS_DIR, { withFileTypes: true });
    const videos = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
        const resolved = resolveSafeVideoPath(entry.name);
        if (!resolved) {
          continue;
        }
        const stats = fs.statSync(resolved.fullPath);
        videos.push({
          name: resolved.filename,
          size: stats.size
        });
      }
    }

    videos.sort((a, b) => a.name.localeCompare(b.name));
    return videos;
  } catch (error) {
    console.error('Error reading /videos directory:', error.message);
    return [];
  }
}

/**
 * Verifies that if playbackManager currently points to a videoFile that no longer
 * exists on disk, playback state is cleared cleanly.
 */
function reconcileActiveVideoWithDisk() {
  const videos = getAvailableVideos();
  const currentVideo = playbackManager.getCurrentState().videoFile;

  if (currentVideo) {
    const stillExists = videos.some((video) => video.name === currentVideo);
    if (!stillExists) {
      playbackManager.setVideo(null);
    }
  }
  return videos;
}

// On initial server startup, select the first available MP4 if one exists in /videos
(function selectInitialStartupVideo() {
  const videos = getAvailableVideos();
  if (videos.length > 0) {
    playbackManager.setVideo(videos[0].name);
  }
})();

/**
 * Helper to find local IPv4 addresses on the host computer so the host knows
 * what URL to open on a second device on the same Wi-Fi network.
 */
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({
          interface: name,
          address: net.address,
          url: `http://${net.address}:${PORT}`
        });
      }
    }
  }

  return addresses;
}

// ============================================================================
// Chat & Username Management Helpers
// ============================================================================

// Maps socket.id -> { username: string, defaultNumber: number }
const connectedUsers = new Map();
const chatHistory = [];
let chatMessageIdCounter = 0;

/**
 * Assigns the lowest available "User N" default username for a new connection.
 */
function assignDefaultUsername() {
  const usedNumbers = new Set();
  const takenNamesLower = new Set();

  for (const user of connectedUsers.values()) {
    usedNumbers.add(user.defaultNumber);
    takenNamesLower.add(user.username.toLowerCase());
  }

  let candidateNumber = 1;
  while (
    usedNumbers.has(candidateNumber) ||
    takenNamesLower.has(`user ${candidateNumber}`)
  ) {
    candidateNumber += 1;
  }

  return {
    username: `User ${candidateNumber}`,
    defaultNumber: candidateNumber
  };
}

/**
 * Validates and sanitizes a requested username for the /name command.
 * Rules:
 *   - Remove newlines and control characters
 *   - Trim and collapse extra spaces
 *   - Must be between 1 and 20 characters
 *   - Disambiguates duplicate names among currently connected users
 */
function validateAndResolveUsername(rawInput, socketId) {
  if (typeof rawInput !== 'string') {
    return { error: 'Usage: /name <username>' };
  }

  // Strip control characters (including newlines and tabs) and collapse whitespace
  const cleaned = rawInput
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { error: 'Username cannot be empty. Usage: /name <username>' };
  }

  if (cleaned.length > MAX_USERNAME_LENGTH) {
    return {
      error: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`
    };
  }

  // Check if another connected user already has this exact name (case-insensitive)
  const otherNamesLower = new Set();
  for (const [id, info] of connectedUsers.entries()) {
    if (id !== socketId) {
      otherNamesLower.add(info.username.toLowerCase());
    }
  }

  let finalName = cleaned;
  if (otherNamesLower.has(finalName.toLowerCase())) {
    let suffix = 2;
    while (suffix < 100) {
      const suffixStr = ` (${suffix})`;
      const baseMaxLen = MAX_USERNAME_LENGTH - suffixStr.length;
      const candidate = `${cleaned.slice(0, baseMaxLen)}${suffixStr}`;
      if (!otherNamesLower.has(candidate.toLowerCase())) {
        finalName = candidate;
        break;
      }
      suffix += 1;
    }
  }

  return { username: finalName };
}

/**
 * Creates a chat message object and records it in the bounded server history.
 */
function createChatMessage({ type, sender, senderId, text, persist = true }) {
  const message = {
    id: ++chatMessageIdCounter,
    type, // 'user' or 'system'
    sender: sender || 'System',
    senderId: senderId || null,
    text,
    timestamp: Date.now()
  };

  if (persist) {
    chatHistory.push(message);
    if (chatHistory.length > MAX_CHAT_HISTORY) {
      chatHistory.shift();
    }
  }

  return message;
}

// ============================================================================
// Authentication & Room Access Control Endpoints
// ============================================================================

/**
 * GET /api/auth/session
 * Returns whether the current browser session is authenticated and its role ('host' or 'guest').
 * Direct connections from localhost automatically receive a 'host' session cookie.
 */
app.get('/api/auth/session', (req, res) => {
  const auth = authManager.resolveRequestAuth(req, res);
  return res.json({
    authenticated: auth.authenticated,
    role: auth.role,
    maxUploadMB: authManager.MAX_UPLOAD_MB
  });
});

/**
 * POST /api/auth/login
 * Validates a visitor's room access code with brute-force rate limiting.
 * Sets an HttpOnly session cookie upon success.
 */
app.post('/api/auth/login', (req, res) => {
  const clientIp = authManager.getClientIp(
    req.headers,
    req.socket ? req.socket.remoteAddress : ''
  );

  const rateStatus = authManager.checkLoginRateLimit(clientIp);
  if (!rateStatus.allowed) {
    res.setHeader('Retry-After', String(rateStatus.retryAfterSeconds));
    return res.status(429).json({
      error: `Too many failed login attempts. Please wait ${rateStatus.retryAfterSeconds} seconds before trying again.`,
      retryAfterSeconds: rateStatus.retryAfterSeconds
    });
  }

  const submittedCode = req.body && typeof req.body.code === 'string' ? req.body.code : '';
  if (!authManager.verifyRoomCode(submittedCode)) {
    authManager.recordFailedLoginAttempt(clientIp);
    return res.status(401).json({
      error: 'Incorrect room access code. Please check the code shared by the host.'
    });
  }

  authManager.clearFailedLoginAttempts(clientIp);
  const existingAuth = authManager.resolveRequestAuth(req, res);
  const assignedRole = existingAuth.role === 'host' ? 'host' : 'guest';
  const sessionToken = authManager.createSession(assignedRole);
  res.setHeader('Set-Cookie', authManager.buildSessionCookieHeader(sessionToken, req));

  return res.status(200).json({
    authenticated: true,
    role: assignedRole,
    maxUploadMB: authManager.MAX_UPLOAD_MB
  });
});

/**
 * POST /api/auth/logout
 * Clears the visitor's current session cookie.
 */
app.post('/api/auth/logout', (req, res) => {
  const auth = authManager.resolveRequestAuth(req, null);
  if (auth.token) {
    authManager.removeSession(auth.token);
  }
  res.setHeader('Set-Cookie', authManager.buildClearSessionCookieHeader());
  return res.status(200).json({ success: true });
});

/**
 * GET /api/host/room-code
 * Host-only endpoint returning the current private room access code so the host
 * can copy and share it with a friend.
 */
app.get('/api/host/room-code', authManager.requireHost, (req, res) => {
  return res.json({
    roomCode: authManager.getRoomCode()
  });
});

/**
 * POST /api/host/room-code
 * Host-only endpoint allowing the host to generate a new random room code or set
 * a custom room code, revoking previous guest sessions.
 */
app.post('/api/host/room-code', authManager.requireHost, (req, res) => {
  const customCode = req.body && typeof req.body.roomCode === 'string' ? req.body.roomCode : '';
  const result = authManager.updateRoomCode(customCode, { revokeGuests: true });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  // Disconnect any currently connected guest sockets so they must re-authenticate with the new code
  for (const [, clientSocket] of io.of('/').sockets) {
    if (clientSocket.data && clientSocket.data.role === 'guest') {
      clientSocket.emit('auth-revoked', {
        message: 'The host updated the room access code. Please enter the new code to rejoin.'
      });
      clientSocket.disconnect(true);
    }
  }

  return res.status(200).json({
    roomCode: result.roomCode
  });
});

// ============================================================================
// Protected Video & Library HTTP API Endpoints
// ============================================================================

/**
 * GET /api/videos
 * Returns the list of available MP4 files in /videos, the active playback state,
 * the caller's role ('host' or 'guest'), and the host's local network URLs.
 */
app.get('/api/videos', authManager.requireAuth, (req, res) => {
  const videos = reconcileActiveVideoWithDisk();
  res.json({
    videos,
    state: playbackManager.getCurrentState(),
    role: req.userAuth.role,
    networkUrls: getLocalIPv4Addresses()
  });
});

/**
 * DELETE /api/videos/:filename
 * Host-only: Safely deletes an MP4 file from the /videos directory on the server.
 * If the deleted video was currently active, clears playback for all connected users.
 */
app.delete('/api/videos/:filename', authManager.requireHost, (req, res) => {
  const resolved = resolveSafeVideoPath(req.params.filename);
  if (!resolved) {
    return res.status(400).json({
      error: 'Invalid filename. Only .mp4 files inside /videos can be removed.'
    });
  }

  if (!fs.existsSync(resolved.fullPath)) {
    return res.status(404).json({
      error: 'Video file not found in /videos.'
    });
  }

  const currentState = playbackManager.getCurrentState();
  const wasActiveVideo = currentState.videoFile === resolved.filename;

  try {
    // If this video was currently selected/playing, clear the authoritative playback state first
    let updatedState = currentState;
    if (wasActiveVideo) {
      updatedState = playbackManager.setVideo(null);
    }

    // Delete the physical MP4 file from the /videos directory
    fs.unlinkSync(resolved.fullPath);

    const videos = getAvailableVideos();

    // Broadcast updated video list to all connected clients
    io.emit('video-list', { videos });

    // If the active video was deleted, stop playback and clear selection for everyone
    if (wasActiveVideo) {
      io.emit('sync-state', {
        ...updatedState,
        reason: 'video-deleted',
        deletedVideo: resolved.filename,
        actorId: 'server-delete'
      });

      const sysMsg = createChatMessage({
        type: 'system',
        text: `Video "${resolved.filename}" was removed while active. Playback has been stopped.`
      });
      io.emit('chat-message', sysMsg);
    } else {
      const sysMsg = createChatMessage({
        type: 'system',
        text: `Video "${resolved.filename}" was removed from /videos.`
      });
      io.emit('chat-message', sysMsg);
    }

    io.emit('video-deleted', {
      videoFile: resolved.filename,
      wasActive: wasActiveVideo
    });

    return res.status(200).json({
      success: true,
      deletedVideo: resolved.filename,
      wasActive: wasActiveVideo,
      videos,
      state: playbackManager.getCurrentState()
    });
  } catch (error) {
    console.error('Failed to delete video file:', error.message);
    return res.status(500).json({
      error: 'Failed to delete video file from server.'
    });
  }
});

/**
 * GET /videos/:filename
 * Protected: Streams an MP4 file from /videos using HTTP Range Requests (206 Partial Content).
 */
app.get('/videos/:filename', authManager.requireAuth, (req, res) => {
  const resolved = resolveSafeVideoPath(req.params.filename);
  if (!resolved) {
    return res.status(400).send('Invalid video filename. Only .mp4 files in /videos are allowed.');
  }

  if (!fs.existsSync(resolved.fullPath)) {
    return res.status(404).send('Video file not found.');
  }

  let stat;
  try {
    stat = fs.statSync(resolved.fullPath);
  } catch (error) {
    return res.status(500).send('Unable to read video file metadata.');
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  // If the browser sent a Range header, respond with 206 Partial Content
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const startStr = match[1];
    const endStr = match[2];

    let start = startStr ? parseInt(startStr, 10) : 0;
    let end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    if (startStr === '' && endStr !== '') {
      const suffixLength = parseInt(endStr, 10);
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    }

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end >= fileSize ||
      start > end
    ) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const contentLength = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });

    const stream = fs.createReadStream(resolved.fullPath, { start, end });
    stream.on('error', (streamError) => {
      console.error('Video stream error:', streamError.message);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });

    const stream = fs.createReadStream(resolved.fullPath);
    stream.on('error', (streamError) => {
      console.error('Video stream error:', streamError.message);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }
});

/**
 * POST /api/upload?filename=example.mp4
 * Host-only: Streams an uploaded/dropped MP4 file directly to disk inside /videos
 * without buffering the whole file in Node.js memory, enforcing MAX_UPLOAD_BYTES.
 */
app.post('/api/upload', authManager.requireHost, (req, res) => {
  const rawFilename = req.query.filename;
  const resolved = resolveSafeVideoPath(rawFilename);

  if (!resolved) {
    return res.status(400).json({
      error: 'Invalid filename. Please provide a valid .mp4 file.'
    });
  }

  const contentLengthHeader = Number(req.headers['content-length']);
  if (
    Number.isFinite(contentLengthHeader) &&
    contentLengthHeader > authManager.MAX_UPLOAD_BYTES
  ) {
    return res.status(413).json({
      error: `Video file exceeds the maximum upload limit of ${authManager.MAX_UPLOAD_MB} MB.`
    });
  }

  const tempPath = `${resolved.fullPath}.uploading`;
  const writeStream = fs.createWriteStream(tempPath);
  let aborted = false;
  let bytesReceived = 0;

  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived > authManager.MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      writeStream.destroy();
      if (fs.existsSync(tempPath)) {
        fs.unlink(tempPath, () => {});
      }
      if (!res.headersSent) {
        res.status(413).json({
          error: `Video file exceeds the maximum upload limit of ${authManager.MAX_UPLOAD_MB} MB.`
        });
      }
      req.destroy();
    }
  });

  req.on('aborted', () => {
    aborted = true;
    writeStream.destroy();
    if (fs.existsSync(tempPath)) {
      fs.unlink(tempPath, () => {});
    }
  });

  writeStream.on('error', (error) => {
    console.error('Error writing uploaded MP4:', error.message);
    if (fs.existsSync(tempPath)) {
      fs.unlink(tempPath, () => {});
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to save video file on server.' });
    }
  });

  writeStream.on('finish', () => {
    if (aborted) {
      return;
    }

    try {
      fs.renameSync(tempPath, resolved.fullPath);
      const updatedState = playbackManager.setVideo(resolved.filename);
      const videos = getAvailableVideos();

      // Notify all connected clients of the updated video list and newly selected video
      io.emit('video-list', { videos });
      io.emit('sync-state', {
        ...updatedState,
        reason: 'select-video',
        actorId: 'server-upload'
      });

      res.status(200).json({
        videoFile: resolved.filename,
        videos,
        state: updatedState
      });
    } catch (renameError) {
      console.error('Error finalizing uploaded MP4:', renameError.message);
      res.status(500).json({ error: 'Failed to finalize uploaded video.' });
    }
  });

  req.pipe(writeStream);
});

// ============================================================================
// Socket.IO Real-Time Synchronization & Chat
// ============================================================================

/**
 * Socket.IO authentication middleware: rejects unauthorized visitors before
 * they can join the room or receive/emit any playback or chat events.
 */
io.use((socket, next) => {
  const auth = authManager.resolveSocketAuth(socket);
  if (!auth.authenticated) {
    return next(new Error('AUTH_REQUIRED'));
  }
  socket.data.role = auth.role;
  return next();
});

io.on('connection', (socket) => {
  const userRecord = assignDefaultUsername();
  userRecord.role = socket.data.role || 'guest';
  connectedUsers.set(socket.id, userRecord);
  console.log(
    `[Socket.IO] Client connected: ${socket.id} as "${userRecord.username}" (${userRecord.role}) (Total: ${connectedUsers.size})`
  );

  const videos = reconcileActiveVideoWithDisk();

  // 1. Send role/auth status, video list, authoritative playback state, chat identity, and chat history
  socket.emit('auth-status', { authenticated: true, role: userRecord.role });
  socket.emit('video-list', { videos });
  socket.emit('sync-state', {
    ...playbackManager.getCurrentState(),
    reason: 'initial-join',
    actorId: 'server'
  });
  socket.emit('chat-identity', { username: userRecord.username, role: userRecord.role });
  socket.emit('chat-history', { messages: chatHistory });

  // 2. Broadcast updated connected viewer count to everyone
  io.emit('user-count', { count: connectedUsers.size });

  // --- Playback Events (Available to both Host and Guest) ---

  socket.on('play', (payload = {}) => {
    const updatedState = playbackManager.play(payload.currentTime);
    io.emit('sync-state', {
      ...updatedState,
      reason: 'play',
      actorId: socket.id
    });

    const user = connectedUsers.get(socket.id);
    if (user && updatedState.videoFile) {
      const sysMsg = createChatMessage({
        type: 'system',
        text: `${user.username} unpaused`
      });
      io.emit('chat-message', sysMsg);
    }
  });

  socket.on('pause', (payload = {}) => {
    const updatedState = playbackManager.pause(payload.currentTime);
    io.emit('sync-state', {
      ...updatedState,
      reason: 'pause',
      actorId: socket.id
    });

    const user = connectedUsers.get(socket.id);
    if (user && updatedState.videoFile) {
      const sysMsg = createChatMessage({
        type: 'system',
        text: `${user.username} paused`
      });
      io.emit('chat-message', sysMsg);
    }
  });

  socket.on('seek', (payload = {}) => {
    const previousState = playbackManager.getCurrentState();
    const updatedState = playbackManager.seek(payload.currentTime);
    io.emit('sync-state', {
      ...updatedState,
      reason: 'seek',
      actorId: socket.id
    });

    const user = connectedUsers.get(socket.id);
    if (user && updatedState.videoFile) {
      const direction = updatedState.currentTime >= previousState.currentTime ? 'ahead' : 'back';
      const sysMsg = createChatMessage({
        type: 'system',
        text: `${user.username} seeked ${direction}`
      });
      io.emit('chat-message', sysMsg);
    }
  });

  // --- Video Library Selection (Host-Only) ---

  socket.on('select-video', (payload = {}) => {
    if (socket.data.role !== 'host') {
      socket.emit('sync-error', {
        message: 'Only the host can manage and switch videos in the library.'
      });
      return;
    }

    const resolved = resolveSafeVideoPath(payload.videoFile);
    if (!resolved || !fs.existsSync(resolved.fullPath)) {
      socket.emit('sync-error', { message: 'Selected video does not exist in /videos.' });
      return;
    }

    const updatedState = playbackManager.setVideo(resolved.filename);
    io.emit('sync-state', {
      ...updatedState,
      reason: 'select-video',
      actorId: socket.id
    });
  });

  socket.on('video-metadata', (payload = {}) => {
    const currentState = playbackManager.getCurrentState();
    if (payload.videoFile && payload.videoFile === currentState.videoFile) {
      playbackManager.setDuration(payload.duration);
    }
  });

  socket.on('video-ended', (payload = {}) => {
    const updatedState = playbackManager.pause(payload.currentTime);
    io.emit('sync-state', {
      ...updatedState,
      reason: 'ended',
      actorId: socket.id
    });
  });

  socket.on('request-sync', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.emit('chat-identity', { username: user.username });
    }
    socket.emit('chat-history', { messages: chatHistory });
    socket.emit('video-list', { videos: reconcileActiveVideoWithDisk() });
    socket.emit('sync-state', {
      ...playbackManager.getCurrentState(),
      reason: 'manual-sync',
      actorId: 'server'
    });
  });

  // --- Real-Time Chat & /name Command Events ---

  socket.on('chat-message', (payload = {}) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !payload || typeof payload.text !== 'string') {
      return;
    }

    // Strip control characters and trim whitespace
    const cleanedText = payload.text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();

    if (!cleanedText) {
      return;
    }

    // Check if the message is the /name slash command (e.g. "/name faseeh")
    if (/^\/name(?:\s|$)/i.test(cleanedText)) {
      const requestedName = cleanedText.replace(/^\/name\s*/i, '');
      const validation = validateAndResolveUsername(requestedName, socket.id);

      if (validation.error) {
        // Send validation error privately to the requesting client only
        socket.emit(
          'chat-message',
          createChatMessage({
            type: 'system',
            text: validation.error,
            persist: false
          })
        );
        return;
      }

      const previousName = user.username;
      const newName = validation.username;

      if (previousName === newName) {
        return;
      }

      user.username = newName;
      socket.emit('chat-identity', { username: newName });

      const renameNotice = createChatMessage({
        type: 'system',
        text: `${previousName} is now known as ${newName}.`
      });
      io.emit('chat-message', renameNotice);
      return;
    }

    // Normal chat message: enforce max length and always use server-stored username
    const safeMessageText = cleanedText.slice(0, MAX_CHAT_MESSAGE_LENGTH);
    const chatMessage = createChatMessage({
      type: 'user',
      sender: user.username,
      senderId: socket.id,
      text: safeMessageText
    });

    io.emit('chat-message', chatMessage);
  });

  socket.on('disconnect', (reason) => {
    const user = connectedUsers.get(socket.id);
    connectedUsers.delete(socket.id);
    console.log(
      `[Socket.IO] Client disconnected: ${socket.id} (${user ? user.username : 'unknown'}, ${reason}) (Total: ${connectedUsers.size})`
    );
    io.emit('user-count', { count: connectedUsers.size });
  });
});

/**
 * Periodic drift check:
 * Every 3 seconds while a video is actively playing, broadcast the authoritative
 * server timestamp so any client that has drifted beyond the tolerance threshold
 * can gently resynchronize without manual intervention.
 */
const DRIFT_BROADCAST_INTERVAL_MS = 3000;
setInterval(() => {
  const currentState = playbackManager.getCurrentState();
  if (currentState.videoFile && currentState.isPlaying && connectedUsers.size > 0) {
    io.emit('drift-check', currentState);
  }
}, DRIFT_BROADCAST_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('ShowParty Server Running');
  console.log(`Local access:   http://localhost:${PORT}`);
  const lanAddresses = getLocalIPv4Addresses();
  if (lanAddresses.length > 0) {
    for (const item of lanAddresses) {
      console.log(`Network access: ${item.url} (${item.interface})`);
    }
  } else {
    console.log('Network access: No external IPv4 interface detected.');
  }
  console.log('============================================================');
});
