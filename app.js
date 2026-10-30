/* Under 200KB: client-side compressor for Ushcodex Technologies
 * Files never leave the device: everything below runs on canvas in this tab.
 * The compression loop is intentionally the same as the original tool:
 * cap the long edge at 2500px, then step JPEG quality down from 0.9 to 0.1.
 */
(function () {
  'use strict';

  var MAX_WIDTH = 2500;
  var PDF_OVERHEAD = 3000;      // bytes reserved for the PDF wrapper
  var QUALITY_START = 0.9;
  var QUALITY_STEP = 0.05;
  var QUALITY_MIN = 0.1;
  var MAX_PASSES = 40;
  var MIN_KB = 20;
  var MAX_KB = 20000;
  var VENDOR_PDF = '/vendor/pdf.min.js';
  var VENDOR_PDF_WORKER = '/vendor/pdf.worker.min.js';
  var VENDOR_JSPDF = '/vendor/jspdf.umd.min.js';

  /* ------------------------------------------------------------------ *
   * Pure helpers (covered by tests/run.mjs)
   * ------------------------------------------------------------------ */

  var RESERVED = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

  function splitName(name) {
    var base = String(name == null ? '' : name);
    // Never let a path fragment leak into the download name (POSIX or Windows).
    base = base.split(/[\\/]/).pop() || '';
    var dot = base.lastIndexOf('.');
    if (dot <= 0) return { stem: base, ext: '' };
    return { stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
  }

  function sanitizeStem(stem) {
    var s = String(stem == null ? '' : stem)
      .normalize('NFC')
      .replace(RESERVED, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    // keep file systems and CDNs happy without touching non-Latin scripts
    var chars = Array.from(s);
    if (chars.length > 96) s = chars.slice(0, 96).join('').replace(/[.\s]+$/, '');
    return s || 'file';
  }

  function buildFilename(originalName, inputKind, outFormat) {
    var stem = sanitizeStem(splitName(originalName).stem);
    var suffix = inputKind === 'pdf' ? 'compressed' : 'under200kb';
    return stem + '-' + suffix + '.' + (outFormat === 'pdf' ? 'pdf' : 'jpg');
  }

  function formatKB(bytes) {
    var kb = bytes / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(2) + ' MB';
    if (kb >= 100) return Math.round(kb) + ' KB';
    if (kb >= 10) return Math.round(kb) + ' KB';
    return kb.toFixed(1) + ' KB';
  }

  function clampKB(value) {
    var n = parseFloat(value);
    if (!isFinite(n) || n <= 0) return { ok: false, kb: 0 };
    if (n < MIN_KB) return { ok: false, kb: MIN_KB };
    if (n > MAX_KB) return { ok: false, kb: MAX_KB };
    return { ok: true, kb: Math.round(n * 10) / 10 };
  }

  /* ------------------------------------------------------------------ *
   * Environment
   * ------------------------------------------------------------------ */

  var doc = document;
  var $ = function (id) { return doc.getElementById(id); };

  var el = {
    form: $('toolForm'),
    dropzone: $('dropzone'),
    file: $('file'),
    dzTitle: $('dzTitle'),
    dzHint: $('dzHint'),
    fileInfo: $('fileInfo'),
    thumb: $('thumb'),
    fileName: $('fileName'),
    fileSize: $('fileSize'),
    clearFile: $('clearFile'),
    fileError: $('fileError'),
    size: $('size'),
    presets: Array.prototype.slice.call(doc.querySelectorAll('.preset')),
    fmtJpg: $('fmtJpg'),
    fmtPdf: $('fmtPdf'),
    formatHelp: $('formatHelp'),
    go: $('go'),
    goLabel: $('goLabel'),
    status: $('status'),
    result: $('result'),
    resultHeading: $('resultHeading'),
    resultThumb: $('resultThumb'),
    outSize: $('outSize'),
    outOriginal: $('outOriginal'),
    outLimit: $('outLimit'),
    download: $('download'),
    downloadLabel: $('downloadLabel'),
    resultWarn: $('resultWarn'),
    again: $('again'),
    share: $('share'),
    optout: $('optout'),
    privacyOpen: $('privacyOpen'),
    privacyDialog: $('privacyDialog'),
    privacyClose: $('privacyClose'),
    privacyCancel: $('privacyCancel'),
    privacySave: $('privacySave'),
    privacySaved: $('privacySaved')
  };

  var state = {
    file: null,
    kind: null,        // 'image' | 'pdf'
    sourceUrl: null,   // what we draw onto the canvas
    objectUrls: [],
    outUrl: null,
    pdfPages: 0,
    busy: false,
    preparing: false
  };

  function track(event, data) {
    try {
      if (typeof window.u200Track === 'function') window.u200Track(event, data || {});
    } catch (e) { /* analytics must never break the tool */ }
  }

  function announce(message) {
    if (el.status) el.status.textContent = message;
  }

  function showError(message) {
    if (!el.fileError) return;
    el.fileError.textContent = message;
    el.fileError.hidden = false;
  }

  function clearError() {
    if (!el.fileError) return;
    el.fileError.hidden = true;
    el.fileError.textContent = '';
  }

  function revokeUrls() {
    state.objectUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    });
    state.objectUrls = [];
  }

  function makeObjectUrl(blob) {
    var url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return url;
  }

  /* ------------------------------------------------------------------ *
   * Lazy vendor loading: only fetch the PDF libraries when they are used
   * ------------------------------------------------------------------ */

  var scriptPromises = {};

  function loadScript(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        delete scriptPromises[src];
        reject(new Error('Could not load ' + src));
      };
      doc.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  function ensurePdfJs() {
    return loadScript(VENDOR_PDF).then(function () {
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR_PDF_WORKER;
      }
      return window.pdfjsLib;
    });
  }

  function ensureJsPdf() {
    return loadScript(VENDOR_JSPDF).then(function () {
      if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF unavailable');
      return window.jspdf.jsPDF;
    });
  }

  /* ------------------------------------------------------------------ *
   * File handling
   * ------------------------------------------------------------------ */

  function detectKind(file) {
    var name = (file.name || '').toLowerCase();
    if (file.type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
    if ((file.type || '').indexOf('image/') === 0) return 'image';
    if (/\.(jpe?g|png|webp|gif|bmp|avif)$/.test(name)) return 'image';
    return null;
  }

  function resetTool(options) {
    var keepFocus = options && options.focus;
    state.file = null;
    state.kind = null;
    state.sourceUrl = null;
    state.pdfPages = 0;
    state.outUrl = null;
    if (el.file) el.file.value = '';
    if (el.fileInfo) el.fileInfo.hidden = true;
    if (el.result) el.result.hidden = true;
    if (el.resultWarn) el.resultWarn.hidden = true;
    state.preparing = false;
    if (el.go) {
      el.go.disabled = false;
      el.goLabel.textContent = 'Compress file';
    }
    if (el.download) {
      el.download.setAttribute('aria-disabled', 'true');
      el.download.removeAttribute('href');
      el.download.removeAttribute('aria-label');
    }
    if (el.downloadLabel) el.downloadLabel.textContent = 'Download';
    if (el.thumb) el.thumb.removeAttribute('src');
    if (el.resultThumb) {
      el.resultThumb.hidden = true;
      el.resultThumb.removeAttribute('src');
    }
    revokeUrls();
    clearError();
    updateFormatHelp();
    announce('');
    if (el.dropzone) el.dropzone.classList.remove('has-file');
    if (el.dzTitle) el.dzTitle.textContent = 'Tap to choose a file';
    if (el.dzHint) el.dzHint.textContent = 'Image or PDF';
    if (keepFocus && el.file) el.file.focus();
  }

  function setSelectedFile(file) {
    clearError();
    var kind = detectKind(file);
    if (!kind) {
      showError('That file type isn’t supported. Choose an image or a PDF.');
      state.file = null;
      if (el.file) el.file.value = '';
      return;
    }
    revokeUrls();
    state.file = file;
    state.kind = kind;
    state.sourceUrl = null;
    state.pdfPages = 0;
    state.outUrl = null;
    if (el.result) el.result.hidden = true;
    if (el.resultWarn) el.resultWarn.hidden = true;
    if (el.fileInfo) el.fileInfo.hidden = false;
    if (el.fileName) el.fileName.textContent = file.name;
    if (el.fileSize) el.fileSize.textContent = formatKB(file.size) + ' · ' + (kind === 'pdf' ? 'PDF document' : 'Image');
    if (el.dropzone) el.dropzone.classList.add('has-file');
    if (el.dzTitle) el.dzTitle.textContent = 'Choose another file';
    if (el.dzHint) el.dzHint.textContent = 'Drag it here or tap to browse';

    if (kind === 'pdf') {
      el.fmtPdf.checked = true;
      updateFormatHelp();
      if (el.thumb) el.thumb.removeAttribute('src');
      setPreparing(true);
      announce('PDF selected. Preparing a preview…');
      preparePdf(file);
    } else {
      el.fmtJpg.checked = true;
      updateFormatHelp();
      var url = URL.createObjectURL(file);
      state.sourceUrl = url;
      state.objectUrls.push(url);
      if (el.thumb) el.thumb.src = url;
      announce('Image chosen. Set a limit and a format.');
      track('file_selected', { k: 'image' });
    }
  }

  /** Disable the primary action while a PDF preview is still rendering. */
  function setPreparing(preparing, message) {
    state.preparing = preparing;
    if (!el.go) return;
    el.go.disabled = preparing || state.busy;
    el.goLabel.textContent = preparing ? 'Preparing preview…' : (state.busy ? 'Compressing…' : 'Compress file');
    if (message) announce(message);
  }

  function preparePdf(file) {
    var reader = new FileReader();
    reader.onload = function () {
      ensurePdfJs().then(function (pdfjsLib) {
        return pdfjsLib.getDocument({ data: new Uint8Array(reader.result) }).promise;
      }).then(function (pdf) {
        state.pdfPages = pdf.numPages;
        return pdf.getPage(1).then(function (page) {
          var viewport = page.getViewport({ scale: 1.5 });
          var canvas = doc.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
            var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            state.sourceUrl = dataUrl;
            if (el.thumb) el.thumb.src = dataUrl;
            updateFormatHelp();
            setPreparing(false, pdf.numPages > 1
              ? 'PDF ready. This one has ' + pdf.numPages + ' pages, and only the first page is used.'
              : 'PDF ready. Choose a format and compress.');
            track('file_selected', { k: 'pdf' });
          });
        });
      }).catch(function () {
        setPreparing(false, '');
        showError('We couldn’t read that PDF in this browser. Try another file.');
      });
    };
    reader.onerror = function () {
      setPreparing(false, '');
      showError('We couldn’t read that file. Please try again.');
    };
    reader.readAsArrayBuffer(file);
  }

  function updateFormatHelp() {
    if (!el.formatHelp) return;
    var kind = state.kind;
    var wantsPdf = el.fmtPdf.checked;
    if (!kind) {
      el.formatHelp.textContent = '';
      el.formatHelp.hidden = true;
      return;
    }
    el.formatHelp.hidden = false;
    if (kind === 'image' && wantsPdf) {
      el.formatHelp.textContent = 'Your image becomes a PDF.';
    } else if (kind === 'image') {
      el.formatHelp.textContent = 'Your image stays a JPG, only smaller.';
    } else if (state.pdfPages > 1) {
      el.formatHelp.textContent = wantsPdf
        ? 'This PDF has ' + state.pdfPages + ' pages. Only the first page is kept.'
        : 'This PDF has ' + state.pdfPages + ' pages. Only the first page becomes a JPG.';
    } else if (wantsPdf) {
      el.formatHelp.textContent = 'Your PDF is rebuilt, smaller.';
    } else {
      el.formatHelp.textContent = 'Your PDF becomes a JPG.';
    }
  }

  /* ------------------------------------------------------------------ *
   * The compressor
   * ------------------------------------------------------------------ */

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', quality);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Image could not be decoded')); };
      img.src = src;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Image could not be read')); };
      reader.readAsDataURL(blob);
    });
  }

  function compressToJpeg(img, limitBytes) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return Promise.reject(new Error('Image has no size'));
    if (w > MAX_WIDTH) {
      h = Math.round(h * (MAX_WIDTH / w));
      w = MAX_WIDTH;
    }
    var canvas = doc.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    // White matte: transparent PNGs used to become black JPEGs.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    var quality = QUALITY_START;
    var passes = 0;

    function attempt() {
      return canvasToBlob(canvas, quality).then(function (blob) {
        passes += 1;
        if (!blob) throw new Error('The browser could not encode this image');
        if (blob.size <= limitBytes || quality <= QUALITY_MIN || passes >= MAX_PASSES) {
          return { blob: blob, width: w, height: h, quality: quality, passes: passes };
        }
        quality = Math.round((quality - QUALITY_STEP) * 100) / 100;
        return attempt();
      });
    }
    return attempt();
  }

  function buildPdf(imageBlob, width, height) {
    // jsPDF reads the image asynchronously, so hand it the encoded data URL
    // rather than a blob URL that could be revoked underneath it.
    return Promise.all([ensureJsPdf(), blobToDataUrl(imageBlob)]).then(function (parts) {
      var JsPDF = parts[0];
      var pdf = new JsPDF({
        orientation: width > height ? 'l' : 'p',
        unit: 'px',
        format: [width, height],
        compress: true
      });
      pdf.addImage(parts[1], 'JPEG', 0, 0, width, height);
      return pdf.output('blob');
    });
  }

  function setBusy(busy) {
    state.busy = busy;
    if (!el.go) return;
    el.go.disabled = busy || state.preparing;
    el.goLabel.textContent = busy ? 'Compressing…' : (state.preparing ? 'Preparing preview…' : 'Compress file');
  }

  function compress() {
    if (state.busy) return;
    if (!state.file) {
      showError('Choose a file first, then set a limit and compress.');
      if (el.file) el.file.focus();
      return;
    }
    clearError();
    var checked = clampKB(el.size.value);
    if (!checked.ok) {
      showError('Enter a size limit between ' + MIN_KB + ' KB and ' + MAX_KB + ' KB.');
      el.size.value = String(checked.kb || 200);
      el.size.focus();
      return;
    }
    var sizeKb = checked.kb;
    var wantsPdf = el.fmtPdf.checked;
    var limitBytes = sizeKb * 1024;
    var direction = state.kind + '-' + (wantsPdf ? 'pdf' : 'jpg');

    if (state.preparing || (state.kind === 'pdf' && !state.sourceUrl)) {
      showError('Still preparing the PDF preview. Give it a second and try again.');
      return;
    }

    setBusy(true);
    announce('Compressing your file…');
    var startedAt = Date.now();

    loadImage(state.sourceUrl).then(function (img) {
      var budget = wantsPdf ? limitBytes - PDF_OVERHEAD : limitBytes;
      return compressToJpeg(img, budget).then(function (result) {
        if (!wantsPdf) return result;
        return buildPdf(result.blob, result.width, result.height).then(function (pdfBlob) {
          return {
            blob: pdfBlob,
            width: result.width,
            height: result.height,
            quality: result.quality,
            passes: result.passes,
            previewBlob: result.blob
          };
        });
      });
    }).then(function (out) {
      showResult(out, sizeKb, wantsPdf, Date.now() - startedAt);
      track('compress', {
        k: 'ok',
        d: direction,
        t: sizeKb,
        b: sizeBucket(sizeKb),
        ms: bucketMs(Date.now() - startedAt)
      });
    }).catch(function (err) {
      setBusy(false);
      announce('');
      var offline = err && /Could not load/.test(err.message || '');
      showError(offline
        ? 'The PDF tools couldn’t load. Check your connection and try again.'
        : 'That file couldn’t be processed. Try a JPG or PNG image, or another PDF.');
      track('compress', { k: 'fail', d: direction, t: sizeKb });
    });
  }

  function sizeBucket(kb) {
    if (kb <= 50) return '<=50';
    if (kb <= 100) return '<=100';
    if (kb <= 200) return '<=200';
    if (kb <= 500) return '<=500';
    return '>500';
  }

  function bucketMs(ms) {
    if (ms < 1000) return '<1s';
    if (ms < 3000) return '1-3s';
    if (ms < 8000) return '3-8s';
    return '>8s';
  }

  function showResult(out, sizeKb, wantsPdf, elapsed) {
    setBusy(false);
    var name = buildFilename(state.file.name, state.kind, wantsPdf ? 'pdf' : 'jpg');
    var url = makeObjectUrl(out.blob);
    state.outUrl = url;

    el.outSize.textContent = formatKB(out.blob.size);
    el.outOriginal.textContent = formatKB(state.file.size);
    el.outLimit.textContent = sizeKb + ' KB';
    el.download.href = url;
    el.download.setAttribute('download', name);
    el.download.removeAttribute('aria-disabled');
    el.downloadLabel.textContent = 'Download ' + name;
    el.download.setAttribute('aria-label', 'Download ' + name);

    if (el.resultThumb) {
      var previewSrc = wantsPdf ? state.sourceUrl : url;
      if (previewSrc) {
        el.resultThumb.src = previewSrc;
        el.resultThumb.hidden = false;
      } else {
        el.resultThumb.hidden = true;
      }
    }

    if (out.blob.size > sizeKb * 1024) {
      el.resultWarn.hidden = false;
      el.resultWarn.textContent = 'This is the smallest version we could make: ' + formatKB(out.blob.size) +
        ', still above ' + sizeKb + ' KB. Use a smaller or simpler source image, or raise the limit.';
    } else {
      el.resultWarn.hidden = true;
    }

    el.result.hidden = false;
    announce('Done. ' + formatKB(out.blob.size) + ' ' + (wantsPdf ? 'PDF' : 'JPG') + ', ready to download as ' + name + '.');
    el.resultHeading.textContent = 'Your file is ready';
    if (el.result && el.result.scrollIntoView) {
      try { el.result.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    }
    try { el.resultHeading.focus({ preventScroll: true }); } catch (e) { el.resultHeading.focus(); }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  if (el.form) {
    el.form.addEventListener('submit', function (event) {
      event.preventDefault();
      compress();
    });
  }

  if (el.file) {
    el.file.addEventListener('change', function () {
      if (el.file.files && el.file.files[0]) setSelectedFile(el.file.files[0]);
    });
  }

  if (el.dropzone) {
    ['dragenter', 'dragover'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        el.dropzone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach(function (type) {
      el.dropzone.addEventListener(type, function () {
        el.dropzone.classList.remove('is-dragging');
      });
    });
    el.dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files[0]) setSelectedFile(files[0]);
    });
  }

  if (el.clearFile) {
    el.clearFile.addEventListener('click', function () {
      if (el.file) el.file.click();
    });
  }

  el.presets.forEach(function (button) {
    button.addEventListener('click', function () {
      el.size.value = button.getAttribute('data-kb');
      syncPresets();
      announce('Limit set to ' + el.size.value + ' KB.');
    });
  });

  function syncPresets() {
    if (!el.size) return;
    var current = parseInt(el.size.value, 10);
    el.presets.forEach(function (button) {
      button.setAttribute('aria-pressed', String(parseInt(button.getAttribute('data-kb'), 10) === current));
    });
  }

  if (el.size) {
    el.size.addEventListener('input', syncPresets);
    el.size.addEventListener('blur', function () {
      var checked = clampKB(el.size.value);
      if (!checked.kb) el.size.value = '200';
      syncPresets();
    });
  }

  [el.fmtJpg, el.fmtPdf].forEach(function (radio) {
    if (radio) radio.addEventListener('change', updateFormatHelp);
    if (radio) radio.addEventListener('change', function () { clearError(); });
  });

  if (el.again) {
    el.again.addEventListener('click', function () {
      resetTool({ focus: true });
    });
  }

  if (el.share) {
    el.share.addEventListener('click', function () {
      var data = {
        title: 'Under 200KB',
        text: 'Compress an image or PDF to fit a strict upload limit, on your device.',
        url: 'https://under200kb.ushcodex.tech/'
      };
      if (navigator.share) {
        navigator.share(data).catch(function () { /* dismissed */ });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.url).then(function () {
          announce('Link copied to the clipboard.');
        }).catch(function () { /* ignore */ });
      }
    });
  }

  if (el.download) {
    el.download.addEventListener('click', function () {
      if (el.download.getAttribute('aria-disabled') === 'true') return;
      track('download', { d: state.kind + '-' + (el.fmtPdf.checked ? 'pdf' : 'jpg') });
    });
  }

  function savedOptOut() {
    try { return typeof window.u200OptedOut === 'function' ? Boolean(window.u200OptedOut()) : false; } catch (e) { return false; }
  }

  function openPrivacy() {
    if (!el.privacyDialog) return;
    if (el.optout) el.optout.checked = savedOptOut();
    if (el.privacySaved) {
      el.privacySaved.hidden = true;
      el.privacySaved.textContent = '';
    }
    if (typeof el.privacyDialog.showModal === 'function') {
      try { el.privacyDialog.showModal(); } catch (e) { el.privacyDialog.setAttribute('open', ''); }
    } else {
      el.privacyDialog.setAttribute('open', '');
    }
    if (el.privacyClose) el.privacyClose.focus();
  }

  function closePrivacy(returnFocus) {
    if (!el.privacyDialog) return;
    if (typeof el.privacyDialog.close === 'function' && el.privacyDialog.open) {
      el.privacyDialog.close();
    } else {
      el.privacyDialog.removeAttribute('open');
    }
    if (returnFocus !== false && el.privacyOpen) el.privacyOpen.focus();
  }

  function savePrivacy() {
    var optedOut = Boolean(el.optout && el.optout.checked);
    if (typeof window.u200SetOptOut === 'function') window.u200SetOptOut(optedOut);
    if (el.privacySaved) {
      el.privacySaved.textContent = optedOut
        ? 'Saved. Anonymous usage counts are off.'
        : 'Saved. Anonymous usage counts are on.';
      el.privacySaved.hidden = false;
    }
  }

  if (el.privacyOpen) el.privacyOpen.addEventListener('click', openPrivacy);
  if (el.privacyClose) el.privacyClose.addEventListener('click', function () { closePrivacy(); });
  if (el.privacyDialog) {
    el.privacyDialog.addEventListener('click', function (event) {
      if (event.target === el.privacyDialog) closePrivacy();
    });
    el.privacyDialog.addEventListener('cancel', function () {
      // Escape keeps any saved choice: reopen to change it.
      if (el.optout) el.optout.checked = savedOptOut();
    });
  }
  if (el.privacyCancel) {
    el.privacyCancel.addEventListener('click', function () {
      // Cancel discards an unsaved change.
      if (el.optout) el.optout.checked = savedOptOut();
      closePrivacy();
    });
  }
  if (el.privacySave) el.privacySave.addEventListener('click', savePrivacy);

  syncPresets();
  updateFormatHelp();
  if (el.download) el.download.setAttribute('aria-disabled', 'true');

  /* Expose pure helpers for the test suite (no runtime cost in the browser). */
  window.U200 = {
    splitName: splitName,
    sanitizeStem: sanitizeStem,
    buildFilename: buildFilename,
    formatKB: formatKB,
    clampKB: clampKB
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (registration) {
        registration.addEventListener('updatefound', function () {
          var installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', function () {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              announce('A new version of Under 200KB is ready. Reload to use it.');
            }
          });
        });
      }).catch(function () { /* offline support is a bonus, never a blocker */ });
    });
  }
})();
