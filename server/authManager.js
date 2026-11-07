/**
 * authManager.js
 *
 * Room access protection, host-vs-guest role resolution, HttpOnly session management,
 * and login rate-limiting for ShowParty (Stage Two: Public Internet Access).
 *
 * Security principles:
 *   - The room access code is NEVER embedded in frontend HTML/JS or logged in plaintext.
 *   - Visitors connecting via Cloudflare Tunnel (or any non-localhost origin) must
 *     authenticate with the room access code before accessing video endpoints or Socket.IO.
 *   - The local host computer (connecting directly via http://localhost:<PORT> without
 *     proxy/tunnel forwarding headers) is automatically granted the 'host' role.
 *   - Sessions use cryptographically random 256-bit tokens stored in an HttpOnly cookie
 *     (never stored in browser localStorage).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE_NAME = 'showparty_sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILED_ATTEMPTS = 5;

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Loads simple KEY=VALUE pairs from a local .env file (if present) into process.env
 * without overriding already-set environment variables.
 */
function loadDotEnvIfPresent() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const eqIndex = line.indexOf('=');
      if (eqIndex <= 0) {
        continue;
      }
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.error('Warning: Unable to read .env file:', error.message);
  }
}

loadDotEnvIfPresent();

/**
 * Generates a human-friendly, cryptographically random 8-character room code (e.g. "K7M9-P4X2").
 */
function generateRandomRoomCode() {
  const bytes = crypto.randomBytes(8);
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    part2 += ROOM_CODE_ALPHABET[bytes[i + 4] % ROOM_CODE_ALPHABET.length];
  }
  return `${part1}-${part2}`;
}

/**
 * Sanitizes a user-configured room code (trims whitespace and control characters).
 */
function sanitizeRoomCode(rawCode) {
  if (typeof rawCode !== 'string') {
    return '';
  }
  return rawCode.replace(/[\r\n\t\x00-\x1f\x7f]/g, '').trim();
}

// Initialize active room code from environment or generate a random one
let activeRoomCode = sanitizeRoomCode(process.env.ROOM_CODE || '');
if (!activeRoomCode) {
  activeRoomCode = generateRandomRoomCode();
}

// Configurable maximum upload size in bytes (default: 2048 MB = 2 GB)
const configuredMaxUploadMB = Number(process.env.MAX_UPLOAD_MB);
const MAX_UPLOAD_MB =
  Number.isFinite(configuredMaxUploadMB) && configuredMaxUploadMB > 0
    ? configuredMaxUploadMB
    : 2048;
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);

// In-memory session store: token -> { role: 'host' | 'guest', createdAt: number, expiresAt: number }
const sessions = new Map();

// In-memory login rate-limit store: ip -> { count: number, resetAt: number }
const loginAttempts = new Map();

/**
 * Constant-time comparison between a submitted code and the active room code.
 * Normalizes case and optional hyphen only if comparing against the generated XXXX-XXXX format,
 * or compares exact trimmed strings so custom codes work naturally.
 */
function verifyRoomCode(submittedCode) {
  const cleaned = sanitizeRoomCode(submittedCode);
  if (!cleaned || !activeRoomCode) {
    return false;
  }

  // Compare both exact match and case-insensitive match
  const hashSubmittedExact = crypto.createHash('sha256').update(cleaned).digest();
  const hashActiveExact = crypto.createHash('sha256').update(activeRoomCode).digest();
  const exactMatch = crypto.timingSafeEqual(hashSubmittedExact, hashActiveExact);

  const hashSubmittedUpper = crypto
    .createHash('sha256')
    .update(cleaned.toUpperCase())
    .digest();
  const hashActiveUpper = crypto
    .createHash('sha256')
    .update(activeRoomCode.toUpperCase())
    .digest();
  const upperMatch = crypto.timingSafeEqual(hashSubmittedUpper, hashActiveUpper);

  return exactMatch || upperMatch;
}

/**
 * Parses the HTTP Cookie header into an object of key-value pairs.
 */
