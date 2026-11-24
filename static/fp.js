// Browser fingerprint for alt-account detection. Runs on the sign-up and log-in pages only and puts one JSON string in
// the hidden <input data-fp>; the server hashes it (security.fp_digest). Nothing here is secret or trusted: it only
// lets admins notice that several accounts come from one device. Every probe is wrapped, so a blocked API just leaves
// that field out instead of breaking the form.
(function () {
  'use strict';
  var input = document.querySelector('input[data-fp]');
  if (!input) return;
  var data = {};

  function safe(fn, fallback) { try { var v = fn(); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // A random token kept in localStorage. The server also sets a cookie, so clearing only one of them still links the device.
  data.token = safe(function () {
    var k = 'mams-device', t = localStorage.getItem(k);
    if (!/^[0-9a-f]{32}$/.test(t || '')) {
      var a = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(a);
      t = hex(a);
      localStorage.setItem(k, t);
    }
    return t;
  }, '');

  data.screen = safe(function () { return [screen.width, screen.height, screen.colorDepth, window.devicePixelRatio || 1].join('x'); }, '');
  data.tz = safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, '');
  data.langs = safe(function () { return (navigator.languages || [navigator.language]).join(','); }, '');
  data.platform = safe(function () { return navigator.platform; }, '');
  data.touch = safe(function () { return navigator.maxTouchPoints || 0; }, 0);
  data.hc = safe(function () { return navigator.hardwareConcurrency; }, '');
  data.dm = safe(function () { return navigator.deviceMemory; }, '');
  data.wd = safe(function () { return navigator.webdriver ? 1 : 0; }, 0);

  // How this device draws text and shapes (differs with GPU, drivers, fonts and OS).
  data.canvas = safe(function () {
    var c = document.createElement('canvas');
    c.width = 220; c.height = 40;
    var x = c.getContext('2d');
    x.textBaseline = 'top';
    x.font = "16px 'Arial'";
    x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
    x.fillStyle = '#069'; x.fillText('MAMS Markets éü☃', 2, 15);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('MAMS Markets éü☃', 4, 17);
    x.beginPath(); x.arc(50, 25, 18, 0, Math.PI * 2, true); x.stroke();
    var url = c.toDataURL();
    var h = 0;
    for (var i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
    return h.toString(16) + ':' + url.length;
  }, '');

  data.webgl = safe(function () {
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    var ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) + '|' + gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
               : gl.getParameter(gl.VENDOR) + '|' + gl.getParameter(gl.RENDERER);
  }, '');

  // Which fonts are installed, found by measuring text width against three base fonts.
  data.fonts = safe(function () {
    var bases = ['monospace', 'sans-serif', 'serif'], text = 'mmmmmmmmmmlliWWw', size = '72px';
    var span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:' + size + ';visibility:hidden';
    span.textContent = text;
    document.body.appendChild(span);
    var base = {};
    bases.forEach(function (b) { span.style.fontFamily = b; base[b] = span.offsetWidth + 'x' + span.offsetHeight; });
    var list = ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Courier New',
                'Georgia', 'Helvetica', 'Helvetica Neue', 'Impact', 'Lucida Console', 'Menlo', 'Monaco',
                'Palatino', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Roboto',
                'Ubuntu', 'Noto Sans', 'Open Sans', 'Futura', 'Gill Sans', 'Optima', 'Avenir', 'San Francisco',
                'Apple Color Emoji', 'Segoe UI Emoji', 'Source Code Pro', 'Fira Code', 'Cantarell', 'DejaVu Sans',
                'Liberation Sans', 'Lato', 'Montserrat', 'Century Gothic'];
    var found = [];
    list.forEach(function (f, i) {
      var has = bases.some(function (b) {
        span.style.fontFamily = "'" + f + "'," + b;
        return span.offsetWidth + 'x' + span.offsetHeight !== base[b];
      });
      if (has) found.push(i);
    });
    document.body.removeChild(span);
    return found.join('.');
  }, '');

  function fill() { try { input.value = JSON.stringify(data); } catch (e) { /* leave empty */ } }
  fill();

  // Audio: how this device renders a short synthesized tone (differs with the audio stack).
  safe(function () {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return;
    var ctx = new Ctx(1, 5000, 44100);
    var osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 10000;
    var comp = ctx.createDynamicsCompressor();
    ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(function (k, i) {
      if (comp[k] && comp[k].setValueAtTime) comp[k].setValueAtTime([-50, 40, 12, 0, 0.25][i], ctx.currentTime);
    });
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start(0);
    var done = function (buf) {
      var d = buf.getChannelData(0), sum = 0;
      for (var i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
      data.audio = sum.toFixed(6);
      fill();
    };
    var p = ctx.startRendering();
    if (p && p.then) p.then(done, function () {}); else ctx.oncomplete = function (e) { done(e.renderedBuffer); };
  }, null);

  var form = input.form;
  if (form) form.addEventListener('submit', fill);
})();
