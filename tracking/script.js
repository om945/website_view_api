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
    function post(path, body, label) { fetch(base + path, { method: "POST", mode: "cors", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).then(function (response) { if (!response.ok) { reportError(label + " failed with HTTP " + response.status + " at " + base + path); } }).catch(function (e) { reportError(label + " request failed at " + base + path + ". Check CORS, CSP connect-src, and network access.", e); }); }
    function page() { try { var u = new URL(location.href), q = u.searchParams, body = { siteKey: site, visitorId: visitorId, eventId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(), path: u.pathname + u.search, fullUrl: u.href, referrer: document.referrer || null, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null, screenWidth: screen.width, screenHeight: screen.height, utm: { source: q.get("utm_source"), medium: q.get("utm_medium"), campaign: q.get("utm_campaign") } }; post("/api/v1/track", body, "Page tracking"); } catch (e) { reportError("Could not prepare page tracking payload.", e); } }
    function track(name, properties) { try { if (typeof name !== "string" || !name || name.length > 100) return; post("/api/v1/events", { siteKey: site, visitorId: visitorId, name: name, properties: properties || {} }, "Custom event tracking"); } catch (e) { reportError("Could not prepare custom event payload.", e); } }
    var last = location.href; window.YourTracker = { page: page, track: track }; page(); ["pushState", "replaceState"].forEach(function (name) { var original = history[name]; history[name] = function () { var result = original.apply(this, arguments); if (location.href !== last) { last = location.href; page(); } return result; }; }); addEventListener("popstate", function () { if (location.href !== last) { last = location.href; page(); } });
  } catch (e) { if (typeof console !== "undefined" && console.error) console.error("[ViziAPI] Tracker initialization failed.", e); }
}());
