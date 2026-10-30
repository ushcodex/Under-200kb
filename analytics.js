/* Under 200KB — privacy-first, non-blocking analytics client.
 * Sends a handful of anonymous counters to /api/collect. It never sends file
 * names, file contents, sizes of files, or anything that identifies a person,
 * and every failure is swallowed so the tool keeps working.
 */
(function () {
  'use strict';

  var OPT_OUT_KEY = 'u200kb-analytics-optout';
  var ENDPOINT = '/api/collect';

  function readOptOut() {
    try { return localStorage.getItem(OPT_OUT_KEY) === '1'; } catch (e) { return false; }
  }

  window.u200OptedOut = readOptOut;

  window.u200SetOptOut = function (optedOut) {
    try {
      if (optedOut) localStorage.setItem(OPT_OUT_KEY, '1');
      else localStorage.removeItem(OPT_OUT_KEY);
    } catch (e) { /* private mode: the choice just won't persist */ }
  };

  function isBlocked() {
    try {
      if (navigator.globalPrivacyControl === true) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      if (dnt === '1' || dnt === 'yes') return true;
    } catch (e) { /* fall through to the stored choice */ }
    return readOptOut();
  }

  function onProductionSite() {
    try {
      var host = location.hostname;
      if (/(^|\.)ushcodex\.tech$/.test(host)) return true;
      return host === 'localhost' || host === '127.0.0.1';
    } catch (e) { return false; }
  }

  function referrerHost() {
    try {
      if (!document.referrer) return '';
      var host = new URL(document.referrer).hostname.replace(/^www\./, '').toLowerCase();
      return host.slice(0, 60);
    } catch (e) { return ''; }
  }

  function send(payload) {
    if (!onProductionSite() || isBlocked()) return;
    var body;
    try { body = JSON.stringify(payload); } catch (e) { return; }
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) { /* fall back to fetch */ }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors'
      })['catch'](function () {});
    } catch (e) { /* analytics must never surface an error */ }
  }

  /* Allow-listed, coarse fields only. Anything unexpected is dropped. */
  window.u200Track = function (event, data) {
    try {
      if (typeof event !== 'string' || !/^[a-z_]{3,24}$/.test(event)) return;
      var payload = { e: event };
      if (data && typeof data === 'object') {
        if (data.k === 'ok' || data.k === 'fail' || data.k === 'image' || data.k === 'pdf') payload.k = data.k;
        if (typeof data.d === 'string' && /^(image|pdf)-(jpg|pdf)$/.test(data.d)) payload.d = data.d;
        if (typeof data.t === 'number' && data.t > 0 && data.t <= 20000) payload.t = Math.round(data.t);
        if (typeof data.b === 'string' && /^(<=50|<=100|<=200|<=500|>500)$/.test(data.b)) payload.b = data.b;
        if (typeof data.ms === 'string' && /^(<1s|1-3s|3-8s|>8s)$/.test(data.ms)) payload.ms = data.ms;
      }
      // Events without their essential shape are dropped, not guessed.
      if (event === 'compress' && payload.k !== 'ok' && payload.k !== 'fail') return;
      if (event === 'file_selected' && payload.k !== 'image' && payload.k !== 'pdf') return;
      payload.r = referrerHost();
      send(payload);
    } catch (e) { /* never throw into the tool */ }
  };

  function countView() {
    try {
      if (window.__u200ViewCounted) return;
      window.__u200ViewCounted = true;
      window.u200Track('view', {});
    } catch (e) { /* ignore */ }
  }

  function schedule() {
    if (window.requestIdleCallback) window.requestIdleCallback(countView, { timeout: 3000 });
    else setTimeout(countView, 1200);
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
})();
