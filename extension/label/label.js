// Label Resizer (extension edition) — same tool as myrepairtools.com's
// label-resizer.html, but pre-loaded with whatever PDF/image the active tab
// was showing when the user picked it from the extension menu (bg.js stashes
// the bytes in chrome.storage.session; nothing is saved to disk).
import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

var $ = function (s, c) { return (c || document).querySelector(s); };
function toast(m, err) { var t = $('#toast'); t.textContent = m; t.className = 'toast show' + (err ? ' err' : ''); setTimeout(function () { t.className = 'toast'; }, 2600); }

var QUEUE = [];
var PAGE_N = 0;

/* ---------- intake ---------- */
var drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', function () { fileInput.click(); });
fileInput.addEventListener('change', function () { handleFiles(fileInput.files); fileInput.value = ''; });
['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
document.addEventListener('paste', function (e) {
  var items = (e.clipboardData && e.clipboardData.items) || [];
  for (var i = 0; i < items.length; i++) {
    var f = items[i].getAsFile && items[i].getAsFile();
    if (f) handleFiles([f]);
  }
});

async function handleFiles(files) {
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) await addPdf(await f.arrayBuffer());
      else if (/^image\//.test(f.type)) await addImageBlob(f);
      else toast('Not a PDF or image — skipped ' + f.name, true);
    } catch (e) { toast('Could not read ' + (f.name || 'file') + ' — ' + e.message, true); }
  }
}

async function addPdf(buf) {
  var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  for (var p = 1; p <= pdf.numPages; p++) {
    var page = await pdf.getPage(p);
    var v1 = page.getViewport({ scale: 1 });
    var vp = page.getViewport({ scale: Math.min(3, 1600 / v1.width) });
    var c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    addPageCard(c);
  }
}
function addImageBlob(blob) {
  return new Promise(function (res, rej) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      var scale = Math.min(1, 2000 / img.naturalWidth);
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      addPageCard(c); URL.revokeObjectURL(img.src); res();
    };
    img.onerror = function () { rej(new Error('bad image')); };
    img.src = URL.createObjectURL(blob);
  });
}

/* ---------- page cards + drag-select ---------- */
function addPageCard(canvas) {
  PAGE_N++;
  var card = document.createElement('div'); card.className = 'pagecard';
  card.innerHTML = '<div class="bar"><span class="t">Page ' + PAGE_N + '</span>'
    + '<span class="h">drag a box around what you want on the 4×6</span>'
    + '<span class="sp">'
    + '<button class="btn sm addsel" disabled>✂ Add Selection</button>'
    + '<button class="btn sm addfull">＋ Add Whole Page</button>'
    + '</span></div>'
    + '<div class="canvwrap"><div class="marquee"></div></div>';
  card.querySelector('.canvwrap').appendChild(canvas);
  $('#pages').appendChild(card);

  var mq = card.querySelector('.marquee'), addSel = card.querySelector('.addsel'), sel = null, drag = null;
  function toCanvasXY(e) {
    var r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * canvas.width / r.width)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * canvas.height / r.height))
    };
  }
  function drawMq() {
    if (!sel) { mq.style.display = 'none'; return; }
    var r = canvas.getBoundingClientRect(), k = r.width / canvas.width;
    mq.style.display = 'block';
    mq.style.left = (sel.x * k) + 'px'; mq.style.top = (sel.y * k) + 'px';
    mq.style.width = (sel.w * k) + 'px'; mq.style.height = (sel.h * k) + 'px';
  }
  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    drag = toCanvasXY(e); sel = null; drawMq();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var p = toCanvasXY(e);
    sel = { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) };
    drawMq();
  });
  canvas.addEventListener('pointerup', function () {
    drag = null;
    if (sel && (sel.w < 20 || sel.h < 20)) { sel = null; drawMq(); }
    addSel.disabled = !sel;
  });
  window.addEventListener('resize', drawMq);

  addSel.addEventListener('click', function () {
    if (!sel) return;
    enqueue(cropCanvas(canvas, sel));
    sel = null; drawMq(); addSel.disabled = true;
  });
  card.querySelector('.addfull').addEventListener('click', function () { enqueue(autoTrim(canvas)); });
}

