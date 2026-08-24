(function () {
  "use strict";
  try {
    var tag = document.currentScript;
    if (!tag) {
      var trackerScripts = document.querySelectorAll('script[data-site][src*="/script.js"]');
      tag = trackerScripts.length ? trackerScripts[trackerScripts.length - 1] : null;
    }
    function reportError(message, error) {
      if (typeof console !== "undefined" && console.error) {
        console.error("[ViziAPI] " + message, error || "");
      }
    }
    if (!tag) { reportError("Could not find the tracking script element."); return; }
    var site = tag.getAttribute("data-site"), debug = tag.getAttribute("data-debug") === "true";
    if (!site) { reportError("Missing the data-site attribute."); return; }
    var base = new URL(tag.src).origin, storageKey = "website_tracker_visitor_" + site, visitorId;
    var cookieName = "website_tracker_visitor_" + site;
    try { visitorId = document.cookie.match(new RegExp("(?:^|; )" + cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]+)"))?.[1] || localStorage.getItem(storageKey); } catch (_) {}
    if (!visitorId) { visitorId = crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random(); try { document.cookie = cookieName + "=" + encodeURIComponent(visitorId) + "; Max-Age=31536000; Path=/; SameSite=Lax"; localStorage.setItem(storageKey, visitorId); } catch (_) {} }
    var socket = null, heartbeatTimer = null, reconnectTimer = null, reconnectAttempt = 0, stopped = false;
    var testState = debug ? { connectCalls: 0, heartbeatStarts: 0, heartbeatClears: 0, reconnectSchedules: 0, reconnectTimerActive: false } : null;
    if (testState) window.__YourTrackerTestState = testState;
    var heartbeatMs = 30000, log = function () { if (debug && console && console.log) console.log.apply(console, arguments); };
    function presenceMessage() { return JSON.stringify({ siteKey: site, visitorId: visitorId }); }
    function scheduleReconnect() { if (stopped || reconnectTimer) return; if (testState) { testState.reconnectSchedules++; testState.reconnectTimerActive = true; } var delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt++)); reconnectTimer = setTimeout(function () { reconnectTimer = null; if (testState) testState.reconnectTimerActive = false; connectPresence(); }, delay); }
    function connectPresence() { if (stopped || socket && (socket.readyState === 0 || socket.readyState === 1)) return; if (testState) testState.connectCalls++; try { var socketUrl = base.replace(/^http/, "ws") + "/ws/track"; socket = new WebSocket(socketUrl); socket.onopen = function () { reconnectAttempt = 0; socket.send(presenceMessage()); log("Realtime status: connected"); }; socket.onclose = function () { socket = null; if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; if (testState) { testState.heartbeatClears++; testState.heartbeatActive = false; } } if (!stopped) reportError("Realtime presence disconnected from " + socketUrl + ". Check CSP connect-src and wss access."); scheduleReconnect(); }; socket.onerror = function (error) { reportError("Realtime presence failed at " + socketUrl + ". Check CSP connect-src and wss access.", error); log("Realtime status: error"); }; if (!heartbeatTimer) { heartbeatTimer = setInterval(function () { if (socket && socket.readyState === 1) socket.send(presenceMessage()); }, heartbeatMs); if (testState) { testState.heartbeatStarts++; testState.heartbeatActive = true; } } } catch (error) { reportError("Could not connect to realtime presence at " + base + "/ws/track.", error); scheduleReconnect(); } }
    function post(path, body, label) { fetch(base + path, { method: "POST", mode: "cors", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).then(function (response) { if (!response.ok) { reportError(label + " failed with HTTP " + response.status + " at " + base + path); } }).catch(function (e) { reportError(label + " request failed at " + base + path + ". Check CORS, CSP connect-src, and network access.", e); }); }
    function page() { try { var u = new URL(location.href), q = u.searchParams, body = { siteKey: site, visitorId: visitorId, eventId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(), path: u.pathname + u.search, fullUrl: u.href, referrer: document.referrer || null, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null, screenWidth: screen.width, screenHeight: screen.height, utm: { source: q.get("utm_source"), medium: q.get("utm_medium"), campaign: q.get("utm_campaign") } }; post("/api/v1/track", body, "Page tracking"); } catch (e) { reportError("Could not prepare page tracking payload.", e); } }
    function track(name, properties) { try { if (typeof name !== "string" || !name || name.length > 100) return; post("/api/v1/events", { siteKey: site, visitorId: visitorId, name: name, properties: properties || {} }, "Custom event tracking"); } catch (e) { reportError("Could not prepare custom event payload.", e); } }
    var last = location.href; window.YourTracker = { page: page, track: track }; connectPresence(); page(); ["pushState", "replaceState"].forEach(function (name) { var original = history[name]; history[name] = function () { var result = original.apply(this, arguments); if (location.href !== last) { last = location.href; page(); } return result; }; }); addEventListener("popstate", function () { if (location.href !== last) { last = location.href; page(); } }); log("Tracker initialized", "Site key:", site);
  } catch (e) { if (typeof console !== "undefined" && console.error) console.error("[ViziAPI] Tracker initialization failed.", e); }
}());
