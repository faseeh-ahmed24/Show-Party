/**
 * script.js
 *
 * Client-side logic for ShowParty:
 *   1. Custom HTML5 video player controls (Play/Pause, Seek, Volume, Mute, Fullscreen)
 *   2. Keyboard shortcuts (Space, Left/Right, Up/Down, M, F)
 *   3. Real-time synchronization via Socket.IO with drift correction and loop prevention
 *   4. Video selection from /videos, per-video removal with confirmation, and drag-and-drop MP4 hosting
 *   5. Real-time chat panel with server-authoritative usernames and /name command
 */

(function () {
  'use strict';

  // --- DOM Elements ---
  const playerContainer = document.getElementById('player-container');
  const videoPlayer = document.getElementById('video-player');
  const playerOverlay = document.getElementById('player-overlay');
  const overlayPrimaryText = document.getElementById('overlay-primary-text');
  const overlaySecondaryText = document.getElementById('overlay-secondary-text');
  const autoplayBanner = document.getElementById('autoplay-banner');
  const unmuteBannerBtn = document.getElementById('unmute-banner-btn');

  const currentVideoNameEl = document.getElementById('current-video-name');
  const connectionIndicator = document.getElementById('connection-indicator');
  const connectionStatusText = document.getElementById('connection-status-text');
  const viewerCountEl = document.getElementById('viewer-count');
  const networkUrlDisplay = document.getElementById('network-url-display');

  const videoSelectorDropdown = document.getElementById('video-selector-dropdown');
  const videoSelectorToggle = document.getElementById('video-selector-toggle');
  const videoSelectorLabel = document.getElementById('video-selector-label');
  const videoSelectorMenu = document.getElementById('video-selector-menu');
  const videoSelect = document.getElementById('video-select');
  const refreshVideosBtn = document.getElementById('refresh-videos-btn');
  const addVideoBtn = document.getElementById('add-video-btn');
  const fileInput = document.getElementById('file-input');
  const uploadStatusEl = document.getElementById('upload-status');

  const deleteConfirmDialog = document.getElementById('delete-confirm-dialog');
  const deleteDialogTitle = document.getElementById('delete-dialog-title');
  const deleteDialogMessage = document.getElementById('delete-dialog-message');

  const playPauseBtn = document.getElementById('play-pause-btn');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const playPauseLabel = document.getElementById('play-pause-label');

  const seekBar = document.getElementById('seek-bar');
  const currentTimeEl = document.getElementById('current-time');
  const durationTimeEl = document.getElementById('duration-time');

  const muteBtn = document.getElementById('mute-btn');
  const iconVolumeOn = document.getElementById('icon-volume-on');
  const iconVolumeMuted = document.getElementById('icon-volume-muted');
  const volumeSlider = document.getElementById('volume-slider');
  const volumePercentEl = document.getElementById('volume-percent');

  const resyncBtn = document.getElementById('resync-btn');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const iconFullscreenEnter = document.getElementById('icon-fullscreen-enter');
  const iconFullscreenExit = document.getElementById('icon-fullscreen-exit');

  // Chat DOM elements
  const chatUsernameBadge = document.getElementById('chat-username-badge');
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  // --- Synchronization Constants & State ---
  // Tolerance for explicit actions (play, pause, seek, join) in seconds
  const ACTION_SYNC_TOLERANCE_SECONDS = 0.35;
  // Tolerance for periodic background drift checks while playing in seconds
  const DRIFT_TOLERANCE_SECONDS = 1.5;

  const socket = io({
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000
  });

  let availableVideos = [];
  let loadedVideoFile = null;         // Filename currently loaded into <video>
  let pendingServerState = null;      // State waiting for <video> metadata to finish loading
  let lastAppliedSequence = -1;       // Tracks sequence number from server
  let isDraggingSeekBar = false;      // True while the user is dragging the timeline slider
  let isApplyingServerState = false;  // Guard flag preventing programmatic actions from re-emitting
  let pendingDeleteVideoName = null;  // Filename awaiting user confirmation to delete
  const renderedMessageIds = new Set();

  // ==========================================================================
  // Formatting & UI Helpers
  // ==========================================================================

  /**
   * Formats seconds into MM:SS or HH:MM:SS.
   */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '00:00';
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(secs).padStart(2, '0');

    if (hours > 0) {
      const paddedHours = String(hours).padStart(2, '0');
      return `${paddedHours}:${paddedMinutes}:${paddedSeconds}`;
    }
    return `${paddedMinutes}:${paddedSeconds}`;
  }

  /**
   * Formats a wall-clock timestamp (ms) into HH:MM for chat messages.
   */
  function formatChatTimestamp(timestampMs) {
    const date = new Date(Number(timestampMs) || Date.now());
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /**
   * Updates the Play/Pause button icon and text to match the video element state.
   */
  function updatePlayPauseUI() {
    const isPaused = videoPlayer.paused || videoPlayer.ended;
    if (isPaused) {
      iconPlay.hidden = false;
      iconPause.hidden = true;
      playPauseLabel.textContent = 'Play';
      playPauseBtn.setAttribute('aria-label', 'Play');
    } else {
      iconPlay.hidden = true;
      iconPause.hidden = false;
      playPauseLabel.textContent = 'Pause';
      playPauseBtn.setAttribute('aria-label', 'Pause');
    }
  }

  /**
   * Updates the Mute button icon and Volume slider to match the local video volume.
   * Note: Volume and Mute are intentionally independent per user.
   */
  function updateVolumeUI() {
    const isMuted = videoPlayer.muted || videoPlayer.volume === 0;
    iconVolumeOn.hidden = isMuted;
    iconVolumeMuted.hidden = !isMuted;
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');

    const effectiveVolume = videoPlayer.muted ? 0 : videoPlayer.volume;
    volumeSlider.value = String(effectiveVolume);
    volumePercentEl.textContent = `${Math.round(effectiveVolume * 100)}%`;

    if (!videoPlayer.muted && videoPlayer.volume > 0) {
      autoplayBanner.hidden = true;
    }
  }

  /**
   * Updates the seek bar position and current playback timestamp label.
   */
  function updateTimelineUI() {
    if (!isDraggingSeekBar) {
      seekBar.value = String(videoPlayer.currentTime || 0);
      currentTimeEl.textContent = formatTime(videoPlayer.currentTime || 0);
    }
  }

  /**
   * Updates the label on the custom video selector toggle button.
   */
  function updateVideoSelectorLabel() {
    if (!videoSelectorLabel) {
      return;
    }
    if (loadedVideoFile) {
      videoSelectorLabel.textContent = loadedVideoFile;
    } else if (availableVideos.length === 0) {
      videoSelectorLabel.textContent = '-- No MP4 files in /videos --';
    } else {
      videoSelectorLabel.textContent = '-- Select an MP4 from /videos --';
    }
  }

  /**
   * Closes the custom video selector dropdown menu.
   */
  function closeVideoSelectorMenu() {
    if (videoSelectorMenu && videoSelectorToggle) {
      videoSelectorMenu.hidden = true;
      videoSelectorToggle.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * Populates both the custom video selector menu (with per-video Remove buttons)
   * and the hidden <select> element with the list of .mp4 files in /videos.
   */
  function renderVideoDropdown(videos) {
    availableVideos = Array.isArray(videos) ? videos : [];

    // 1. Update hidden native <select>
    if (videoSelect) {
      videoSelect.innerHTML = '';
      if (availableVideos.length === 0) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '-- No MP4 files in /videos --';
        videoSelect.appendChild(emptyOpt);
      } else {
        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = '-- Select an MP4 from /videos --';
        videoSelect.appendChild(placeholderOpt);

        for (const video of availableVideos) {
          const option = document.createElement('option');
          option.value = video.name;
          const sizeMB = (video.size / (1024 * 1024)).toFixed(1);
          option.textContent = `${video.name} (${sizeMB} MB)`;
          if (video.name === loadedVideoFile) {
            option.selected = true;
          }
          videoSelect.appendChild(option);
        }
      }
    }

    // 2. Update custom dropdown menu with per-video Remove buttons
    if (videoSelectorMenu) {
      videoSelectorMenu.innerHTML = '';

      if (availableVideos.length === 0) {
        const emptyLi = document.createElement('li');
        emptyLi.className = 'video-selector-empty';
        emptyLi.textContent = 'No MP4 files in /videos';
        videoSelectorMenu.appendChild(emptyLi);
      } else {
        for (const video of availableVideos) {
          const li = document.createElement('li');
          li.className = 'video-selector-item';
          if (video.name === loadedVideoFile) {
            li.classList.add('active-video');
          }

          // Select button on the left
          const selectBtn = document.createElement('button');
          selectBtn.type = 'button';
          selectBtn.className = 'video-item-select-btn';
          selectBtn.setAttribute('data-video-name', video.name);

          const nameSpan = document.createElement('span');
          nameSpan.textContent = video.name;
          selectBtn.appendChild(nameSpan);

          const sizeSpan = document.createElement('span');
          sizeSpan.className = 'video-item-size';
          const sizeMB = (video.size / (1024 * 1024)).toFixed(1);
          sizeSpan.textContent = `(${sizeMB} MB)`;
          selectBtn.appendChild(sizeSpan);

          selectBtn.addEventListener('click', () => {
            closeVideoSelectorMenu();
            socket.emit('select-video', { videoFile: video.name });
          });

          // Small, unobtrusive Remove button on the far right
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'video-item-remove-btn';
          removeBtn.textContent = 'Remove';
          removeBtn.title = `Remove ${video.name} from /videos`;
          removeBtn.setAttribute('aria-label', `Remove ${video.name}`);
          removeBtn.setAttribute('data-remove-video', video.name);

          removeBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            closeVideoSelectorMenu();
            requestVideoDeletion(video.name);
          });

          li.appendChild(selectBtn);
          li.appendChild(removeBtn);
          videoSelectorMenu.appendChild(li);
        }
      }
    }

    updateVideoSelectorLabel();
  }

  /**
   * Fetches the video list and local network URLs from GET /api/videos.
   */
  async function fetchVideoListAndNetworkInfo() {
    try {
      const response = await fetch('/api/videos');
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      renderVideoDropdown(data.videos || []);

      if (Array.isArray(data.networkUrls) && data.networkUrls.length > 0) {
        networkUrlDisplay.textContent = data.networkUrls.map((item) => item.url).join('  |  ');
      } else {
        networkUrlDisplay.textContent = window.location.origin;
      }

      if (data.state && !loadedVideoFile && data.state.videoFile) {
        applyServerState(data.state);
      }
    } catch (error) {
      console.error('Failed to fetch video list:', error);
    }
  }

  // ==========================================================================
  // Video Removal with Confirmation
  // ==========================================================================

  /**
   * Prompts the user for confirmation before deleting a video from /videos.
   * Displays an explicit warning if the video is currently active/being watched.
   */
  function requestVideoDeletion(videoFilename) {
    if (!videoFilename) {
      return;
    }

    const isCurrentlyActive = videoFilename === loadedVideoFile;
    pendingDeleteVideoName = videoFilename;

    const warningTitle = isCurrentlyActive
      ? 'Warning: Video Is Currently Active'
      : 'Remove Video from Server';

    const warningText = isCurrentlyActive
      ? `"${videoFilename}" is currently loaded in the video player and being watched. Removing it will immediately stop playback for all connected users and permanently delete the file from /videos.`
      : `Are you sure you want to permanently delete "${videoFilename}" from the /videos directory on the host computer?`;

    if (deleteConfirmDialog && typeof deleteConfirmDialog.showModal === 'function') {
      deleteDialogTitle.textContent = warningTitle;
      deleteDialogMessage.textContent = warningText;
      deleteConfirmDialog.showModal();
    } else if (typeof window.confirm === 'function') {
      if (window.confirm(`${warningTitle}\n\n${warningText}`)) {
        executeVideoDeletion(videoFilename);
      }
      pendingDeleteVideoName = null;
    }
  }

  /**
   * Calls DELETE /api/videos/:filename on the server after confirmation.
   */
  async function executeVideoDeletion(videoFilename) {
    if (!videoFilename) {
      return;
    }

    try {
      uploadStatusEl.textContent = `Removing ${videoFilename}...`;
      const response = await fetch(`/api/videos/${encodeURIComponent(videoFilename)}`, {
        method: 'DELETE'
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove video.');
      }

      if (Array.isArray(data.videos)) {
        renderVideoDropdown(data.videos);
      }

      uploadStatusEl.textContent = `Removed ${videoFilename}`;
      setTimeout(() => {
        uploadStatusEl.textContent = '';
      }, 3000);
    } catch (error) {
      uploadStatusEl.textContent = error.message || 'Error removing video.';
    }
  }

  if (deleteConfirmDialog) {
    deleteConfirmDialog.addEventListener('close', () => {
      const targetVideo = pendingDeleteVideoName;
      pendingDeleteVideoName = null;
      if (deleteConfirmDialog.returnValue === 'confirm' && targetVideo) {
        executeVideoDeletion(targetVideo);
      }
    });
  }

  // ==========================================================================
  // Authoritative State Synchronization (Server -> Client)
  // ==========================================================================

  /**
   * Safely starts video playback when commanded by the server.
   * Handles browser autoplay restrictions gracefully by falling back to muted playback
   * if the user has not interacted with the page yet, without pausing the other user.
   */
  async function playFromServerCommand() {
    try {
      await videoPlayer.play();
      updatePlayPauseUI();
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        try {
          videoPlayer.muted = true;
          updateVolumeUI();
          autoplayBanner.hidden = false;
          await videoPlayer.play();
          updatePlayPauseUI();
        } catch (secondError) {
          overlayPrimaryText.textContent = 'Click Play to join live playback';
          overlaySecondaryText.textContent = 'Your browser requires a click before starting video playback.';
          playerOverlay.hidden = false;
        }
      }
    }
  }

  /**
   * Applies the playback position and play/pause status once video metadata is ready.
   */
  function applyPlaybackPositionAndStatus(state, toleranceSeconds) {
    isApplyingServerState = true;

    try {
      const targetTime = Number(state.currentTime) || 0;
      const clampedTime = videoPlayer.duration
        ? Math.min(Math.max(0, targetTime), videoPlayer.duration)
        : Math.max(0, targetTime);

      const timeDifference = Math.abs((videoPlayer.currentTime || 0) - clampedTime);

      // Only seek if the difference exceeds our tolerance threshold
      if (timeDifference > toleranceSeconds && !isDraggingSeekBar) {
        videoPlayer.currentTime = clampedTime;
        seekBar.value = String(clampedTime);
        currentTimeEl.textContent = formatTime(clampedTime);
      }

      if (state.isPlaying) {
        if (videoPlayer.paused) {
          playFromServerCommand();
        }
      } else {
        if (!videoPlayer.paused) {
          videoPlayer.pause();
        }
        updatePlayPauseUI();
      }
    } finally {
      isApplyingServerState = false;
    }
  }

  /**
   * Applies an authoritative playback state snapshot received from the Node.js server.
   */
  function applyServerState(state) {
    if (!state) {
      return;
    }

    if (typeof state.sequence === 'number') {
      if (state.sequence < lastAppliedSequence && state.reason !== 'manual-sync' && state.reason !== 'initial-join') {
        return;
      }
      lastAppliedSequence = state.sequence;
    }

    // Case 1: No video file is currently selected on the server (or active video was deleted)
    if (!state.videoFile) {
      loadedVideoFile = null;
      pendingServerState = null;
      videoPlayer.pause();
      videoPlayer.removeAttribute('src');
      videoPlayer.load();
      currentVideoNameEl.textContent = 'No video selected';
      if (videoSelect) {
        videoSelect.value = '';
      }
      playPauseBtn.disabled = true;
      seekBar.disabled = true;
      seekBar.value = '0';
      currentTimeEl.textContent = '00:00';
      durationTimeEl.textContent = '00:00';

      if (state.reason === 'video-deleted' && state.deletedVideo) {
        overlayPrimaryText.textContent = `"${state.deletedVideo}" was removed`;
        overlaySecondaryText.textContent = 'Playback was stopped for all connected users. Select or add another MP4 video to watch.';
      } else {
        overlayPrimaryText.textContent = 'No MP4 video loaded';
        overlaySecondaryText.innerHTML = 'Place an .mp4 file in the <code>/videos</code> folder or drag and drop an .mp4 file here.';
      }

      playerOverlay.hidden = false;
      autoplayBanner.hidden = true;
      updatePlayPauseUI();
      renderVideoDropdown(availableVideos);
      return;
    }

    // Case 2: A new video file was selected (avoid reloading if it's already the active file)
    if (state.videoFile !== loadedVideoFile) {
      loadedVideoFile = state.videoFile;
      pendingServerState = state;

      currentVideoNameEl.textContent = loadedVideoFile;
      if (videoSelect) {
        videoSelect.value = loadedVideoFile;
      }
      renderVideoDropdown(availableVideos);
      playerOverlay.hidden = true;
      autoplayBanner.hidden = true;

      playPauseBtn.disabled = false;
      seekBar.disabled = false;

      // Single encodeURIComponent safely encodes spaces, parentheses, and consecutive periods
      videoPlayer.src = `/videos/${encodeURIComponent(loadedVideoFile)}`;
      videoPlayer.load();
      return;
    }

    // Case 3: Video is still loading metadata; defer applying timestamp/play state until loadedmetadata fires
    if (videoPlayer.readyState < 1) {
      pendingServerState = state;
      return;
    }

    // Case 4: Video metadata is ready; apply timestamp and play/pause status immediately
    pendingServerState = null;
    applyPlaybackPositionAndStatus(state, ACTION_SYNC_TOLERANCE_SECONDS);
  }

  // ==========================================================================
  // User-Initiated Playback Actions (Client -> Server)
  // ==========================================================================

  /**
   * Triggered when the local user clicks Play/Pause, clicks the video canvas, or presses Space.
   */
  function toggleUserPlayPause() {
    if (!loadedVideoFile || isApplyingServerState) {
      return;
    }

    playerOverlay.hidden = true;

    if (videoPlayer.paused || videoPlayer.ended) {
      const startTime = videoPlayer.ended ? 0 : videoPlayer.currentTime;
      if (videoPlayer.ended) {
        videoPlayer.currentTime = 0;
      }

      videoPlayer.play().catch(() => {});
      updatePlayPauseUI();
      socket.emit('play', { currentTime: startTime });
    } else {
      videoPlayer.pause();
      updatePlayPauseUI();
      socket.emit('pause', { currentTime: videoPlayer.currentTime });
    }
  }

  /**
   * Triggered when the local user finishes dragging the seek bar or uses Left/Right Arrow keys.
   */
  function commitUserSeek(targetTimeSeconds) {
    if (!loadedVideoFile || isApplyingServerState) {
      return;
    }

    const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
    const clampedTime = duration > 0
      ? Math.min(Math.max(0, targetTimeSeconds), duration)
      : Math.max(0, targetTimeSeconds);

    videoPlayer.currentTime = clampedTime;
    seekBar.value = String(clampedTime);
    currentTimeEl.textContent = formatTime(clampedTime);

    socket.emit('seek', { currentTime: clampedTime });
  }

  /**
   * Changes local audio volume by a delta (e.g. +0.05 or -0.05).
   */
  function adjustLocalVolume(delta) {
    const currentVolume = videoPlayer.muted ? 0 : videoPlayer.volume;
    const nextVolume = Math.min(1, Math.max(0, Math.round((currentVolume + delta) * 100) / 100));
    videoPlayer.muted = nextVolume === 0;
    videoPlayer.volume = nextVolume;
    updateVolumeUI();
  }

  /**
   * Toggles local audio mute state.
   */
  function toggleLocalMute() {
    videoPlayer.muted = !videoPlayer.muted;
    if (!videoPlayer.muted && videoPlayer.volume === 0) {
      videoPlayer.volume = 0.5;
    }
    updateVolumeUI();
  }

  /**
   * Toggles fullscreen mode on the player container.
   */
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (playerContainer.requestFullscreen) {
        playerContainer.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  // ==========================================================================
  // Real-Time Chat Logic
  // ==========================================================================

  /**
   * Appends a single chat message object to the chat log and auto-scrolls when appropriate.
   */
  function appendChatMessage(message) {
    if (!chatMessagesEl || !message || typeof message.text !== 'string') {
      return;
    }

    if (typeof message.id === 'number') {
      if (renderedMessageIds.has(message.id)) {
        return;
      }
      renderedMessageIds.add(message.id);
    }

    // Check if the user is already scrolled near the bottom before adding the new message
    const distanceFromBottom =
      chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight;
    const shouldAutoScroll = distanceFromBottom <= 60 || message.senderId === socket.id;

    const row = document.createElement('div');
    row.className = message.type === 'system' ? 'chat-message chat-system' : 'chat-message';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = formatChatTimestamp(message.timestamp);
    row.appendChild(timeSpan);

    if (message.type !== 'system') {
      const senderSpan = document.createElement('span');
      senderSpan.className = 'chat-sender';
      senderSpan.textContent = `${message.sender || 'User'}:`;
      row.appendChild(senderSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = message.text;
    row.appendChild(textSpan);

    chatMessagesEl.appendChild(row);

    if (shouldAutoScroll) {
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }
  }

  if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const rawText = chatInput.value;
      if (typeof rawText !== 'string' || rawText.trim() === '') {
        chatInput.value = '';
        return;
      }

      socket.emit('chat-message', { text: rawText.trim() });
      chatInput.value = '';
    });
  }

  // ==========================================================================
  // HTML5 <video> Event Listeners
  // ==========================================================================

  videoPlayer.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
    seekBar.max = String(duration || 100);
    durationTimeEl.textContent = formatTime(duration);
    playPauseBtn.disabled = false;
    seekBar.disabled = false;

    if (loadedVideoFile && duration > 0) {
      socket.emit('video-metadata', {
        videoFile: loadedVideoFile,
        duration
      });
    }

    if (pendingServerState) {
      const stateToApply = pendingServerState;
      pendingServerState = null;
      applyPlaybackPositionAndStatus(stateToApply, 0.1);
    }
  });

  videoPlayer.addEventListener('timeupdate', () => {
    updateTimelineUI();
  });

  videoPlayer.addEventListener('play', () => {
    updatePlayPauseUI();
  });

  videoPlayer.addEventListener('pause', () => {
    updatePlayPauseUI();
  });

  videoPlayer.addEventListener('ended', () => {
    updatePlayPauseUI();
    if (!isApplyingServerState && loadedVideoFile) {
      socket.emit('video-ended', {
        currentTime: videoPlayer.duration || videoPlayer.currentTime
      });
    }
  });

  videoPlayer.addEventListener('volumechange', () => {
    updateVolumeUI();
  });

  videoPlayer.addEventListener('click', () => {
    toggleUserPlayPause();
  });

  // ==========================================================================
  // Custom Control Bar Event Listeners
  // ==========================================================================

  playPauseBtn.addEventListener('click', () => {
    toggleUserPlayPause();
  });

  seekBar.addEventListener('input', () => {
    isDraggingSeekBar = true;
    const previewTime = Number(seekBar.value) || 0;
    currentTimeEl.textContent = formatTime(previewTime);
  });

  seekBar.addEventListener('change', () => {
    const finalTime = Number(seekBar.value) || 0;
    isDraggingSeekBar = false;
    commitUserSeek(finalTime);
  });

  muteBtn.addEventListener('click', () => {
    toggleLocalMute();
  });

  unmuteBannerBtn.addEventListener('click', () => {
    videoPlayer.muted = false;
    if (videoPlayer.volume === 0) {
      videoPlayer.volume = 1;
    }
    autoplayBanner.hidden = true;
    updateVolumeUI();
  });

  volumeSlider.addEventListener('input', () => {
    const newVolume = Number(volumeSlider.value);
    videoPlayer.volume = newVolume;
    videoPlayer.muted = newVolume === 0;
    updateVolumeUI();
  });

  resyncBtn.addEventListener('click', () => {
    socket.emit('request-sync');
  });

  fullscreenBtn.addEventListener('click', () => {
    toggleFullscreen();
  });

  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = Boolean(document.fullscreenElement);
    iconFullscreenEnter.hidden = isFullscreen;
    iconFullscreenExit.hidden = !isFullscreen;
  });

  // ==========================================================================
  // Video Selection & Drag-and-Drop MP4 Handling
  // ==========================================================================

  if (videoSelectorToggle && videoSelectorMenu) {
    videoSelectorToggle.addEventListener('click', () => {
      const willOpen = videoSelectorMenu.hidden;
      videoSelectorMenu.hidden = !willOpen;
      videoSelectorToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  }

  document.addEventListener('click', (event) => {
    if (
      videoSelectorDropdown &&
      videoSelectorMenu &&
      !videoSelectorMenu.hidden &&
      !videoSelectorDropdown.contains(event.target)
    ) {
      closeVideoSelectorMenu();
    }
  });

  if (videoSelect) {
    videoSelect.addEventListener('change', () => {
      const selectedFile = videoSelect.value;
      if (selectedFile) {
        socket.emit('select-video', { videoFile: selectedFile });
      }
    });
  }

  refreshVideosBtn.addEventListener('click', () => {
    fetchVideoListAndNetworkInfo();
  });

  addVideoBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleProvidedVideoFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  /**
   * Handles a dropped or selected MP4 file from the browser:
   * - If the file already exists in /videos (matching name and byte size), selects it immediately.
   * - Otherwise, streams it to the Node.js server's /videos folder so both users can watch it.
   */
  async function handleProvidedVideoFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.mp4')) {
      uploadStatusEl.textContent = 'Only .mp4 video files are supported.';
      return;
    }

    const existingMatch = availableVideos.find(
      (item) => item.name === file.name && item.size === file.size
    );

    if (existingMatch) {
      uploadStatusEl.textContent = `Selected ${file.name}`;
      socket.emit('select-video', { videoFile: existingMatch.name });
      setTimeout(() => {
        uploadStatusEl.textContent = '';
      }, 3000);
      return;
    }

    try {
      addVideoBtn.disabled = true;
      uploadStatusEl.textContent = `Loading ${file.name} onto server...`;

      const response = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'video/mp4'
        },
        body: file
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to upload MP4 file.');
      }

      uploadStatusEl.textContent = `Loaded ${file.name}`;
      setTimeout(() => {
        uploadStatusEl.textContent = '';
      }, 3000);
    } catch (error) {
      uploadStatusEl.textContent = error.message || 'Error loading video.';
    } finally {
      addVideoBtn.disabled = false;
    }
  }

  // Drag and drop listeners on the player container
  playerContainer.addEventListener('dragover', (event) => {
    event.preventDefault();
    playerContainer.classList.add('drag-over');
  });

  playerContainer.addEventListener('dragleave', (event) => {
    if (!playerContainer.contains(event.relatedTarget)) {
      playerContainer.classList.remove('drag-over');
    }
  });

  playerContainer.addEventListener('drop', (event) => {
    event.preventDefault();
    playerContainer.classList.remove('drag-over');

    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length > 0) {
      handleProvidedVideoFile(files[0]);
    }
  });

  // ==========================================================================
  // Keyboard Shortcuts
  // ==========================================================================

  /**
   * Returns true if the user is currently typing in a text field (such as chat)
   * or interacting with a select/dialog so video shortcuts do not interfere.
   */
  function isTypingInInput(target) {
    if (deleteConfirmDialog && deleteConfirmDialog.open) {
      return true;
    }
    if (!target) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tagName = target.tagName ? target.tagName.toUpperCase() : '';
    if (tagName === 'TEXTAREA' || tagName === 'SELECT') {
      return true;
    }
    if (tagName === 'INPUT') {
      const inputType = (target.type || '').toLowerCase();
      return inputType !== 'range' && inputType !== 'button';
    }
    return false;
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && videoSelectorMenu && !videoSelectorMenu.hidden) {
      closeVideoSelectorMenu();
      return;
    }

    if (isTypingInInput(event.target)) {
      return;
    }

    // Ignore shortcuts when modifier keys (Ctrl, Alt, Meta) are pressed
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    switch (event.key) {
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        toggleUserPlayPause();
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (loadedVideoFile) {
          commitUserSeek((videoPlayer.currentTime || 0) - 5);
        }
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (loadedVideoFile) {
          commitUserSeek((videoPlayer.currentTime || 0) + 5);
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        adjustLocalVolume(0.05);
        break;
      }
      case 'ArrowDown': {
        event.preventDefault();
        adjustLocalVolume(-0.05);
        break;
      }
      case 'f':
      case 'F': {
        event.preventDefault();
        toggleFullscreen();
        break;
      }
      case 'm':
      case 'M': {
        event.preventDefault();
        toggleLocalMute();
        break;
      }
      default:
        break;
    }
  });

  // ==========================================================================
  // Socket.IO Connection, Synchronization & Chat Listeners
  // ==========================================================================

  socket.on('connect', () => {
    connectionIndicator.classList.remove('status-disconnected');
    connectionIndicator.classList.add('status-connected');
    connectionStatusText.textContent = 'Connected';

    socket.emit('request-sync');
    fetchVideoListAndNetworkInfo();
  });

  socket.on('disconnect', () => {
    connectionIndicator.classList.remove('status-connected');
    connectionIndicator.classList.add('status-disconnected');
    connectionStatusText.textContent = 'Disconnected - Reconnecting...';
  });

  socket.on('user-count', (payload = {}) => {
    const count = Number(payload.count) || 0;
    viewerCountEl.textContent = `${count} connected`;
  });

  socket.on('video-list', (payload = {}) => {
    renderVideoDropdown(payload.videos || []);
  });

  socket.on('sync-state', (state) => {
    applyServerState(state);
  });

  socket.on('drift-check', (state) => {
    if (!state || !loadedVideoFile || state.videoFile !== loadedVideoFile) {
      return;
    }
    if (isDraggingSeekBar || videoPlayer.readyState < 2) {
      return;
    }
    applyPlaybackPositionAndStatus(state, DRIFT_TOLERANCE_SECONDS);
  });

  socket.on('chat-identity', (payload = {}) => {
    if (chatUsernameBadge && payload.username) {
      chatUsernameBadge.textContent = `You: ${payload.username}`;
    }
  });

  socket.on('chat-history', (payload = {}) => {
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) {
        appendChatMessage(msg);
      }
    }
  });

  socket.on('chat-message', (message) => {
    appendChatMessage(message);
  });

  // Initial load of video list and network URLs
  updateVolumeUI();
  fetchVideoListAndNetworkInfo();
})();
