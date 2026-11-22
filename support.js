// Support contact shown at the bottom of every TYMRAK page. Change the address here only.
(function () {
  var SUPPORT_EMAIL = "tymrak@outlook.com";
  window.TYMRAK_SUPPORT_EMAIL = SUPPORT_EMAIL;
  function addFooter() {
    if (document.querySelector(".tymrak-support")) return;
    var footer = document.createElement("footer");
    footer.className = "tymrak-support";
    footer.setAttribute("aria-label", "Support");
    footer.style.cssText = "text-align:center;font-size:14px;line-height:1.5;padding:20px 16px 28px;opacity:.8";
    var link = document.createElement("a");
    link.href = "mailto:" + SUPPORT_EMAIL + "?subject=" + encodeURIComponent("TYMRAK support");
    link.textContent = SUPPORT_EMAIL;
    link.style.color = "inherit";
    footer.append("Need help? Email ", link);
    // Pages with a side menu: keep it in the content column, not under the menu.
    var content = document.querySelector(".sidebar") && document.querySelector("main");
    (content || document.body).append(footer);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addFooter);
  else addFooter();
})();
