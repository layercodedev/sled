(function () {
  var _chatSocketWrapper = null; // Global ref to htmx socketWrapper for chat session messages
  var _historyLoaded = false; // Track if history has been loaded
  var _audioContext = null; // Lazy-initialized Web Audio context
  var SIDEBAR_SCROLL_KEY = "sidebar-scroll-top";
  var NEW_AGENT_WORKDIR_KEY = "new-agent-workdir";

  function restoreSidebarScroll() {
    var sidebarContent = document.querySelector(".app-sidebar__content");
    if (!sidebarContent) return;
    var saved = null;
    try {
      saved = sessionStorage.getItem(SIDEBAR_SCROLL_KEY);
    } catch (_) {}
    if (saved === null) return;
    var parsed = parseInt(saved, 10);
    if (isNaN(parsed)) return;
    sidebarContent.scrollTop = parsed;
  }

  // Sound effects using Web Audio API (no files needed)
  var SoundEffects = {
    _getContext: function () {
      if (!_audioContext) {
        _audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      return _audioContext;
    },

    // Soft click/pop for tool completion
    toolComplete: function () {
      try {
        var ctx = this._getContext();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
      } catch (e) {
        // Silently ignore audio errors
      }
    },

    // Error sound - lower tone
    toolError: function () {
      try {
        var ctx = this._getContext();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 200;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
      } catch (e) {
        // Silently ignore audio errors
      }
    },

    // Message received - gentle chime
    messageReceived: function () {
      try {
        var ctx = this._getContext();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.setValueAtTime(800, ctx.currentTime + 0.05);
        osc.type = "sine";
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
      } catch (e) {
        // Silently ignore audio errors
      }
    },
  };

  // Observe for tool status changes to play sounds
  function setupSoundEffects() {
    var list = document.getElementById("chat-message-list");
    if (!list) return;

    // Use MutationObserver to detect tool status changes on tool message avatars
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type === "attributes" && mutation.attributeName === "class") {
          var target = mutation.target;
          // Check for tool avatar status classes
          if (target.classList.contains("chat-message__avatar--tool")) {
            if (target.classList.contains("chat-tool-icon--success")) {
              SoundEffects.toolComplete();
            } else if (target.classList.contains("chat-tool-icon--error")) {
              SoundEffects.toolError();
            }
          }
        }
      });
    });

    observer.observe(list, {
      attributes: true,
      subtree: true,
      attributeFilter: ["class"],
    });
  }

  function setupNewAgentWorkdir() {
    var input = document.getElementById("agent-workdir");
    if (!input) return;
    if (input.dataset.workdirPersisted === "true") return;
    input.dataset.workdirPersisted = "true";

    var stored = null;
    try {
      stored = localStorage.getItem(NEW_AGENT_WORKDIR_KEY);
    } catch (_) {}

    if (stored !== null) {
      input.value = stored;
    }

    function persistWorkdir() {
      try {
        localStorage.setItem(NEW_AGENT_WORKDIR_KEY, input.value);
      } catch (_) {}
    }

    input.addEventListener("input", persistWorkdir);
    if (input.form) {
      input.form.addEventListener("submit", persistWorkdir);
    }
  }

  function isChatWsElement(el) {
    if (!el || typeof el.matches !== "function") return false;
    if (el.matches("main.chat-app[ws-connect]")) return true;
    if (typeof el.closest === "function") {
      return !!el.closest("main.chat-app[ws-connect]");
    }
    return false;
  }

  // Capture socketWrapper from htmx events (chat only)
  document.body.addEventListener("htmx:wsOpen", function (e) {
    if (e.detail && e.detail.socketWrapper && isChatWsElement(e.detail.elt || e.target)) {
      _chatSocketWrapper = e.detail.socketWrapper;
    }
  });
  document.body.addEventListener("htmx:wsClose", function (e) {
    if (e.detail && isChatWsElement(e.detail.elt || e.target)) {
      _chatSocketWrapper = null;
    }
  });

  // Extract agentId from the current URL path
  function getAgentIdFromUrl() {
    var match = window.location.pathname.match(/\/agents\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getSidebarWsConnector() {
    var connector = document.getElementById("sidebar-ws-connector");
    if (connector) return connector;
    return document.querySelector('div[hx-ext="ws"][ws-connect^="/sidebar/ws"]');
  }

  function readSidebarAgents(connector) {
    if (!connector) return [];
    var dataAgents = connector.getAttribute("data-agents");
    if (dataAgents && dataAgents.trim().length > 0) {
      return dataAgents
        .split(",")
        .map(function (id) {
          return id.trim();
        })
        .filter(Boolean);
    }
    var wsConnect = connector.getAttribute("ws-connect");
    if (!wsConnect) return [];
    return (new URL(wsConnect, window.location.origin).searchParams.get("agents") || "")
      .split(",")
      .map(function (id) {
        return id.trim();
      })
      .filter(Boolean);
  }

  function buildSidebarWsUrl(agentIds) {
    return "/sidebar/ws?agents=" + encodeURIComponent(agentIds.join(","));
  }

  function replaceSidebarWsConnector(connector, agentIds) {
    var parent = connector && connector.parentNode ? connector.parentNode : document.querySelector(".app-sidebar__content");
    if (!parent) return;
    var next = document.createElement("div");
    next.id = "sidebar-ws-connector";
    next.setAttribute("hx-ext", "ws");
    next.setAttribute("ws-connect", buildSidebarWsUrl(agentIds));
    next.setAttribute("data-agents", agentIds.join(","));
    next.style.display = "none";
    if (connector && connector.parentNode) {
      connector.parentNode.replaceChild(next, connector);
    } else {
      parent.appendChild(next);
    }
    if (window.htmx && typeof window.htmx.process === "function") {
      window.htmx.process(next);
    }
  }

  function ensureSidebarWsAgent(agentId) {
    if (!agentId) return;
    var connector = getSidebarWsConnector();
    var agents = readSidebarAgents(connector);
    if (agents.indexOf(agentId) !== -1) return;
    agents.push(agentId);
    replaceSidebarWsConnector(connector, agents);
  }

  // Configure marked for rendering
  if (typeof marked !== "undefined") {
    marked.setOptions({
      async: false,
      gfm: true,
      breaks: true,
    });
  }

  // Parse markdown to HTML
  function parseMarkdown(content) {
    if (typeof marked !== "undefined") {
      return marked.parse(content);
    }
    // Fallback to escaped text if marked is not loaded
    return escapeHtml(content);
  }

  // Create a user message element
  function createUserMessageElement(content, id) {
    var article = document.createElement("article");
    article.className = "chat-message chat-message--user";
    article.id = id;
    article.innerHTML =
      '<div class="chat-message__bubble"><p class="chat-message__text">' +
      escapeHtml(content) +
      "</p></div>";
    return article;
  }

  // Create an agent message element with markdown rendering
  function createAgentMessageElement(content, id) {
    var article = document.createElement("article");
    article.className = "chat-message chat-message--agent";
    article.id = id;
    article.innerHTML =
      '<div class="chat-message__avatar" aria-hidden="true"><span>C</span></div>' +
      '<div class="chat-message__content">' +
      '<div class="chat-message__bubble">' +
      '<div class="chat-message__text chat-message__text--markdown">' +
      parseMarkdown(content) +
      "</div></div>" +
      '<div class="chat-message__actions">' +
      '<button type="button" class="chat-action-btn chat-action-btn--copy" title="Copy message" aria-label="Copy message">' +
      '<svg class="icon icon--copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
      '<svg class="icon icon--check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="20 6 9 17 4 12"></polyline></svg>' +
      "</button></div></div>";
    return article;
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Fetch and render conversation history
  // agentId parameter is optional - if provided, uses that instead of URL parsing
  function loadHistory(agentId) {
    // Use provided agentId or fall back to URL parsing
    var resolvedAgentId = agentId || getAgentIdFromUrl();
    console.log("[chat] loadHistory called, agentId=" + resolvedAgentId + ", url=" + window.location.pathname);
    if (!resolvedAgentId) {
      console.warn("[chat] Could not extract agentId from URL");
      return;
    }

    var placeholder = document.getElementById("agent-ready-placeholder");
    var list = document.getElementById("chat-message-list");
    if (!list) {
      console.warn("[chat] chat-message-list not found");
      return;
    }

    if (list.dataset.historyAgent === resolvedAgentId) {
      if (list.dataset.historyLoaded === "true" || list.dataset.historyLoading === "true") {
        return;
      }
    }
    list.dataset.historyAgent = resolvedAgentId;
    list.dataset.historyLoading = "true";

    var historyUrl = "/agents/" + resolvedAgentId + "/history";
    console.log("[chat] Fetching history from: " + historyUrl);

    fetch(historyUrl)
      .then(function (response) {
        console.log("[chat] History response status: " + response.status);
        if (!response.ok) {
          throw new Error("Failed to fetch history: " + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        console.log("[chat] History data received:", data);
        var messages = data.messages || [];
        if (messages.length === 0) {
          console.log("[chat] No history found");
          list.dataset.historyLoading = "false";
          list.dataset.historyLoaded = "true";
          return;
        }

        // Only show loading message when there's actually history to load
        if (placeholder) {
          var text = placeholder.querySelector(".chat-message__text");
          if (text) {
            text.textContent = "Loading conversation history…";
          }
        }

        if (!list.isConnected || list.dataset.historyAgent !== resolvedAgentId) {
          return;
        }

        // Insert history messages before the placeholder
        var fragment = document.createDocumentFragment();
        messages.forEach(function (msg, index) {
          var id = "history-msg-" + index;
          var el =
            msg.role === "user"
              ? createUserMessageElement(msg.content, id)
              : createAgentMessageElement(msg.content, id);
          fragment.appendChild(el);
        });

        // Insert before the placeholder
        if (placeholder && placeholder.parentNode === list) {
          list.insertBefore(fragment, placeholder);
        } else {
          list.appendChild(fragment);
        }

        list.dataset.historyLoading = "false";
        list.dataset.historyLoaded = "true";
        _historyLoaded = true;
        console.log("[chat] Loaded " + messages.length + " history messages");
      })
      .catch(function (err) {
        console.error("[chat] Error loading history:", err);
        if (list && list.isConnected && list.dataset.historyAgent === resolvedAgentId) {
          list.dataset.historyLoading = "false";
        }
        // Don't show error to user, just continue with fresh session
      });
  }

  var WS_TONE_CLASSES = [
    "chat-status--info",
    "chat-status--success",
    "chat-status--warning",
    "chat-status--error",
  ];

  function setupScrollLock() {
    const list = document.getElementById("chat-message-list");
    const viewport = document.querySelector(".chat-app__messages");
    if (!list || !viewport) {
      return;
    }

    let isLockedToBottom = true;
    const BOTTOM_THRESHOLD = 4; // px tolerance

    const atBottom = () =>
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      BOTTOM_THRESHOLD;

    const scrollToBottom = () => {
      // use full scrollHeight; browser clamps to max automatically
      viewport.scrollTop = viewport.scrollHeight;
    };

    // Keep pinned to bottom while locked when content changes
    const observer = new MutationObserver(() => {
      if (isLockedToBottom) {
        requestAnimationFrame(scrollToBottom);
      }
    });
    observer.observe(list, { childList: true, subtree: true });

    // Also react to htmx swap events which drive OOB updates
    const htmxScrollHandler = function () {
      if (isLockedToBottom) {
        requestAnimationFrame(scrollToBottom);
      }
    };
    document.body.addEventListener("htmx:oobAfterSwap", htmxScrollHandler);
    document.body.addEventListener("htmx:afterSwap", htmxScrollHandler);
    document.body.addEventListener("htmx:afterSettle", htmxScrollHandler);

    // Detach lock if user scrolls up; reattach when they reach bottom
    const onScroll = () => {
      if (atBottom()) {
        isLockedToBottom = true;
      } else {
        isLockedToBottom = false;
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    // Initial snap to bottom
    requestAnimationFrame(scrollToBottom);

    // Reattach lock and snap when the user submits a new message
    const composer = document.querySelector("form[data-chat-composer]");
    if (composer) {
      composer.addEventListener("submit", function () {
        isLockedToBottom = true;
        setTimeout(scrollToBottom, 0);
      });
    }

    return {
      attach: () => {
        isLockedToBottom = true;
        scrollToBottom();
      },
      detach: () => {
        isLockedToBottom = false;
      },
      isLocked: () => isLockedToBottom,
    };
  }

  function setupComposer(form) {
    if (!form) {
      return;
    }

    form.addEventListener("submit", function () {
      var voiceClient = window.__voiceClient;
      if (voiceClient && typeof voiceClient.noteActivity === "function") {
        voiceClient.noteActivity();
      }
      const textarea = form.querySelector("textarea[name='text']");
      if (!textarea) {
        return;
      }
      window.setTimeout(function () {
        textarea.value = "";
        textarea.focus();
      }, 0);
    });
  }

  // Send cancel message to stop agent response
  function sendCancelResponse() {
    if (!_chatSocketWrapper) {
      console.warn("[chat] Cannot cancel - WebSocket not connected");
      return;
    }
    var msg = JSON.stringify({ event: "chat_cancel_response" });
    _chatSocketWrapper.sendImmediately(msg, document.body);
    console.log("[chat] Sent cancel response");
  }

  // Setup send/stop button handler
  function setupSendStopButton() {
    // Use event delegation since button can be swapped via OOB updates
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("#chat-send-stop-btn");
      if (!btn) return;

      var state = btn.getAttribute("data-state");

      if (state === "stop") {
        // Stop the response
        e.preventDefault();
        sendCancelResponse();
      } else {
        // Submit the form
        var form = document.getElementById("chat-composer-form");
        if (form) {
          // Trigger form submission
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
        }
      }
    });

    // Ctrl+C keyboard shortcut to stop response
    document.addEventListener("keydown", function (e) {
      // Only handle Ctrl+C (or Cmd+C on Mac) when text input is not focused or has no selection
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        var btn = document.getElementById("chat-send-stop-btn");
        if (!btn) return;

        var state = btn.getAttribute("data-state");
        if (state !== "stop") return;

        // Check if there's a text selection - if so, let the default copy behavior work
        var selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;

        // No selection, stop the response
        e.preventDefault();
        sendCancelResponse();
      }
    });
  }

  function setStatus(label, tone) {
    var el = document.getElementById("connection-status");
    if (!el) return;
    el.textContent = label;
    // reset tone classes
    for (var i = 0; i < WS_TONE_CLASSES.length; i++) {
      el.classList.remove(WS_TONE_CLASSES[i]);
    }
    var toneClass = null;
    switch (tone) {
      case "success":
        toneClass = "chat-status--success";
        break;
      case "warning":
        toneClass = "chat-status--warning";
        break;
      case "error":
        toneClass = "chat-status--error";
        break;
      default:
        toneClass = "chat-status--info";
    }
    el.classList.add(toneClass);
  }

  function showReconnectButton(show) {
    var btn = document.getElementById("ws-reconnect-btn");
    if (!btn) return;
    if (show) {
      btn.classList.remove("is-hidden");
    } else {
      btn.classList.add("is-hidden");
    }
  }

  function setupWsStatus() {
    var root = document.querySelector("main.chat-app[ws-connect]");
    if (!root) return;

    var maxRetriesAttr = root.getAttribute("ws-max-retries");
    var maxRetries = 3;
    if (maxRetriesAttr && !isNaN(parseInt(maxRetriesAttr, 10))) {
      maxRetries = parseInt(maxRetriesAttr, 10);
    }

    var attemptCount = 0; // counts connecting attempts in current series
    var wsWrapper = null; // assigned from event.detail.socketWrapper when available

    root.addEventListener("htmx:wsConnecting", function () {
      attemptCount += 1;
      if (attemptCount <= 1) {
        setStatus("Connecting…", "info");
      } else {
        var n = attemptCount - 1; // retries used so far in this series
        setStatus("Reconnecting… (" + n + "/" + maxRetries + ")", "warning");
      }
      showReconnectButton(false);
    });

    root.addEventListener("htmx:wsOpen", function (e) {
      if (e && e.detail && e.detail.socketWrapper) {
        wsWrapper = e.detail.socketWrapper;
      }
      setStatus("Connected", "success");
      attemptCount = 0;
      showReconnectButton(false);
      ensureSidebarWsAgent(getAgentIdFromUrl());
    });

    root.addEventListener("htmx:wsError", function () {
      setStatus("Connection error", "error");
    });

    root.addEventListener("htmx:wsClose", function (e) {
      if (e && e.detail && e.detail.socketWrapper) {
        wsWrapper = e.detail.socketWrapper;
      }
      var code = e && e.detail && e.detail.event && e.detail.event.code;
      var tone = code === 1000 ? "info" : "warning";
      setStatus("Disconnected", tone);
      // When attempts exceed budget (initial + maxRetries), surface reconnect
      if (attemptCount >= maxRetries + 1) {
        setStatus("Unable to connect", "error");
        showReconnectButton(true);
      }
    });

    var btn = document.getElementById("ws-reconnect-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        showReconnectButton(false);
        attemptCount = 0;
        setStatus("Reconnecting…", "warning");
        try {
          if (wsWrapper && typeof wsWrapper.reconnect === "function") {
            wsWrapper.reconnect();
            return;
          }
        } catch (_) {}
        // Fallback in case wrapper is unavailable
        try {
          window.location.reload();
        } catch (_) {}
      });
    }
  }

  function setupPermissionModeDropdown() {
    var dropdown = document.getElementById("permission-mode");
    if (!dropdown) return;

    dropdown.addEventListener("change", function () {
      var modeId = dropdown.value;
      if (!_chatSocketWrapper) {
        console.warn("[chat] Cannot set mode - WebSocket not connected");
        return;
      }

      var msg = JSON.stringify({ event: "chat_set_mode", modeId: modeId });
      _chatSocketWrapper.sendImmediately(msg, dropdown);
      console.log("[chat] Sent mode change:", modeId);
    });
  }

  // Copy message button handler
  function setupCopyMessageButton() {
    var list = document.getElementById("chat-message-list");
    if (!list) return;

    list.addEventListener("click", function (e) {
      var btn = e.target.closest(".chat-action-btn--copy");
      if (!btn) return;

      var message = btn.closest(".chat-message");
      if (!message) return;

      var textEl = message.querySelector(".chat-message__text");
      if (!textEl) return;

      var text = textEl.textContent || "";

      navigator.clipboard.writeText(text).then(function () {
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.classList.remove("is-copied");
        }, 2000);
      }).catch(function (err) {
        console.error("[chat] Failed to copy:", err);
      });
    });
  }

  function setupToolGroupToggle() {
    // Use event delegation on the message list to handle dynamically added tool message toggles
    var list = document.getElementById("chat-message-list");
    if (!list) return;

    // Handle tool message expand/collapse
    list.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-tool-expand]");
      if (!btn) return;

      var toolId = btn.getAttribute("data-tool-expand");
      if (!toolId) return;

      var message = btn.closest(".chat-message--tool");
      if (!message) return;

      var details = message.querySelector(".chat-tool-details");
      if (!details) return;

      var isExpanded = message.classList.contains("is-expanded");

      if (isExpanded) {
        message.classList.remove("is-expanded");
        details.classList.add("is-hidden");
      } else {
        message.classList.add("is-expanded");
        details.classList.remove("is-hidden");
      }
    });
  }

  function setupPermissionButtonHandler() {
    // Use event delegation on the message list to handle dynamically added permission buttons
    var list = document.getElementById("chat-message-list");
    if (!list) return;

    list.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-permission-request-id]");
      if (!btn) return;

      var requestId = btn.getAttribute("data-permission-request-id");
      var optionId = btn.getAttribute("data-permission-option-id");
      var elementId = btn.getAttribute("data-permission-element-id");

      if (!requestId || !optionId) {
        console.warn("[chat] Permission button missing requestId or optionId");
        return;
      }

      if (!_chatSocketWrapper) {
        console.warn("[chat] Cannot respond to permission - WebSocket not connected");
        return;
      }

      // Disable all permission buttons in this prompt to prevent double-clicks
      var article = elementId ? document.getElementById(elementId) : btn.closest("article");
      if (article) {
        var buttons = article.querySelectorAll("button[data-permission-request-id]");
        buttons.forEach(function (b) {
          b.disabled = true;
        });
      }

      var msg = JSON.stringify({
        event: "permission_response",
        requestId: requestId,
        optionId: optionId,
      });
      _chatSocketWrapper.sendImmediately(msg, btn);
      console.log("[chat] Sent permission response:", requestId, optionId);
    });
  }

  // Sidebar toggle and mobile navigation
  function setupSidebar() {
    var appShell = document.getElementById("app-shell");
    var sidebar = document.getElementById("app-sidebar");
    var sidebarToggle = document.getElementById("sidebar-toggle");

    if (!appShell || !sidebar) return;

    var sidebarContent = sidebar.querySelector(".app-sidebar__content");
    if (sidebarContent) {
      restoreSidebarScroll();
      sidebarContent.addEventListener(
        "scroll",
        function () {
          try {
            sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebarContent.scrollTop));
          } catch (_) {}
        },
        { passive: true },
      );
    }

    // Check if we're on the index page (no agent selected)
    var isIndexPage = appShell.getAttribute("data-is-index") === "true";

    // Check if mobile
    function isMobile() {
      return window.innerWidth <= 768;
    }

    // Desktop: Toggle sidebar collapse
    function toggleSidebarDesktop() {
      sidebar.classList.toggle("is-collapsed");
      appShell.classList.toggle("sidebar-collapsed");
      // Save preference
      localStorage.setItem("sidebar-collapsed", sidebar.classList.contains("is-collapsed") ? "1" : "0");
    }

    // Mobile: Show/hide sidebar
    function showSidebarMobile() {
      sidebar.classList.remove("is-hidden-mobile");
    }

    function hideSidebarMobile() {
      sidebar.classList.add("is-hidden-mobile");
    }

    // Initialize mobile state
    if (isMobile()) {
      if (isIndexPage) {
        // On index page, show sidebar by default on mobile
        showSidebarMobile();
      } else {
        // On chat page, hide sidebar on mobile
        hideSidebarMobile();
      }
    } else {
      // Desktop: restore preference
      var collapsed = localStorage.getItem("sidebar-collapsed") === "1";
      if (collapsed) {
        sidebar.classList.add("is-collapsed");
        appShell.classList.add("sidebar-collapsed");
      }
    }

    // Desktop sidebar toggle
    if (sidebarToggle) {
      sidebarToggle.addEventListener("click", function () {
        if (!isMobile()) {
          toggleSidebarDesktop();
        }
      });
    }

    // Back button (delegated for HTMX swaps)
    document.addEventListener("click", function (e) {
      var target = e.target;
      var btn = null;
      if (target && target.id === "chat-back-btn") {
        btn = target;
      } else if (target && typeof target.closest === "function") {
        btn = target.closest("#chat-back-btn");
      }
      if (!btn) return;
      if (isMobile()) {
        showSidebarMobile();
      } else {
        toggleSidebarDesktop();
      }
    });

    // Handle resize - adjust visibility
    var resizeTimeout;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function () {
        if (isMobile()) {
          // On mobile, show/hide sidebar based on page type
          if (isIndexPage) {
            showSidebarMobile();
          } else {
            hideSidebarMobile();
          }
          sidebar.classList.remove("is-collapsed");
          appShell.classList.remove("sidebar-collapsed");
        } else {
          // On desktop, remove mobile-specific classes
          sidebar.classList.remove("is-hidden-mobile");
          // Restore desktop preference
          var collapsed = localStorage.getItem("sidebar-collapsed") === "1";
          if (collapsed) {
            sidebar.classList.add("is-collapsed");
            appShell.classList.add("sidebar-collapsed");
          } else {
            sidebar.classList.remove("is-collapsed");
            appShell.classList.remove("sidebar-collapsed");
          }
        }
      }, 100);
    });

    // On mobile, clicking an agent link should hide sidebar
    var agentLinks = sidebar.querySelectorAll(".sidebar-agent-item");
    agentLinks.forEach(function (link) {
      link.addEventListener("click", function () {
        if (isMobile()) {
          hideSidebarMobile();
        }
      });
    });

    // On mobile index page, clicking "New Agent" button should hide sidebar
    var newAgentBtn = sidebar.querySelector(".sidebar-new-btn");
    if (newAgentBtn && isIndexPage) {
      newAgentBtn.addEventListener("click", function (e) {
        if (isMobile()) {
          e.preventDefault(); // Don't navigate, just hide sidebar to show form
          hideSidebarMobile();
        }
      });
    }
  }

  // Notification sound for agents needing attention
  var NotificationSound = {
    play: function () {
      try {
        var ctx = SoundEffects._getContext();
        // Two-tone "ding" notification
        var osc1 = ctx.createOscillator();
        var osc2 = ctx.createOscillator();
        var gain = ctx.createGain();
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.frequency.value = 880; // A5
        osc1.type = "sine";
        osc2.frequency.value = 1109; // C#6
        osc2.type = "sine";

        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

        osc1.start(ctx.currentTime);
        osc2.start(ctx.currentTime + 0.1);
        osc1.stop(ctx.currentTime + 0.4);
        osc2.stop(ctx.currentTime + 0.5);
      } catch (e) {
        // Silently ignore audio errors
      }
    },
  };

  // Track which agents we've already notified about to avoid repeat sounds
  // Stores { agentId: attentionType } to detect new attention vs same attention
  var _notifiedAgents = {};

  // Setup notification sound handler for sidebar HTMX updates
  function setupSidebarNotifications() {
    // Listen for HTMX OOB swaps to detect attention state changes
    document.body.addEventListener("htmx:oobAfterSwap", function (e) {
      var target = e.detail.target;
      if (!target || !target.id || !target.id.startsWith("sidebar-agent-state-")) return;

      var agentId = target.id.replace("sidebar-agent-state-", "");
      var attentionType = target.getAttribute("data-attention-type") || null;

      // Get current agent ID fresh each time (not stale from setup time)
      var currentAgentId = getAgentIdFromUrl();

      if (attentionType && agentId !== currentAgentId) {
        // Play sound only for newly needing attention agents (or new attention type)
        if (_notifiedAgents[agentId] !== attentionType) {
          _notifiedAgents[agentId] = attentionType;
          NotificationSound.play();
        }
      } else if (!attentionType) {
        delete _notifiedAgents[agentId];
      }
    });
  }

  // End Session button handler
  function setupEndSessionButton() {
    var btn = document.getElementById("end-session-btn");
    if (!btn) return;

    var agentId = btn.getAttribute("data-agent-id");
    if (!agentId) return;

    btn.addEventListener("click", function () {
      btn.disabled = true;

      fetch("/api/agents/" + encodeURIComponent(agentId) + "/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("Failed to stop agent: " + response.status);
          }
          return response.json();
        })
        .then(function () {
          // Redirect to new agent page
          window.location.href = "/agents";
        })
        .catch(function (err) {
          console.error("[chat] Error stopping agent:", err);
          btn.disabled = false;
          alert("Failed to stop agent. Please try again.");
        });
    });
  }

  // Cached voices list - loaded once per page session
  var _voicesCache = null;

  function getVoiceWorkerBaseUrl(selectEl) {
    var sourceEl = null;
    if (selectEl && typeof selectEl.closest === "function") {
      sourceEl = selectEl.closest("[data-voice-base]");
    }
    if (!sourceEl) {
      sourceEl = document.getElementById("app-shell");
    }
    var base = sourceEl && sourceEl.getAttribute("data-voice-base");
    if (!base) return null;
    return base.replace(/\/+$/, "");
  }

  function updateVoiceWebSocket(voiceId) {
    var root = document.querySelector("main[data-voice-ws]");
    if (!root) return;
    var current = root.getAttribute("data-voice-ws");
    var nextUrl = null;
    if (current) {
      try {
        var url = new URL(current, window.location.origin);
        url.searchParams.set("voice", voiceId);
        nextUrl = url.toString();
      } catch (_) {}
    }
    if (!nextUrl) {
      var base = getVoiceWorkerBaseUrl(root);
      if (!base) return;
      try {
        var baseUrl = new URL(base);
        var wsUrl = new URL("/ws", baseUrl);
        wsUrl.searchParams.set("voice", voiceId);
        nextUrl = wsUrl.toString().replace(/^http/, "ws");
      } catch (_) {
        return;
      }
    }
    root.setAttribute("data-voice-ws", nextUrl);

    var client = window.__voiceClient;
    if (!client) return;
    client.voicePath = nextUrl;
    client.wsUrl = nextUrl;
    if (client.ws) {
      try {
        client.ws.close(1000, "voice_change");
      } catch (_) {}
      client.ws = null;
    }
    if (typeof client._connectWs === "function") {
      client._connectWs();
    }
  }

  // Load voices from API and populate dropdown
  function loadVoicesIntoDropdown(selectEl, currentVoice) {
    // If we already have cached voices, use them
    if (_voicesCache) {
      populateVoiceDropdown(selectEl, _voicesCache, currentVoice);
      return;
    }

    // Fetch voices from voice worker
    var voiceBase = getVoiceWorkerBaseUrl(selectEl);
    if (!voiceBase) return;
    fetch(voiceBase + "/voices")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        var voices = data.voices || [];
        // Sort alphabetically by displayName
        voices.sort(function (a, b) {
          return (a.displayName || a.voiceId).localeCompare(b.displayName || b.voiceId);
        });
        _voicesCache = voices;
        populateVoiceDropdown(selectEl, voices, currentVoice);
      })
      .catch(function () {
        // On error, keep the current single option
      });
  }

  // Populate a voice dropdown with options
  function populateVoiceDropdown(selectEl, voices, currentVoice) {
    // Clear existing options
    selectEl.innerHTML = "";

    // Add voice options
    voices.forEach(function (voice) {
      var opt = document.createElement("option");
      opt.value = voice.voiceId;
      // Show displayName with description as helpful context
      var label = voice.displayName || voice.voiceId;
      if (voice.description) {
        // Truncate long descriptions
        var desc = voice.description.length > 50 ? voice.description.slice(0, 47) + "..." : voice.description;
        label += " - " + desc;
      }
      opt.textContent = label;
      if (voice.voiceId === currentVoice) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });

    // If current voice wasn't in the list (e.g. custom or missing), add it
    if (currentVoice && !Array.prototype.some.call(selectEl.options, function (o) { return o.value === currentVoice; })) {
      var opt = document.createElement("option");
      opt.value = currentVoice;
      opt.textContent = currentVoice;
      opt.selected = true;
      selectEl.insertBefore(opt, selectEl.firstChild);
    }
  }

  // Voice dropdown handlers for NewAgentPage and AgentChatPage
  function setupVoiceDropdown() {
    // New agent form voice dropdown - persist selection as user's default
    var newAgentVoiceSelect = document.getElementById("agent-voice");
    if (newAgentVoiceSelect) {
      // Get current selected value before loading voices
      var currentVoice = newAgentVoiceSelect.value;
      loadVoicesIntoDropdown(newAgentVoiceSelect, currentVoice);

      newAgentVoiceSelect.addEventListener("change", function () {
        var voice = this.value;
        // Save as user's default
        fetch("/api/voice/default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice: voice || null }),
        }).catch(function () {
          // Silently ignore errors
        });
      });
    }

    // Chat page voice dropdown - update agent's voice setting
    var chatVoiceSelect = document.getElementById("chat-voice-select");
    if (chatVoiceSelect) {
      var agentId = chatVoiceSelect.getAttribute("data-agent-id");
      // Get current selected value before loading voices
      var currentVoice = chatVoiceSelect.value;
      loadVoicesIntoDropdown(chatVoiceSelect, currentVoice);

      if (agentId) {
        chatVoiceSelect.addEventListener("change", function () {
          var voice = this.value;
          fetch("/api/agents/" + agentId + "/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voice: voice || null }),
          }).catch(function () {
            // Silently ignore errors
          });
          if (voice) {
            updateVoiceWebSocket(voice);
          }
        });
      }
    }
  }

  // Initialize main content area (called after HTMX navigation)
  // agentId parameter is optional - if provided, uses that instead of URL parsing
  function initMainContent(agentId) {
    // Reset history loaded flag for new page
    _historyLoaded = false;

    setupScrollLock();
    setupNewAgentWorkdir();
    setupVoiceDropdown();
    setupEndSessionButton();

    // Load conversation history - use provided agentId or fall back to URL
    loadHistory(agentId);

    document.querySelectorAll("form[data-chat-composer]").forEach(function (form) {
      setupComposer(form);
    });

    setupWsStatus();
    setupPermissionModeDropdown();
    setupPermissionButtonHandler();
    setupToolGroupToggle();
    setupCopyMessageButton();
    setupSoundEffects();
  }

  // Handle HTMX navigation via OOB marker element
  function setupHtmxNavigation() {
    function resolveNavState(marker) {
      var markerAgentId = marker ? marker.getAttribute("data-current-agent-id") : null;
      var currentAgentId = markerAgentId && markerAgentId.length > 0 ? markerAgentId : null;
      var urlAgentId = getAgentIdFromUrl();
      if (!currentAgentId || (urlAgentId && currentAgentId !== urlAgentId)) {
        currentAgentId = urlAgentId;
      }
      return { currentAgentId: currentAgentId, isIndexPage: currentAgentId === null };
    }

    function syncSidebarActiveState(currentAgentId, isIndexPage) {
      var shell = document.getElementById("app-shell");
      if (shell) {
        shell.classList.toggle("app-shell--index", isIndexPage);
        shell.dataset.isIndex = isIndexPage ? "true" : "false";
      }

      // Remove active class from all sidebar items
      document.querySelectorAll(".sidebar-agent-item.is-active, .sidebar-new-btn.is-active").forEach(function (el) {
        el.classList.remove("is-active");
      });

      // Add active class to current item
      if (currentAgentId) {
        var activeAgent = document.getElementById("sidebar-agent-" + currentAgentId);
        if (activeAgent) activeAgent.classList.add("is-active");
        return;
      }

      var newBtn = document.querySelector(".sidebar-new-btn");
      if (newBtn) newBtn.classList.add("is-active");
    }

    // Listen for HTMX OOB swap on the nav marker
    document.body.addEventListener("htmx:oobAfterSwap", function (e) {
      var target = e.detail.target;
      if (!target || target.id !== "htmx-nav-marker") return;

      var navState = resolveNavState(target);

      console.log("[chat] HTMX nav detected: agentId=" + navState.currentAgentId + ", isIndex=" + navState.isIndexPage);
      syncSidebarActiveState(navState.currentAgentId, navState.isIndexPage);

      restoreSidebarScroll();
    });

    document.body.addEventListener("htmx:afterSwap", function (e) {
      var target = e.detail.target;
      if (!target || target.id !== "app-main") return;
      var navState = resolveNavState(document.getElementById("htmx-nav-marker"));
      syncSidebarActiveState(navState.currentAgentId, navState.isIndexPage);
      initMainContent(navState.currentAgentId || undefined);
    });

    window.addEventListener("popstate", function () {
      var navState = resolveNavState(document.getElementById("htmx-nav-marker"));
      syncSidebarActiveState(navState.currentAgentId, navState.isIndexPage);
    });
  }

  function initialize() {
    // Set up sidebar (only needs to happen once)
    setupSidebar();
    setupSidebarNotifications();

    // Set up HTMX navigation handler (only once at document level)
    setupHtmxNavigation();

    // Set up send/stop button (uses document-level event delegation, so only once)
    setupSendStopButton();

    // Initialize main content
    initMainContent();

    // Global Enter-to-submit behavior (only set up once at document level)
    (function setupEnterShortcuts() {
      document.addEventListener(
        "keydown",
        function (e) {
          if (e.key !== "Enter") return;

          var form = document.getElementById("chat-composer-form");
          if (!form) return;
          var textarea = document.getElementById("chat-input");

          var target = e.target;
          var isTextarea = textarea && target === textarea;

          // In textarea: Shift+Enter or Alt+Enter should insert newline (no submit)
          if (isTextarea && (e.shiftKey || e.altKey)) {
            return; // allow default newline behavior
          }

          // Otherwise, submit the chat form
          e.preventDefault();
          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else {
              form.submit();
            }
          } catch (_) {}
        },
        true,
      );
    })();
  }

  // Expose initChatPage globally for HTMX navigation
  window.initChatPage = initMainContent;

  if (document.readyState === "complete" || document.readyState === "interactive") {
    initialize();
  } else {
    document.addEventListener("DOMContentLoaded", initialize);
  }
})();
