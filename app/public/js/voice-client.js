(function () {
  // Centralized config for how long to ignore interim
  // transcripts after a user submits a message.
  var TRANSCRIPT_IGNORE_WINDOW_MS = 2000;

  // ===== Toast/Flash Message System =====
  var toastContainer = null;
  var toastIdCounter = 0;

  function getToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) {
      return toastContainer;
    }
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    toastContainer.setAttribute("role", "alert");
    toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastContainer);
    return toastContainer;
  }

  function getToastIcon(type) {
    var icons = {
      info: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
      warning: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
      error: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
      success: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    };
    return icons[type] || icons.info;
  }

  /**
   * Show a toast/flash message. User must explicitly close.
   * @param {Object} options
   * @param {string} options.message - The message to display (can include HTML with links)
   * @param {string} [options.type="info"] - One of: info, warning, error, success
   * @returns {string} Toast ID for manual dismissal
   */
  function showToast(options) {
    var message = options.message || "";
    var type = options.type || "info";

    var container = getToastContainer();
    var id = "toast-" + ++toastIdCounter;

    var toast = document.createElement("div");
    toast.id = id;
    toast.className = "toast toast--" + type;

    var iconDiv = document.createElement("div");
    iconDiv.className = "toast__icon";
    iconDiv.innerHTML = getToastIcon(type);

    var contentDiv = document.createElement("div");
    contentDiv.className = "toast__content";

    var messageDiv = document.createElement("div");
    messageDiv.className = "toast__message";
    messageDiv.innerHTML = message; // Allow HTML content

    contentDiv.appendChild(messageDiv);

    var closeBtn = document.createElement("button");
    closeBtn.className = "toast__close";
    closeBtn.setAttribute("aria-label", "Dismiss");
    closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

    toast.appendChild(iconDiv);
    toast.appendChild(contentDiv);
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    closeBtn.addEventListener("click", function () {
      toast.classList.add("toast--exiting");
      setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 200);
    });

    return id;
  }

  // Expose showToast globally for use by other scripts
  window.showToast = showToast;
  function toWsUrl(pathOrUrl) {
    try {
      var url = new URL(pathOrUrl, window.location.origin);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    } catch (e) {
      // Fallback to same-origin relative
      var origin = window.location.origin.replace(/^http/, "ws");
      return origin + pathOrUrl;
    }
  }

  /**
   * Converts an ArrayBuffer to a base64 string.
   * @param {ArrayBuffer|Float32Array|Int16Array} arrayBuffer - The ArrayBuffer to convert.
   * @returns {string} The resulting base64 string.
   */
  function arrayBufferToBase64(arrayBuffer) {
    if (arrayBuffer instanceof Float32Array) {
      arrayBuffer = this.floatTo16BitPCM(arrayBuffer);
    } else if (arrayBuffer instanceof Int16Array) {
      arrayBuffer = arrayBuffer.buffer;
    }
    let binary = "";
    let bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000; // 32KB chunk size
    for (let i = 0; i < bytes.length; i += chunkSize) {
      let chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /**
   * Decodes a base64 string into an ArrayBuffer.
   * @param {string} base64
   * @returns {ArrayBuffer}
   */
  function base64ToArrayBuffer(base64) {
    var binaryString = atob(base64);
    var len = binaryString.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function VoiceClient(rootEl) {
    this.rootEl = rootEl;
    this.voicePath = rootEl && rootEl.getAttribute("data-voice-ws");
    this.wsUrl = this.voicePath ? toWsUrl(this.voicePath) : null;
    this.ws = null;
    this._shouldReconnect = true;
    this._needsReconnect = false;
    this._hasConnectionErrorToast = false;
    this._boundOnHtmxBeforeMessage = null;

    // Match Deepgram input and Rime output sample rates
    // Important: Worker is configured for 8 kHz input to Deepgram
    this.recorder = new (window.WavRecorder || function () {})({
      sampleRate: 8000,
    });
    this.player = new (window.WavStreamPlayer || function () {})({
      sampleRate: 24000,
    });

    this.textarea = document.getElementById("chat-input");
    this.stopBtn = document.getElementById("stop-audio");
    this.micBtn = document.getElementById("mic-toggle");
    this._isMuted = false;
    this._needsPermission = true;
    this._permissionState = "prompt";
    this._chunkSize = 4096;
    this._chunkProcessor = null;
    this._micReady = false;

    this._boundOnMessage = this._onWsMessage.bind(this);
    this._boundOnClose = this._onWsClose.bind(this);

    // Anchor-based text merging model
    // userText: text owned by user (before anchor) - server cannot modify
    // serverText: current active segment from server (after anchor) - replaced by interims
    this._userText = this.textarea ? this.textarea.value : "";
    this._serverText = ""; // Current interim/active segment
    this._isComposing = false; // IME composition state
    // Transcript gating to ignore late/in-flight deltas after submit
    this._ignoreTranscript = false;
    this._ignoreTranscriptTimer = null;
    this._voiceIdleMs = 5 * 60 * 1000;
    this._voiceIdleTimer = null;
    this._voiceTimedOut = false;
    this._showPowered = false;
  }

  VoiceClient.prototype.init = async function () {
    if (!this.wsUrl) {
      if (vdebug()) console.log("[voice-client] init: no wsUrl, returning early");
      return;
    }
    if (vdebug()) console.log("[voice-client] init: wsUrl=", this.wsUrl);
    var self = this;
    if (!this._boundOnHtmxBeforeMessage) {
      this._boundOnHtmxBeforeMessage = function (event) {
        var message = event.detail && event.detail.message;
        if (typeof message !== "string") return;
        self.noteActivity();
        try {
          var parsed = JSON.parse(message);
          if (parsed && parsed.type === "assistant.sentence" && typeof parsed.content === "string") {
            if (self.ws && self.ws.readyState === WebSocket.OPEN) {
              self.ws.send(
                JSON.stringify({
                  type: "tts.speak",
                  text: parsed.content,
                }),
              );
            }
            event.preventDefault();
          }
        } catch {
          // Not JSON, let HTMX handle it as HTML
        }
      };
      document.body.addEventListener("htmx:wsBeforeMessage", this._boundOnHtmxBeforeMessage);
    }

    this._wireUi();
    this._connectWs();
    // Try to auto-start mic only if permission is already granted.
    this._needsPermission = false;
    this._isMuted = true;
    this._micReady = false;
    this._reflectMicUi();
    if (navigator.permissions && typeof navigator.permissions.query === "function") {
      navigator.permissions
        .query({ name: "microphone" })
        .then(function (status) {
          if (!self._shouldReconnect) return;
          self._permissionState = status.state;
          if (status.state === "granted") {
            if (!self._micReady) self._startMicWithFallback();
            return;
          }
          self._needsPermission = true;
          self._isMuted = true;
          self._micReady = false;
          self._reflectMicUi();
        })
        .catch(function () {});
    } else {
      this._needsPermission = true;
      this._reflectMicUi();
    }

    try {
      // Prepare audio playback early
      if (this.player && typeof this.player.connect === "function") {
        // Set up callback to hide stop button when playback finishes
        this.player.onPlaybackStop = function () {
          self._setPlaying(false);
        };
        var playerConnect = this.player.connect();
        if (playerConnect && typeof playerConnect.catch === "function") {
          playerConnect.catch(function () {});
        }
      }
    } catch (e) {
      // console.warn("[voice] Failed to initialize player:", e);
    }
    if (vdebug()) {
      try {
        console.log(
          "[voice-client] init sampleRates rec/ttsp=",
          this.recorder && this.recorder.sampleRate,
          "/",
          this.player && this.player.sampleRate,
          "chunk=",
          this._chunkSize,
          "ws=",
          this.wsUrl,
        );
      } catch (_) {}
    }
  };

  VoiceClient.prototype._wireUi = function () {
    var self = this;
    if (this.stopBtn) {
      this.stopBtn.addEventListener("click", function () {
        self.stopPlayback();
        self._setPlaying(false);
      });
    }
    // Delegated listener for in-bubble audio control buttons
    var messageList = document.getElementById("chat-message-list");
    if (messageList) {
      messageList.addEventListener("click", function (e) {
        self._handleAudioControlClick(e);
      });
    }
    // Try to resume audio on user gesture
    var composer = document.querySelector("form[data-chat-composer]");
    if (composer) {
      // Capture-phase to ensure we see submits even if other libs stop propagation
      composer.addEventListener(
        "submit",
        function () {
          // Stop any currently playing audio response
          try {
            self.stopPlayback();
          } catch (_) {}
          // On submit, ignore any in-flight transcript deltas from this turn
          // for a short window to avoid stray late transcripts.
          try {
            self.ignoreTranscriptForMs(TRANSCRIPT_IGNORE_WINDOW_MS);
          } catch (_) {
            // Fallback to immediate ignore without timer
            self._ignoreTranscript = true;
          }
          try {
            self._endTranscriptTurn();
          } catch (_) {}
          try {
            if (!self.player) return;
            if (
              !self.player.context ||
              self.player.context.state === "suspended"
            ) {
              self.player.connect();
            }
          } catch (e) {}
        },
        true,
      );
    }

    if (this.textarea) {
      // Controlled textarea: intercept all input before browser applies it
      this.textarea.addEventListener("beforeinput", function (e) {
        if (self._isComposing) return; // Let IME handle composition
        e.preventDefault();
        self._handleInput(e.inputType, e.data);
      });

      // IME composition handling
      this.textarea.addEventListener("compositionstart", function () {
        self._isComposing = true;
      });
      this.textarea.addEventListener("compositionend", function (e) {
        self._isComposing = false;
        // Apply the composed text
        self._handleInput("insertText", e.data);
      });
    }
  };

  // Get display text from our model
  VoiceClient.prototype._getDisplayText = function () {
    return this._userText + this._serverText;
  };

  // Single render point - update textarea from our model
  // Accepts either a single cursor position or { start, end } for selection
  VoiceClient.prototype._render = function (selection) {
    var ta = this.textarea;
    if (!ta) return;
    var value = this._getDisplayText();
    ta.value = value;
    if (typeof selection === "number") {
      var pos = Math.min(Math.max(0, selection), value.length);
      ta.selectionStart = ta.selectionEnd = pos;
    } else if (selection && typeof selection.start === "number") {
      ta.selectionStart = Math.min(Math.max(0, selection.start), value.length);
      ta.selectionEnd = Math.min(Math.max(0, selection.end), value.length);
    }
  };

  // Commit server text to user text (user takes ownership)
  VoiceClient.prototype._commitServerText = function () {
    this._userText = this._getDisplayText();
    this._serverText = "";
  };

  // Pure function: apply an edit to a string, returns { value, cursor }
  VoiceClient.prototype._applyEdit = function (value, start, end, inputType, data) {
    var newValue = value;
    var newCursor = start;

    switch (inputType) {
      case "insertText":
      case "insertFromPaste":
      case "insertFromDrop":
      case "insertReplacementText":
        var text = data || "";
        newValue = value.slice(0, start) + text + value.slice(end);
        newCursor = start + text.length;
        break;

      case "insertLineBreak":
      case "insertParagraph":
        newValue = value.slice(0, start) + "\n" + value.slice(end);
        newCursor = start + 1;
        break;

      case "deleteContentBackward":
        if (start === end && start > 0) {
          newValue = value.slice(0, start - 1) + value.slice(end);
          newCursor = start - 1;
        } else if (start !== end) {
          newValue = value.slice(0, start) + value.slice(end);
          newCursor = start;
        }
        break;

      case "deleteContentForward":
        if (start === end && start < value.length) {
          newValue = value.slice(0, start) + value.slice(end + 1);
          newCursor = start;
        } else if (start !== end) {
          newValue = value.slice(0, start) + value.slice(end);
          newCursor = start;
        }
        break;

      case "deleteWordBackward":
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        if (start === end && start > 0) {
          var before = value.slice(0, start);
          var match = before.match(/\S*\s*$/);
          var deleteLen = match ? match[0].length : 1;
          newValue = value.slice(0, start - deleteLen) + value.slice(end);
          newCursor = start - deleteLen;
        } else if (start !== end) {
          newValue = value.slice(0, start) + value.slice(end);
          newCursor = start;
        }
        break;

      case "deleteWordForward":
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        if (start === end && start < value.length) {
          var after = value.slice(start);
          var matchFwd = after.match(/^\s*\S*/);
          var deleteLenFwd = matchFwd ? matchFwd[0].length : 1;
          newValue = value.slice(0, start) + value.slice(end + deleteLenFwd);
          newCursor = start;
        } else if (start !== end) {
          newValue = value.slice(0, start) + value.slice(end);
          newCursor = start;
        }
        break;

      case "deleteByCut":
        newValue = value.slice(0, start) + value.slice(end);
        newCursor = start;
        break;

      default:
        // Unknown input type - no change
        break;
    }

    return { value: newValue, cursor: newCursor };
  };

  // Handle all user input - commits server text first, then applies edit
  VoiceClient.prototype._handleInput = function (inputType, data) {
    var ta = this.textarea;
    if (!ta) return;

    var start = ta.selectionStart;
    var end = ta.selectionEnd;

    // Step 1: Commit any pending server text to user text
    // This ensures user edits always "win" - they own the text
    this._commitServerText();

    // Step 2: Apply the edit to userText
    var result = this._applyEdit(this._userText, start, end, inputType, data);
    this._userText = result.value;

    // Step 3: Render
    this._render(result.cursor);
  };

  // Handle server segment update (from Deepgram)
  VoiceClient.prototype._handleServerSegment = function (text, isFinal) {
    var ta = this.textarea;
    var selection = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : { start: 0, end: 0 };

    // Both interim and final: update serverText with the new text
    // (final text replaces any interim text for the same segment)
    var separator = this._userText && text ? " " : "";
    this._serverText = separator + text;

    if (isFinal) {
      // Commit serverText to userText
      this._userText = this._getDisplayText();
      this._serverText = "";
    }

    // Render, preserving selection
    this._render(selection);
  }

  VoiceClient.prototype._connectWs = function () {
    var self = this;
    if (!this.wsUrl) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      if (vdebug()) console.log("[voice-client] connecting", this.wsUrl);
      this._hasConnectionErrorToast = false;
      this._needsReconnect = false;
      this._reflectMicUi();
      if (this.micBtn) {
        this.micBtn.classList.remove("is-connected");
        this.micBtn.classList.add("is-connecting");
        this.micBtn.setAttribute("data-connecting", "true");
      }
      var ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener("message", this._boundOnMessage);
      ws.addEventListener("open", function () {
        try {
          if (self.ws !== ws) return;
          if (self.micBtn) {
            self.micBtn.classList.remove("is-connecting");
            self.micBtn.classList.add("is-connected");
            self.micBtn.removeAttribute("data-connecting");
          }
          self._hasConnectionErrorToast = false;
          self._needsReconnect = false;
          self._reflectMicUi();
          if (vdebug()) console.log("[voice-client] ws_open");
        } catch (_) {}
      });
      ws.addEventListener("close", function (ev) {
        if (vdebug()) console.log("[voice-client] ws_close code=", ev.code, "reason=", ev.reason);
        self._boundOnClose(ev, ws);
      });
      ws.addEventListener("error", function (ev) {
        if (vdebug()) console.error("[voice-client] ws_error", ev);
        if (self.ws !== ws) return;
        if (!self._shouldReconnect) return;
        if (self.micBtn) {
          self.micBtn.removeAttribute("data-connecting");
        }
        self._needsReconnect = true;
        self._reflectMicUi();
        if (!self._hasConnectionErrorToast) {
          self._hasConnectionErrorToast = true;
          showToast({
            type: "error",
            message: "Unable to connect to the voice service. Click Enable Voice Mode to retry.",
          });
        }
      });
    } catch (e) {
      // console.warn("[voice] Failed to open websocket", e);
      this._needsReconnect = true;
      if (this.micBtn) {
        this.micBtn.classList.remove("is-connecting");
        this.micBtn.classList.remove("is-connected");
        this.micBtn.removeAttribute("data-connecting");
      }
      this._reflectMicUi();
      if (!this._hasConnectionErrorToast) {
        this._hasConnectionErrorToast = true;
        showToast({
          type: "error",
          message: "Unable to connect to the voice service. Click Enable Voice Mode to retry.",
        });
      }
    }
  };

  VoiceClient.prototype.teardown = function () {
    this._shouldReconnect = false;
    this._micReady = false;
    if (this.micBtn) {
      this.micBtn.classList.remove("is-connected");
      this.micBtn.classList.remove("is-connecting");
      this.micBtn.removeAttribute("data-connecting");
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "teardown");
      } catch (_) {}
      this.ws = null;
    }
    if (this._boundOnHtmxBeforeMessage) {
      document.body.removeEventListener("htmx:wsBeforeMessage", this._boundOnHtmxBeforeMessage);
      this._boundOnHtmxBeforeMessage = null;
    }
    if (this.recorder && typeof this.recorder.quit === "function") {
      this.recorder.quit().catch(function () {});
    }
    this._clearVoiceIdleTimer();
    this._voiceTimedOut = false;
    this.stopPlayback();
  };

  VoiceClient.prototype._clearVoiceIdleTimer = function () {
    if (!this._voiceIdleTimer) return;
    window.clearTimeout(this._voiceIdleTimer);
    this._voiceIdleTimer = null;
  };

  VoiceClient.prototype.noteActivity = function () {
    if (this._isMuted || this._voiceTimedOut) return;
    this._clearVoiceIdleTimer();
    var self = this;
    this._voiceIdleTimer = window.setTimeout(function () {
      self._voiceIdleTimer = null;
      if (self._isMuted || self._voiceTimedOut) return;
      self._voiceTimedOut = true;
      self.setMuted(true).catch(function () {});
      if (vdebug()) {
        try { console.log("[voice-client] voice mode timed out"); } catch (_) {}
      }
    }, this._voiceIdleMs);
  };

  VoiceClient.prototype._startMic = async function () {
    if (!this.recorder || typeof this.recorder.begin !== "function") return;
    try {
      await this.recorder.begin();
      if (vdebug()) {
        try {
          console.log("[voice-client] mic_begin ok rate=", this.recorder.sampleRate);
        } catch (_) {}
      }
      var self = this;
      this._chunkProcessor = function (data) {
        try {
          // Send mono 16-bit PCM audio
          var base64 = arrayBufferToBase64(data.mono);
          self._sendAudio(base64);
          self.__uplinkCount = (self.__uplinkCount || 0) + 1;
          if ((self.__uplinkCount <= 3 || self.__uplinkCount % 50 === 0) && vdebug()) {
            console.debug("[voice-client] uplink_frame #", self.__uplinkCount, "bytes=", data.mono.byteLength);
          }
        } catch (e) {
          // console.warn("[voice] Failed to encode/send audio chunk", e);
        }
      };
      await this.recorder.record(this._chunkProcessor, this._chunkSize);
      this._micReady = true;
      if (vdebug()) {
        try { console.log("[voice-client] mic_recording started chunk=", this._chunkSize); } catch (_) {}
      }
    } catch (e) {
      // console.warn("[voice] Microphone failed to start:", e);
      throw e;
    }
  };

  // localStorage key for persisting mute state across agent switches
  var MIC_MUTED_STORAGE_KEY = "voice-mic-muted";

  // Try to start mic automatically; if it fails (iOS needs user gesture), show "Enable Voice Mode"
  VoiceClient.prototype._startMicWithFallback = async function () {
    // Load persisted mute state from localStorage
    var persistedMuted = false;
    try {
      persistedMuted = localStorage.getItem(MIC_MUTED_STORAGE_KEY) === "true";
    } catch (_) {}

    try {
      await this._startMic();
      this._needsPermission = false;
      this._permissionState = "granted";
      // Apply persisted mute state after successful mic start
      if (persistedMuted) {
        this._isMuted = true;
        // Pause the recorder since user wants to be muted
        if (this.recorder && this.recorder.recording && typeof this.recorder.pause === "function") {
          await this.recorder.pause();
        }
        this._clearVoiceIdleTimer();
      } else {
        this._isMuted = false;
        this._voiceTimedOut = false;
        this.noteActivity();
      }
    } catch (e) {
      // Mic failed to start (permission denied or iOS requires user gesture)
      this._needsPermission = true;
      this._isMuted = true;
      this._micReady = false;
      this._clearVoiceIdleTimer();
      if (vdebug()) {
        var errorName = e && e.name ? e.name : "";
        try { console.log("[voice-client] mic needs permission:", errorName, e.message); } catch (_) {}
      }
    }
    this._reflectMicUi();
  };

  // Called when user clicks mic button to enable voice mode
  VoiceClient.prototype._enableVoiceMode = async function () {
    try {
      if (this._permissionState === "denied") {
        this._needsPermission = true;
        this._isMuted = true;
        this._micReady = false;
        this._reflectMicUi();
        showToast({
          type: "warning",
          message: "Microphone permission is blocked. Enable it in your browser site settings to use voice mode.",
        });
        return;
      }
      if (this.recorder && typeof this.recorder.quit === "function") {
        this.recorder.quit().catch(function () {});
      }
      await this._startMic();
      this._needsPermission = false;
      this._isMuted = false;
      this._permissionState = "granted";
      this._voiceTimedOut = false;
      // Persist unmuted state when voice mode is enabled
      try {
        localStorage.setItem(MIC_MUTED_STORAGE_KEY, "false");
      } catch (_) {}
      this._reflectMicUi();
      this.noteActivity();
      if (vdebug()) {
        try { console.log("[voice-client] voice mode enabled"); } catch (_) {}
      }
    } catch (e) {
      // Check if permission was denied
      var errorName = e && e.name ? e.name : "";
      if (vdebug()) {
        try { console.log("[voice-client] voice mode enable failed:", errorName, e.message); } catch (_) {}
      }
      // NotAllowedError means permission denied (either by user or browser policy)
      // NotFoundError means no microphone available
      if (errorName === "NotAllowedError") {
        this._permissionState = "denied";
        this._needsPermission = true;
        this._isMuted = true;
        this._micReady = false;
        this._reflectMicUi();
        showToast({
          type: "warning",
          message: "Microphone permission was denied. Enable it in your browser site settings to use voice mode.",
        });
      } else if (errorName === "NotFoundError") {
        showToast({
          type: "error",
          message: "No microphone found. Connect a microphone and try again.",
        });
      } else {
        showToast({
          type: "error",
          message: "Unable to start the microphone. Reload the page and try again.",
        });
      }
    }
  };

  VoiceClient.prototype.setMuted = async function (muted) {
    // If we need permission, clicking the button should enable voice mode
    if (this._needsPermission && !muted) {
      await this._enableVoiceMode();
      return;
    }
    if (!muted && !this._micReady) {
      await this._enableVoiceMode();
      return;
    }
    this._isMuted = !!muted;
    if (this._isMuted) {
      this._clearVoiceIdleTimer();
    } else {
      this._voiceTimedOut = false;
    }
    // Persist mute state to localStorage for cross-agent-switch persistence
    try {
      localStorage.setItem(MIC_MUTED_STORAGE_KEY, String(this._isMuted));
    } catch (_) {}
    try {
      if (!this.recorder) return;
      if (this._isMuted) {
        if (
          this.recorder.recording &&
          typeof this.recorder.pause === "function"
        ) {
          await this.recorder.pause();
        }
      } else {
        if (
          !this.recorder.recording &&
          typeof this.recorder.record === "function"
        ) {
          await this.recorder.record(
            this._chunkProcessor || function () {},
            this._chunkSize,
          );
        }
      }
    } catch (_) {}
    this._reflectMicUi();
    if (!this._isMuted) {
      this.noteActivity();
    }
    if (vdebug()) {
      try { console.log("[voice-client] mic_muted=", this._isMuted); } catch (_) {}
    }
  };

  VoiceClient.prototype._reflectMicUi = function () {
    var btn = this.micBtn;
    if (!btn) return;
    try {
      btn.setAttribute("data-muted", String(this._isMuted));
      btn.setAttribute("aria-pressed", String(!this._isMuted));
      if (this._showPowered && !this._needsPermission) {
        this._showPowered = false;
      }
      if (this._showPowered && this._needsPermission) {
        btn.setAttribute("data-powered", "true");
      } else {
        btn.removeAttribute("data-powered");
      }
      // Show/hide "Enable Voice Mode" text
      if (this._needsPermission || this._needsReconnect || this._voiceTimedOut) {
        btn.setAttribute("data-needs-permission", "true");
      } else {
        btn.removeAttribute("data-needs-permission");
      }
    } catch (_) {}
  };

  VoiceClient.prototype._sendAudio = function (base64) {
    var ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "client.audio", content: base64 }));
    } catch (e) {
      // Ignore send errors; will retry on next chunk
    }
  };

  // No client-initiated TTS requests; backend triggers Rime TTS on final messages

  VoiceClient.prototype._onWsMessage = function (event) {
    var text;
    if (typeof event.data === "string") {
      text = event.data;
    } else if (event.data instanceof Blob) {
      // Ignore binary
      return;
    } else if (event.data instanceof ArrayBuffer) {
      try {
        text = new TextDecoder().decode(event.data);
      } catch (e) {
        return;
      }
    } else if (ArrayBuffer.isView(event.data)) {
      try {
        text = new TextDecoder().decode(
          event.data.buffer.slice(
            event.data.byteOffset,
            event.data.byteOffset + event.data.byteLength,
          ),
        );
      } catch (e) {
        return;
      }
    }
    if (!text) return;
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    var t = msg.type;
    if (t && vdebug()) console.log("[voice-client] rx:", t);
    if (t === "user.transcript.interim_delta") {
      this.noteActivity();
      // Timed ignore window after submit to drop stray late transcripts
      if (this._ignoreTranscript) {
        return;
      }

      var text = typeof msg.text === "string" ? msg.text : "";
      var isFinal = !!msg.final;

      if (vdebug()) console.debug("[voice-client] stt len=", text.length, "final=", isFinal);

      this._handleServerSegment(text, isFinal);
      return;
    }
    // Legacy turn-end gating removed; timed ignore window is used instead.
    if (t === "response.audio" && typeof msg.content === "string") {
      try {
        var pcm = base64ToArrayBuffer(msg.content);
        if (vdebug()) console.debug("[voice-client] tts_chunk bytes=", pcm.byteLength, "turn_id=", msg.turn_id);
        if (this.player && typeof this.player.add16BitPCM === "function") {
          this.player.add16BitPCM(pcm, String(msg.turn_id || "default"));
          // Show stop button when audio starts playing
          this._setPlaying(true);
        }
      } catch (e) {
        // console.warn("[voice] Failed to decode/play audio chunk", e);
      }
      return;
    }
    // Handle server notifications (toast messages from server)
    if (t === "server.notification" && typeof msg.message === "string") {
      showToast({
        message: msg.message,
        type: msg.tone || "info",
      });
      return;
    }
  };

  VoiceClient.prototype._onWsClose = function (_ev, ws) {
    if (ws && this.ws !== ws) return;
    if (!this._shouldReconnect) return;
    this._needsReconnect = true;
    try {
      if (this.micBtn) {
        this.micBtn.classList.remove("is-connected");
        this.micBtn.classList.remove("is-connecting");
        this.micBtn.removeAttribute("data-connecting");
      }
    } catch (_) {}
    this._reflectMicUi();
  };

  // End transcript turn - commit any pending server text to user text
  VoiceClient.prototype._endTranscriptTurn = function () {
    var ta = this.textarea;
    var selection = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : { start: 0, end: 0 };
    this._commitServerText();
    this._render(selection);
  };

  VoiceClient.prototype.stopPlayback = function () {
    if (!this.player || typeof this.player.getTrackSampleOffset !== "function")
      return;
    this.player.getTrackSampleOffset(true).catch(function () {});
    this._setPlaying(false);
  };

  // Update stop button visibility and speaking message state
  VoiceClient.prototype._setPlaying = function (isPlaying) {
    this._isPlaying = !!isPlaying;
    if (this.stopBtn) {
      if (isPlaying) {
        this.stopBtn.classList.add("is-playing");
      } else {
        this.stopBtn.classList.remove("is-playing");
      }
    }
    // Update in-bubble audio controls: add/remove speaking class
    this._updateSpeakingMessage(isPlaying);
  };

  // Track the currently speaking message and show/hide audio controls
  VoiceClient.prototype._updateSpeakingMessage = function (isPlaying) {
    // Remove speaking class from any previous message
    var prevSpeaking = document.querySelector(".chat-message--speaking");
    if (prevSpeaking) {
      prevSpeaking.classList.remove("chat-message--speaking");
    }
    if (isPlaying) {
      // Find the most recent agent message and mark it as speaking
      var agentMessages = document.querySelectorAll(".chat-message--agent");
      if (agentMessages.length > 0) {
        var lastAgent = agentMessages[agentMessages.length - 1];
        lastAgent.classList.add("chat-message--speaking");
        this._speakingMessageEl = lastAgent;
      }
    } else {
      this._speakingMessageEl = null;
    }
  };

  // Handle clicks on in-bubble audio control buttons (delegated)
  VoiceClient.prototype._handleAudioControlClick = function (e) {
    var btn = e.target.closest(".chat-audio-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains("chat-audio-btn--stop")) {
      this.stopPlayback();
      this._setPlaying(false);
    }
  };

  // Public: ignore interim transcript deltas for a period (ms)
  VoiceClient.prototype.ignoreTranscriptForMs = function (ms) {
    var self = this;
    var dur = typeof ms === "number" && ms >= 0 ? ms : 2000;
    try {
      if (this._ignoreTranscriptTimer) {
        window.clearTimeout(this._ignoreTranscriptTimer);
        this._ignoreTranscriptTimer = null;
      }
    } catch (_) {}
    this._ignoreTranscript = true;
    if (vdebug()) {
      try { console.log("[voice-client] ignore_transcript start ms=", dur); } catch (_) {}
    }
    this._ignoreTranscriptTimer = window.setTimeout(function () {
      self._ignoreTranscript = false;
      self._ignoreTranscriptTimer = null;
      // When resuming, sync our model with current textarea content
      var ta = self.textarea;
      if (ta) {
        self._userText = ta.value || "";
        self._serverText = "";
      }
      if (vdebug()) {
        try { console.log("[voice-client] ignore_transcript end"); } catch (_) {}
      }
    }, dur);
  };

  var INIT_RETRY_DELAY_MS = 200;
  var INIT_MAX_RETRIES = 10;
  var initRetryCount = 0;
  var initRetryTimer = null;

  function scheduleInitRetry() {
    if (initRetryTimer || initRetryCount >= INIT_MAX_RETRIES) return;
    initRetryTimer = window.setTimeout(function () {
      initRetryTimer = null;
      initRetryCount++;
      initialize();
    }, INIT_RETRY_DELAY_MS);
  }

  function initialize() {
    // Initialize voice client for chat page (main.chat-app with data-voice-ws)
    var root = document.querySelector("main[data-voice-ws]");
    var micBtn = document.getElementById("mic-toggle");
    var existing = window.__voiceClient;

    if (!root) {
      if (existing && typeof existing.teardown === "function") {
        existing.teardown();
        window.__voiceClient = null;
      }
      if (vdebug()) console.log("[voice-client] no main[data-voice-ws] element found");
      return;
    }

    var voiceWsAttr = root.getAttribute("data-voice-ws");
    if (vdebug()) console.log("[voice-client] data-voice-ws=", voiceWsAttr);

    if (!window.WavRecorder || !window.WavStreamPlayer) {
      if (vdebug()) console.log("[voice-client] wavtools missing: WavRecorder=", !!window.WavRecorder, "WavStreamPlayer=", !!window.WavStreamPlayer);
      if (micBtn) scheduleInitRetry();
      return;
    }

    // Set default mic button state (will be updated once voice client initializes)
    if (micBtn) {
      micBtn.setAttribute("data-muted", "true");
      micBtn.removeAttribute("data-needs-permission");
    }

    initRetryCount = 0;

    if (existing && existing.rootEl === root && existing.wsUrl === toWsUrl(voiceWsAttr || "")) {
      if (micBtn) existing.micBtn = micBtn;
      existing.rootEl = root;
      existing.wsUrl = toWsUrl(voiceWsAttr || "");
      if (typeof existing._reflectMicUi === "function") {
        existing._reflectMicUi();
      }
      return;
    }

    if (existing && typeof existing.teardown === "function") {
      existing.teardown();
    }

    var client = new VoiceClient(root);
    client.init();
    // Expose for debugging
    window.__voiceClient = client;
  }

  function vdebug() {
    try {
      var flag = window.__DEBUG_LOG__ || localStorage.getItem("DEBUG_LOG");
      flag = typeof flag === "string" ? flag.toLowerCase() : flag;
      return flag === true || flag === "1" || flag === "true" || flag === "debug";
    } catch (e) {
      return false;
    }
  }

  function setupHtmxReinit() {
    if (window.__voiceClientNavHooked) return;
    window.__voiceClientNavHooked = true;
    document.body.addEventListener("htmx:afterSwap", function (e) {
      var target = e.detail && e.detail.target;
      if (!target || target.id !== "app-main") return;
      var micBtn = document.getElementById("mic-toggle");
      if (micBtn) {
        micBtn.classList.remove("is-connected");
        micBtn.classList.add("is-connecting");
      }
      window.setTimeout(initialize, 0);
    });
  }

  function setupMicToggleHandler() {
    if (window.__voiceClientMicHandler) return;
    window.__voiceClientMicHandler = true;
    document.addEventListener("click", function (e) {
      var target = e.target;
      if (!target || typeof target.closest !== "function") return;
      var btn = target.closest("#mic-toggle");
      if (!btn) return;
      e.preventDefault();
      initialize();
      var client = window.__voiceClient;
      if (!client) return;
      if (client._needsPermission) {
        client._showPowered = true;
        if (typeof client._reflectMicUi === "function") {
          client._reflectMicUi();
        }
      }
      if (vdebug()) {
        try {
          console.log("[voice-client] mic_toggle_click needsPermission=", client._needsPermission, "muted=", client._isMuted);
        } catch (_) {}
      }
      var ws = client.ws;
      var wsOpen = ws && ws.readyState === WebSocket.OPEN;
      if (!wsOpen) {
        client._connectWs();
        client.setMuted(false);
        return;
      }
      if (client._needsPermission !== false) {
        client.setMuted(false);
        return;
      }
      client.setMuted(!client._isMuted);
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    initialize();
    setupHtmxReinit();
    setupMicToggleHandler();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      initialize();
      setupHtmxReinit();
      setupMicToggleHandler();
    });
  }
})();
