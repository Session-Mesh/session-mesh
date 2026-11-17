// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

"use strict";

// A local HTML document is deliberately sandboxed with an opaque origin, so
// its parent cannot read its location or call its History object. This helper
// is appended only to HTML documents loaded in a Mesh iframe. It keeps the
// actual browser history private to the frame and accepts one harmless
// operation from its direct parent: go back one entry.
//
// The Mesh gives the initial frame load a random `dt` token. Ordinary clicks
// to another local /view URL retain it, so nested local HTML navigation can
// still report an observed local navigation. The token is an anti-confusion
// binding between the pane and its current frame, not an authorization token.
(() => {
  const token = new URLSearchParams(location.search).get("dt");
  if (!token || window.parent === window) return;

  const tell = (smesh, extra = {}) => window.parent.postMessage({ smesh, token, ...extra }, "*");
  let parentReady = false;
  let readyTimer = null;
  let pendingNavigation = null;
  const reportPendingNavigation = () => {
    if (!pendingNavigation || pendingNavigation.reported) return;
    pendingNavigation.reported = true;
    tell("frame-history-push", { url: pendingNavigation.url, navigation: pendingNavigation.navigation });
  };

  // The parent may not yet be able to consume ready: an initial iframe load
  // can still be in flight, and a child navigation needs that load observed
  // before it is safe to count a Previous entry. Keep announcing readiness
  // until the parent has acknowledged the exact bridge instance.
  const requestParentReady = () => {
    if (parentReady || readyTimer !== null) return;
    tell("frame-history-ready", { url: location.href });
    readyTimer = setTimeout(() => {
      readyTimer = null;
      requestParentReady();
    }, 50);
  };

  const renewParentReady = () => {
    parentReady = false;
    if (readyTimer !== null) clearTimeout(readyTimer);
    readyTimer = null;
    requestParentReady();
  };

  addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.token !== token) return;
    if (event.data.smesh === "frame-history-ack") {
      parentReady = true;
      if (readyTimer !== null) clearTimeout(readyTimer);
      readyTimer = null;
      reportPendingNavigation();
      return;
    }
    if (event.data.smesh === "frame-history-back") {
      history.back();
      return;
    }
    if (event.data.smesh !== "frame-history-continue" || !pendingNavigation
        || event.data.url !== pendingNavigation.url
        || event.data.navigation !== pendingNavigation.navigation) return;
    const { url } = pendingNavigation;
    pendingNavigation = null;
    location.assign(url);
  });

  // Tell the parent only after this listener exists. It acknowledges readiness
  // only when its corresponding iframe state is usable; retrying closes the
  // otherwise lossy window between early document parsing and iframe load.
  // A click's intent itself does not wait for ACK: the listener above already
  // exists, and the parent withholds `continue` until it has both ready/load.
  addEventListener("pageshow", renewParentReady);
  renewParentReady();

  // Keep the Mesh's per-frame token only on ordinary local document clicks.
  // Never append it to another origin, a download, a new tab, or a link whose
  // own handler has already taken control.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element && event.target.closest("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { return; }
    if (url.origin !== location.origin || !url.pathname.startsWith("/view/")) return;
    url.searchParams.set("dt", token);
    // Wait for the parent to validate this exact local URL before navigating.
    // That makes its observed iframe load unambiguous: a Previous button can
    // never target the frame until this handshake, the load, and the new
    // document's ready message have all happened.
    if (pendingNavigation) return;
    const navigation = `${Date.now()}-${Math.random()}`;
    pendingNavigation = { url: url.href, navigation, reported: false };
    event.preventDefault();
    reportPendingNavigation();
  });
})();
