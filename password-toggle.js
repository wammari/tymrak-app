/* Adds a Show/Hide button to every password field. Self-contained; no dependencies. */
(function () {
  "use strict";
  var css =
    ".pw-wrap{position:relative;display:block}" +
    ".pw-wrap>input{padding-right:78px!important;margin:0!important;width:100%;box-sizing:border-box}" +
    ".pw-toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);border:0;background:transparent;" +
    "color:#7a4f14;font:700 13px Arial,Helvetica,sans-serif;padding:8px 10px;border-radius:8px;cursor:pointer;width:auto;margin:0;box-shadow:none}" +
    ".pw-toggle:hover{background:#f4e8d6}" +
    ".pw-toggle:focus-visible{outline:3px solid #bd811b66}";

  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = "1";

    var cs = window.getComputedStyle(input);
    var wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    wrap.style.marginTop = cs.marginTop;
    wrap.style.marginBottom = cs.marginBottom;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-toggle";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Show password");
    btn.textContent = "Show";

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(btn);

    function setVisible(visible) {
      input.type = visible ? "text" : "password";
      btn.textContent = visible ? "Hide" : "Show";
      btn.setAttribute("aria-pressed", visible ? "true" : "false");
      btn.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    }

    btn.addEventListener("click", function () {
      setVisible(input.type === "password");
      input.focus();
    });

    // Never leave a password visible after the form is sent or the page is left.
    if (input.form) {
      input.form.addEventListener("submit", function () { setVisible(false); });
    }
    window.addEventListener("pagehide", function () { setVisible(false); });
  }

  function init() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    scan(document);
    // Also cover password fields that pages create later (for example the delete-account prompt).
    if (window.MutationObserver) {
      new MutationObserver(function (records) {
        for (var r = 0; r < records.length; r++) {
          for (var n = 0; n < records[r].addedNodes.length; n++) {
            var node = records[r].addedNodes[n];
            if (node.nodeType === 1) scan(node);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  function scan(root) {
    var fields = [];
    if (root.matches && root.matches('input[type="password"]')) fields.push(root);
    if (root.querySelectorAll) {
      var found = root.querySelectorAll('input[type="password"]');
      for (var i = 0; i < found.length; i++) fields.push(found[i]);
    }
    for (var j = 0; j < fields.length; j++) enhance(fields[j]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
