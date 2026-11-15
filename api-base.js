// Lets the same pages run inside a native app shell (Capacitor) where "/api/..." has no server.
// On the web TYMRAK_API_BASE is empty and nothing changes. In the native shell, set
// window.TYMRAK_API_BASE = "https://app.tymrak.com" before this script (see native-config.example.js).
(function () {
  var base = (window.TYMRAK_API_BASE || "").replace(/\/+$/, "");
  if (!base || !/^https:\/\//.test(base)) return;
  var original = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === "string" && input.indexOf("/api/") === 0) input = base + input;
    return original(input, init);
  };
})();