function cropCanvas(src, sel) {
  var c = document.createElement('canvas');
  c.width = Math.round(sel.w); c.height = Math.round(sel.h);
  c.getContext('2d').drawImage(src, sel.x, sel.y, sel.w, sel.h, 0, 0, c.width, c.height);
  return c;
}
function autoTrim(src) {
  var ctx = src.getContext('2d'), d;
  try { d = ctx.getImageData(0, 0, src.width, src.height).data; } catch (e) { return src; }
  var W = src.width, H = src.height, minX = W, minY = H, maxX = 0, maxY = 0, step = 2;
  for (var y = 0; y < H; y += step) for (var x = 0; x < W; x += step) {
    var i = (y * W + x) * 4;
    if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return src;
  var pad = 10;
  return cropCanvas(src, {
    x: Math.max(0, minX - pad), y: Math.max(0, minY - pad),
    w: Math.min(W, maxX + pad) - Math.max(0, minX - pad),
    h: Math.min(H, maxY + pad) - Math.max(0, minY - pad)
  });
}

/* ---------- queue ---------- */
function rot90(canvas) {
  var r = document.createElement('canvas');
  r.width = canvas.height; r.height = canvas.width;
  var ctx = r.getContext('2d');
  ctx.translate(r.width / 2, r.height / 2); ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return r;
}
function enqueue(canvas) {
  if (canvas.width > canvas.height * 1.15) canvas = rot90(canvas);
  QUEUE.push({ canvas: canvas });
  renderQueue();
  toast('Added to the print queue');
}
function renderQueue() {
  var q = $('#queue');
  if (!QUEUE.length) {
    q.innerHTML = '<div class="qempty">Nothing queued yet.<br>Drag a box around the shipping label, then ✂ Add Selection.</div>';
  } else {
    q.innerHTML = QUEUE.map(function (it, i) {
      return '<div class="qitem"><span class="n">' + (i + 1) + '</span><img src="' + it.canvas.toDataURL('image/png') + '" alt="">'
        + '<button class="x" data-i="' + i + '" title="Remove">✕</button>'
        + '<button class="rot" data-i="' + i + '" title="Rotate 90°">↻</button></div>';
    }).join('');
    q.querySelectorAll('.x').forEach(function (b) {
      b.addEventListener('click', function () { QUEUE.splice(+b.getAttribute('data-i'), 1); renderQueue(); });
    });
    q.querySelectorAll('.rot').forEach(function (b) {
      b.addEventListener('click', function () { var i = +b.getAttribute('data-i'); QUEUE[i].canvas = rot90(QUEUE[i].canvas); renderQueue(); });
    });
  }
  $('#printBtn').disabled = !QUEUE.length;
}

/* ---------- print ---------- */
$('#printBtn').addEventListener('click', function () {
  if (!QUEUE.length) return;
  var html = '<!doctype html><html><head><style>'
    + '@page{size:4in 6in;margin:0}html,body{margin:0;padding:0}'
    + '.pg{width:4in;height:6in;display:flex;align-items:center;justify-content:center;page-break-after:always;overflow:hidden}'
    + '.pg:last-child{page-break-after:auto}'
    + 'img{max-width:97%;max-height:98%}'
    + '</style></head><body>'
    + QUEUE.map(function (it) { return '<div class="pg"><img src="' + it.canvas.toDataURL('image/png') + '"></div>'; }).join('')
    + '</body></html>';
  var f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  f.srcdoc = html;
  f.onload = function () {
    setTimeout(function () {
      f.contentWindow.focus(); f.contentWindow.print();
      setTimeout(function () { f.remove(); }, 60000);
    }, 150);
  };
});

/* ---------- pre-load from the tab the user was on ---------- */
(async function () {
  try {
    var got = await chrome.storage.session.get('mrt_label_stash');
    var st = got && got.mrt_label_stash;
    if (!st) return;
    chrome.storage.session.remove('mrt_label_stash');
    if (st.name) $('#srcName').textContent = '· ' + st.name;
    if (!st.b64) { toast('Couldn’t read that tab automatically — drop the file below instead', true); return; }
    var bin = atob(st.b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    if (st.kind === 'pdf') await addPdf(u8.buffer);
    else await addImageBlob(new Blob([u8]));
  } catch (e) { toast('Auto-load failed — drop the file below instead', true); }
})();