function parseCookies(cookieHeader) {
  const result = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return result;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = pair.slice(0, eqIdx).trim();
    const rawVal = pair.slice(eqIdx + 1).trim();
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

/**
 * Determines the client IP address for rate-limiting, respecting Cloudflare Tunnel headers.
 */
function getClientIp(headers = {}, remoteAddress = '') {
  const cfIp = headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const forwardedFor = headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return remoteAddress || 'unknown';
}

/**
 * Returns true ONLY if the request comes directly from the host computer's local
 * loopback browser (http://localhost:<PORT> or http://127.0.0.1:<PORT>) and is NOT
 * proxied through Cloudflare Tunnel or another reverse proxy.
 */
function isDirectLocalhostRequest(headers = {}, remoteAddress = '') {
  // Any request forwarded by cloudflared includes Cloudflare or proxy headers
  if (
    headers['cf-connecting-ip'] ||
    headers['cf-ray'] ||
    headers['cf-visitor'] ||
    headers['x-forwarded-for'] ||
    headers['x-forwarded-host'] ||
    headers['x-forwarded-proto']
  ) {
    return false;
  }

  const normalizedAddr = String(remoteAddress || '').toLowerCase();
  const isLoopbackSocket =
    normalizedAddr === '127.0.0.1' ||
    normalizedAddr === '::1' ||
    normalizedAddr === '::ffff:127.0.0.1';

  if (!isLoopbackSocket) {
    return false;
  }

  const hostHeader = String(headers.host || '').toLowerCase();
  const hostname = hostHeader.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Creates a new session with the given role ('host' or 'guest') and returns the token.
 */
function createSession(role) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    role,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  return token;
}

/**
 * Looks up a valid session from a cookie header.
 */
function getSessionFromCookieHeader(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  const now = Date.now();
  if (now > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  // Refresh sliding expiration
  session.expiresAt = now + SESSION_TTL_MS;
  return {
    token,
    role: session.role
  };
}

/**
 * Formats a Set-Cookie header value for the session token.
 */
function buildSessionCookieHeader(token, req) {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];

  if (isHttps) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Formats a Set-Cookie header value that clears the session cookie.
 */
function buildClearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Resolves the authentication state for an Express request.
 * If the request is a direct localhost request from the host computer and has no
 * host session cookie yet, it automatically issues one.
 */
function resolveRequestAuth(req, res) {
  const existingSession = getSessionFromCookieHeader(req.headers.cookie);
  const isLocalHost = isDirectLocalhostRequest(
    req.headers,
    req.socket ? req.socket.remoteAddress : ''
  );

  // If connecting directly from localhost, ensure the user has 'host' privileges
  if (isLocalHost) {
    if (existingSession && existingSession.role === 'host') {
      return { authenticated: true, role: 'host', token: existingSession.token };
    }
    const newToken = createSession('host');
    if (res && !res.headersSent) {
      res.setHeader('Set-Cookie', buildSessionCookieHeader(newToken, req));
    }
    return { authenticated: true, role: 'host', token: newToken };
  }

  if (existingSession) {
    return {
      authenticated: true,
      role: existingSession.role,
      token: existingSession.token
    };
  }

  return { authenticated: false, role: null, token: null };
}

/**
 * Resolves the authentication state for a Socket.IO handshake.
 */
function resolveSocketAuth(socket) {
  const headers = (socket.handshake && socket.handshake.headers) || {};
  const remoteAddress =
    (socket.conn && socket.conn.remoteAddress) ||
    (socket.handshake && socket.handshake.address) ||
    '';

  if (isDirectLocalhostRequest(headers, remoteAddress)) {
    return { authenticated: true, role: 'host' };
  }

  const existingSession = getSessionFromCookieHeader(headers.cookie);
  if (existingSession) {
    return { authenticated: true, role: existingSession.role, token: existingSession.token };
  }

  return { authenticated: false, role: null };
}

/**
 * Express middleware requiring an authenticated session ('host' or 'guest').
 */
function requireAuth(req, res, next) {
  const auth = resolveRequestAuth(req, res);
  if (!auth.authenticated) {
    return res.status(401).json({
      error: 'Authentication required. Please enter the room access code.',
      authRequired: true
    });
  }
  req.userAuth = auth;
  next();
}

/**
 * Express middleware requiring the 'host' role.
 */
function requireHost(req, res, next) {
  const auth = resolveRequestAuth(req, res);
  if (!auth.authenticated) {
    return res.status(401).json({
      error: 'Authentication required.',
      authRequired: true
    });
  }
  if (auth.role !== 'host') {
    return res.status(403).json({
      error: 'Only the host can perform this action.'
    });
  }
  req.userAuth = auth;
  next();
}

/**
 * Checks login rate limit for a client IP.
 */
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) {
    return { allowed: true };
  }
  if (now > record.resetAt) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true };
}

/**
 * Records a failed login attempt for a client IP.
 */
function recordFailedLoginAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
  } else {
    record.count += 1;
  }
}

/**
 * Clears failed login attempts for a client IP after a successful login.
 */
function clearFailedLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

/**
 * Returns the active room code (for host-only inspection).
 */
function getRoomCode() {
  return activeRoomCode;
}

/**
 * Updates the active room code (either to a custom code or a freshly generated one)
 * and optionally revokes existing guest sessions.
 */
function updateRoomCode(newCustomCode, { revokeGuests = true } = {}) {
  if (typeof newCustomCode === 'string' && sanitizeRoomCode(newCustomCode).length > 0) {
    const cleaned = sanitizeRoomCode(newCustomCode);
    if (cleaned.length < 4 || cleaned.length > 32) {
      return { error: 'Room code must be between 4 and 32 characters.' };
    }
    activeRoomCode = cleaned;
  } else {
    activeRoomCode = generateRandomRoomCode();
  }

  if (revokeGuests) {
    for (const [token, session] of sessions.entries()) {
      if (session.role === 'guest') {
        sessions.delete(token);
      }
    }
  }

  return { roomCode: activeRoomCode };
}

/**
 * Deletes a session by token.
 */
function removeSession(token) {
  if (token) {
    sessions.delete(token);
  }
}

module.exports = {
  MAX_UPLOAD_MB,
  MAX_UPLOAD_BYTES,
  verifyRoomCode,
  getClientIp,
  isDirectLocalhostRequest,
  createSession,
  removeSession,
  buildSessionCookieHeader,
  buildClearSessionCookieHeader,
  resolveRequestAuth,
  resolveSocketAuth,
  requireAuth,
  requireHost,
  checkLoginRateLimit,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
  getRoomCode,
  updateRoomCode
};
