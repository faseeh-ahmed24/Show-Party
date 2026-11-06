/**
 * playbackManager.js
 *
 * Maintains the single authoritative playback state on the Node.js server.
 * Instead of running a rapid timer loop on the server, we store:
 *   - currentTime: the video position (in seconds) at the moment of the last state change
 *   - lastUpdatedAt: the server wall-clock timestamp (in ms) when that change occurred
 *
 * Whenever a user joins, reconnects, or checks for drift while the video is playing,
 * we calculate the live position by adding the elapsed time since `lastUpdatedAt`.
 */

class PlaybackManager {
  constructor() {
    this.state = {
      videoFile: null,          // Filename inside the /videos directory (e.g., "sample.mp4")
      isPlaying: false,         // True if playback is currently active
      currentTime: 0,           // Playback timestamp in seconds at lastUpdatedAt
      duration: 0,              // Known duration of the current video in seconds (0 if unknown)
      lastUpdatedAt: Date.now(),// Server timestamp (ms) when state was last updated
      sequence: 0               // Incrementing counter to track update order
    };
  }

  /**
   * Sanitizes a time value to ensure it is a valid non-negative number.
   */
  sanitizeTime(timeSeconds) {
    const parsed = Number(timeSeconds);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    if (this.state.duration > 0 && parsed > this.state.duration) {
      return this.state.duration;
    }
    return parsed;
  }

  /**
   * Computes the current authoritative playback position in seconds.
   * If the video is playing, we add the elapsed wall-clock seconds since lastUpdatedAt.
   */
  getLiveCurrentTime() {
    if (!this.state.isPlaying) {
      return this.state.currentTime;
    }

    const elapsedSeconds = (Date.now() - this.state.lastUpdatedAt) / 1000;
    const calculatedTime = this.state.currentTime + elapsedSeconds;

    // If we know the video duration and playback has reached the end, clamp and stop.
    if (this.state.duration > 0 && calculatedTime >= this.state.duration) {
      this.state.currentTime = this.state.duration;
      this.state.isPlaying = false;
      this.state.lastUpdatedAt = Date.now();
      return this.state.currentTime;
    }

    return calculatedTime;
  }

  /**
   * Returns a snapshot of the authoritative playback state to send to clients.
   */
  getCurrentState() {
    return {
      videoFile: this.state.videoFile,
      isPlaying: this.state.isPlaying,
      currentTime: this.getLiveCurrentTime(),
      duration: this.state.duration,
      serverTime: Date.now(),
      sequence: this.state.sequence
    };
  }

  /**
   * Sets the active video file and resets playback to the beginning (paused at 0:00).
   */
  setVideo(filename) {
    this.state.videoFile = filename;
    this.state.isPlaying = false;
    this.state.currentTime = 0;
    this.state.duration = 0;
    this.state.lastUpdatedAt = Date.now();
    this.state.sequence += 1;
    return this.getCurrentState();
  }

  /**
   * Records the duration of the active video once a client loads its metadata.
   */
  setDuration(durationSeconds) {
    const parsed = Number(durationSeconds);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.state.duration = parsed;
    }
  }

  /**
   * Updates the state to playing from the given timestamp.
   */
  play(timeSeconds) {
    if (!this.state.videoFile) {
      return this.getCurrentState();
    }
    if (timeSeconds !== undefined && timeSeconds !== null) {
      this.state.currentTime = this.sanitizeTime(timeSeconds);
    } else {
      this.state.currentTime = this.getLiveCurrentTime();
    }

    // If playing from the very end of the video, restart from 0
    if (this.state.duration > 0 && this.state.currentTime >= this.state.duration) {
      this.state.currentTime = 0;
    }

    this.state.isPlaying = true;
    this.state.lastUpdatedAt = Date.now();
    this.state.sequence += 1;
    return this.getCurrentState();
  }

  /**
   * Updates the state to paused at the given timestamp.
   */
  pause(timeSeconds) {
    if (!this.state.videoFile) {
      return this.getCurrentState();
    }
    if (timeSeconds !== undefined && timeSeconds !== null) {
      this.state.currentTime = this.sanitizeTime(timeSeconds);
    } else {
      this.state.currentTime = this.getLiveCurrentTime();
    }

    this.state.isPlaying = false;
    this.state.lastUpdatedAt = Date.now();
    this.state.sequence += 1;
    return this.getCurrentState();
  }

  /**
   * Updates the playback position to a new timestamp while preserving play/pause state.
   */
  seek(timeSeconds) {
    if (!this.state.videoFile) {
      return this.getCurrentState();
    }
    this.state.currentTime = this.sanitizeTime(timeSeconds);
    this.state.lastUpdatedAt = Date.now();
    this.state.sequence += 1;
    return this.getCurrentState();
  }
}

module.exports = new PlaybackManager();
