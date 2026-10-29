/**
 * ═══════════════════════════════════════════════
 *  FOLIO — World-Class Document Scanner
 *  App Logic v3.0
 *
 *  Key Features:
 *  - Pixel-perfect 90° rotation from original image pixels
 *  - Bilinear interpolation for smooth sub-pixel sampling
 *  - Multi-method edge detection (segmentation, flood, edges, contrast)
 *  - Perspective warp with homography
 *  - Real filters applied during warp pass
 *  - Dark mode with persistence
 *  - Context menu (download, rename, delete)
 *  - Responsive sidebar with mobile hamburger
 *  - Drag-and-drop anywhere
 * ═══════════════════════════════════════════════
 */
(() => {
  'use strict';

  // ─── DOM helpers ───
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ─── DOM refs ───
  const fileInput    = $('#fileInput');
  const cameraInput  = $('#cameraInput');
  const scanModal    = $('#scanModal');
  const editorModal  = $('#editorModal');
  const image        = $('#previewImage');
  const overlay      = $('#cropOverlay');
  const svg          = $('#cropSvg');
  const grid         = $('#documentGrid');
  const empty        = $('#emptyState');
  const contextMenu  = $('#contextMenu');

  // ─── State ───
  let sourceImage   = null;
  let baseCanvas    = null;   // Original, un-rotated pixel data
  let currentFile   = null;
  let corners       = [];     // Normalised [x,y] quad (0-1)
  let activeFilter  = 'original';
  let docs          = loadDocs();
  let dragging      = -1;     // Which crop handle is being dragged
  let currentView   = 'all';
  let listMode      = false;
  let coarseAngle   = 0;      // 0, 90, 180, 270
  let contextDoc    = null;    // Document under context menu
  let pendingFiles  = [];

  // ─── Persistence ───
  function loadDocs() {
    try { return JSON.parse(localStorage.getItem('folio-documents') || '[]'); }
    catch { return []; }
  }
  function persist() {
    try { localStorage.setItem('folio-documents', JSON.stringify(docs)); }
    catch { toast('Storage is full — download your scan to keep a copy.'); }
  }

  // ─── Toast ───
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ─── Modal helpers ───
  function showScan()  { scanModal.classList.add('open');   scanModal.setAttribute('aria-hidden', 'false'); }
  function hideScan()  { scanModal.classList.remove('open'); scanModal.setAttribute('aria-hidden', 'true'); }
  function showEditor(){ editorModal.classList.add('open');  editorModal.setAttribute('aria-hidden', 'false'); }
  function hideEditor(){ editorModal.classList.remove('open'); editorModal.setAttribute('aria-hidden', 'true'); }

  // ─── Theme ───
  function initTheme() {
    const saved = localStorage.getItem('folio-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }
  initTheme();

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.onclick = () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('folio-theme', next);
    };
  }

  // ─── Sidebar / Mobile ───
  const sidebar = $('#sidebar');
  const menuToggle = $('#menuToggle');
  let sidebarOverlay = null;

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (!sidebarOverlay) {
      sidebarOverlay = document.createElement('div');
      sidebarOverlay.className = 'sidebar-overlay';
      document.body.appendChild(sidebarOverlay);
      sidebarOverlay.onclick = closeSidebar;
    }
    sidebarOverlay.style.display = 'block';
    requestAnimationFrame(() => sidebarOverlay.classList.add('visible'));
  }
  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    if (sidebarOverlay) {
      sidebarOverlay.classList.remove('visible');
      setTimeout(() => { if (sidebarOverlay) sidebarOverlay.style.display = 'none'; }, 300);
    }
  }
  if (menuToggle && sidebar) menuToggle.onclick = () => sidebar.classList.contains('open') ? closeSidebar() : openSidebar();

  // ─── Button wiring ───
  ['#newScanBtn', '#emptyScan', '#newScanMobile'].forEach(s => {
    const el = $(s);
    if (el) el.addEventListener('click', showScan);
  });

  const headerScan = $('#headerScan');
  const browseLink = $('#browseLink');
  const browseLinkSecondary = $('#browseLinkSecondary');
  const closeModal = $('#closeModal');
  const cameraOption = $('#cameraOption');
  const uploadOption = $('#uploadOption');
  const editorBack = $('#editorBack');
  const retakeBtn = $('#retakeBtn');

  if (headerScan) headerScan.onclick = () => { cameraInput.click(); };
  if (browseLink) browseLink.onclick = () => { fileInput.click(); };
  $$('.scanflow-header [data-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'scan') document.querySelector('#uploadZone')?.scrollIntoView({ behavior: 'smooth' });
    else if (action === 'convert') exportCurrentScan('pdf');
    else if (action === 'download') exportCurrentScan('image');
    else if (action === 'print') exportCurrentScan('print');
  }));
  if (browseLinkSecondary) browseLinkSecondary.onclick = () => { fileInput.click(); };
  if (closeModal) closeModal.onclick   = hideScan;
  if (cameraOption) cameraOption.onclick = () => { hideScan(); cameraInput.click(); };
  if (uploadOption) uploadOption.onclick = () => { hideScan(); fileInput.click(); };
  if (editorBack) editorBack.onclick   = () => { hideEditor(); processNextFile(); };
  if (retakeBtn) retakeBtn.onclick    = () => { hideEditor(); showScan(); };

  [fileInput, cameraInput].forEach(el =>
    el.addEventListener('change', e => {
      const files = [...(e.target.files || [])];
      if (files.length) enqueueFiles(files);
      e.target.value = '';
    })
  );

  // ═══════════════════════════════════════════════
  //  FILE OPENING
  // ═══════════════════════════════════════════════

  function openFile(file) {
    if (file.type === 'application/pdf') { toast('PDF import is not available yet. Choose image files.'); processNextFile(); return; }
    if (!file.type.startsWith('image/')) { toast('Please choose image files.'); processNextFile(); return; }

    currentFile = file;
    coarseAngle = 0;

    const url = URL.createObjectURL(file);
    image.onload = () => {
      sourceImage = image;

      // Store the original pixels
      baseCanvas = document.createElement('canvas');
      baseCanvas.width  = image.naturalWidth;
      baseCanvas.height = image.naturalHeight;
      baseCanvas.getContext('2d').drawImage(image, 0, 0);

      activeFilter = 'original';
      $$('.filter-btn').forEach(x => x.classList.toggle('selected', x.dataset.filter === 'original'));
      image.style.filter = 'none';

      $('#scanName').value = file.name.replace(/\.[^.]+$/, '') || 'Untitled scan';
      detectPage();
      showEditor();
      URL.revokeObjectURL(url);
    };
    image.onerror = () => { toast('This image could not be opened.'); URL.revokeObjectURL(url); processNextFile(); };
    image.src = url;
  }

  function enqueueFiles(files) {
    pendingFiles.push(...files);
    if (pendingFiles.length > 1) toast(`${pendingFiles.length} images queued — review and save each page.`);
    processNextFile();
  }

  function processNextFile() {
    if (!pendingFiles.length || editorModal.classList.contains('open')) return;
    openFile(pendingFiles.shift());
  }

  // ═══════════════════════════════════════════════
  //  EDGE DETECTION
  // ═══════════════════════════════════════════════

  function detectPage() {
    const W = image.naturalWidth, H = image.naturalHeight;
    image.style.transform = 'none';
    corners = [[0.06, 0.05], [0.94, 0.05], [0.94, 0.95], [0.06, 0.95]];

    try {
      const c   = document.createElement('canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const scale = Math.min(1, 600 / Math.max(W, H));
      c.width  = Math.max(3, Math.round(W * scale));
      c.height = Math.max(3, Math.round(H * scale));
      ctx.drawImage(image, 0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      const d = ctx.getImageData(0, 0, w, h).data;

      if (!detectBySegmentation(d, w, h) &&
          !detectByFloodFill(d, w, h))
           detectByEdges(d, w, h);
    } catch { /* fallback stays at default quad */ }

    renderCrop();
    requestAnimationFrame(() => {
      fitPreviewToDocument();
      renderCrop();
    });
  }

  // Zoom and pan the source image so the detected page, rather than the
  // surrounding photograph, is centered in the preview at every quarter turn.
  function fitPreviewToDocument() {
    if (!image.naturalWidth || !corners.length) return;
    image.style.transform = 'none';
    image.style.transformOrigin = '0 0';
    const frame = $('.preview-wrap').getBoundingClientRect();
    const img = image.getBoundingClientRect();
    if (!frame.width || !frame.height || !img.width || !img.height) return;

    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    const left = Math.min(...xs), right = Math.max(...xs);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    const pageWidth = Math.max(0.01, right - left) * img.width;
    const pageHeight = Math.max(0.01, bottom - top) * img.height;
    const zoom = Math.max(0.25, Math.min(3,
      frame.width * 0.82 / pageWidth,
      frame.height * 0.78 / pageHeight));
    const centerX = corners.reduce((sum, p) => sum + p[0], 0) / corners.length;
    const centerY = corners.reduce((sum, p) => sum + p[1], 0) / corners.length;
    const dx = frame.left + frame.width / 2 - img.left - centerX * img.width * zoom;
    const dy = frame.top + frame.height / 2 - img.top - centerY * img.height * zoom;
    image.style.transform = `translate(${dx}px, ${dy}px) scale(${zoom})`;
  }

  function detectBySegmentation(d, w, h) {
    const n = w * h, gray = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const j = i * 4, v = (0.299 * d[j] + 0.587 * d[j+1] + 0.114 * d[j+2]) | 0;
      gray[i] = v; hist[v]++;
    }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let bg = 0, bgSum = 0, best = -1, threshold = 128;
    for (let i = 0; i < 256; i++) {
      bg += hist[i]; if (!bg) continue;
      const fg = n - bg; if (!fg) break;
      bgSum += i * hist[i];
      const m1 = bgSum / bg, m2 = (sum - bgSum) / fg;
      const between = bg * fg * (m1 - m2) * (m1 - m2);
      if (between > best) { best = between; threshold = i; }
    }
    const seen = new Uint8Array(n), queue = new Int32Array(n);
    let chosen = null, chosenSize = 0;
    for (const bright of [true, false]) {
      seen.fill(0);
      for (let start = 0; start < n; start++) {
        if (seen[start] || (bright ? gray[start] <= threshold : gray[start] > threshold)) continue;
        let head = 0, tail = 0;
        queue[tail++] = start; seen[start] = 1;
        let touches = false;
        while (head < tail) {
          const i = queue[head++], x = i % w, y = (i / w) | 0;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
          const a = x ? i - 1 : -1, b = x + 1 < w ? i + 1 : -1;
          const c = y ? i - w : -1, e = y + 1 < h ? i + w : -1;
          for (const j of [a, b, c, e])
            if (j >= 0 && !seen[j] && (bright ? gray[j] > threshold : gray[j] <= threshold))
              { seen[j] = 1; queue[tail++] = j; }
        }
        if (!touches && tail > chosenSize && tail > n * 0.07 && tail < n * 0.82)
          { chosenSize = tail; chosen = queue.slice(0, tail); }
      }
    }
    if (!chosen) return false;
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    for (const i of chosen) {
      const x = i % w, y = (i / w) | 0, s = x + y, k = x - y;
      minS = Math.min(minS, s); maxS = Math.max(maxS, s);
      minD = Math.min(minD, k); maxD = Math.max(maxD, k);
    }
    const find = (fn, target) => {
      let bestDiff = Infinity, point = null;
      for (const i of chosen) {
        const x = i % w, y = (i / w) | 0;
        const diff = Math.abs(fn(x, y) - target);
        if (diff < bestDiff) { bestDiff = diff; point = [x, y]; }
      }
      return point;
    };
    const pts = [
      find((x, y) => x + y, minS),
      find((x, y) => x - y, maxD),
      find((x, y) => x + y, maxS),
      find((x, y) => x - y, minD),
    ];
    const candidate = pts.map(([x, y]) => [x / w, y / h]);
    const area = Math.abs(candidate.reduce((a, p, i) =>
      a + p[0] * candidate[(i + 1) % 4][1] - candidate[(i + 1) % 4][0] * p[1], 0)) / 2;
    if (area < 0.07 || area > 0.82) return false;
    const lengths = candidate.map((p, i) =>
      Math.hypot((p[0] - candidate[(i + 1) % 4][0]) * w, (p[1] - candidate[(i + 1) % 4][1]) * h));
    const ratio = Math.max(lengths[0], lengths[1]) / Math.max(1, Math.min(lengths[0], lengths[1]));
    if (ratio > 8) return false;
    corners = candidate;
    return true;
  }

  function detectByFloodFill(d, w, h) {
    const n = w * h, background = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    const add = (i) => { if (!background[i]) { background[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { add(y * w); add(y * w + w - 1); }
    const limit = 31;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i / w) | 0, base = i * 4;
      for (const j of [x ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y ? i - w : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0 || background[j]) continue;
        const k = j * 4;
        const dr = d[k] - d[base], dg = d[k+1] - d[base+1], db = d[k+2] - d[base+2];
        if (dr * dr + dg * dg + db * db < limit * limit) add(j);
      }
    }
    const seen = background.slice(), component = new Int32Array(n);
    let bestSize = 0, bestComp = null;
    for (let i = 0; i < n; i++) {
      if (seen[i]) continue;
      let qh = 0, qt = 0;
      component[qt++] = i; seen[i] = 1;
      while (qh < qt) {
        const j = component[qh++], x = j % w, y = (j / w) | 0;
        for (const k of [x ? j - 1 : -1, x + 1 < w ? j + 1 : -1, y ? j - w : -1, y + 1 < h ? j + w : -1])
          if (k >= 0 && !seen[k]) { seen[k] = 1; component[qt++] = k; }
      }
      if (qt > bestSize) { bestSize = qt; bestComp = component.slice(0, qt); }
    }
    if (!bestComp || bestSize < n * 0.09 || bestSize > n * 0.94) return false;
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    const points = [];
    for (const i of bestComp) {
      const x = i % w, y = (i / w) | 0;
      if ((x && background[i - 1]) || (x + 1 < w && background[i + 1]) ||
          (y && background[i - w]) || (y + 1 < h && background[i + w]))
        points.push([x, y]);
      minS = Math.min(minS, x + y); maxS = Math.max(maxS, x + y);
      minD = Math.min(minD, x - y); maxD = Math.max(maxD, x - y);
    }
    if (points.length < 20) return false;
    const close = (v) => { let b = Infinity, p = null; for (const q of points) { const z = Math.abs(q[0] + q[1] - v); if (z < b) { b = z; p = q; } } return p; };
    const far   = (v) => { let b = Infinity, p = null; for (const q of points) { const z = Math.abs(q[0] - q[1] - v); if (z < b) { b = z; p = q; } } return p; };
    const candidate = [close(minS), far(maxD), close(maxS), far(minD)].map(([x, y]) => [x / w, y / h]);
    const area = Math.abs(candidate.reduce((a, p, i) =>
      a + p[0] * candidate[(i + 1) % 4][1] - candidate[(i + 1) % 4][0] * p[1], 0)) / 2;
    if (area < 0.08 || area > 0.94) return false;
    corners = candidate;
    return true;
  }

  function detectByEdges(d, w, h) {
    // Build a stable Sobel edge mask, close tiny gaps, then flood from the
    // image border. A closed page/card outline leaves its interior behind.
    const n = w * h, gray = new Uint8Array(n), magnitude = new Uint16Array(n);
    const histogram = new Uint32Array(2041);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      gray[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) | 0;
    }
    let max = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i-w-1] + gray[i-w+1] - 2*gray[i-1] + 2*gray[i+1] - gray[i+w-1] + gray[i+w+1];
      const gy = -gray[i-w-1] - 2*gray[i-w] - gray[i-w+1] + gray[i+w-1] + 2*gray[i+w] + gray[i+w+1];
      const v = Math.min(2040, Math.round(Math.hypot(gx, gy)));
      magnitude[i] = v; histogram[v]++; max = Math.max(max, v);
    }
    if (max < 24) { detectByContrast(d, w, h); return; }
    // Choose a high percentile so texture and printed content do not dominate.
    const total = (w - 2) * (h - 2), target = Math.floor(total * 0.035);
    let accumulated = 0, threshold = 36;
    for (let v = 2040; v >= 1; v--) {
      accumulated += histogram[v];
      if (accumulated >= target) { threshold = Math.max(32, Math.min(150, v)); break; }
    }
    const edge = new Uint8Array(n);
    for (let i = 0; i < n; i++) edge[i] = magnitude[i] >= threshold ? 1 : 0;
    // One-pixel closing bridges small breaks caused by glare or compression.
    const closed = edge.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!edge[i] && ((edge[i-1] && edge[i+1]) || (edge[i-w] && edge[i+w]))) closed[i] = 1;
    }
    const outside = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    const add = i => { if (!outside[i] && !closed[i]) { outside[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { add(y * w); add(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i / w) | 0;
      if (x) add(i - 1); if (x + 1 < w) add(i + 1);
      if (y) add(i - w); if (y + 1 < h) add(i + w);
    }
    // Select the largest enclosed region and use its diagonal extrema. This
    // works for rotated rectangles and perspective-shaped page/card outlines.
    const seen = outside.slice(), component = new Int32Array(n);
    let best = null, bestSize = 0;
    for (let start = 0; start < n; start++) {
      if (seen[start]) continue;
      let qh = 0, qt = 0; component[qt++] = start; seen[start] = 1;
      while (qh < qt) {
        const i = component[qh++], x = i % w, y = (i / w) | 0;
        for (const j of [x ? i-1 : -1, x+1 < w ? i+1 : -1, y ? i-w : -1, y+1 < h ? i+w : -1])
          if (j >= 0 && !seen[j]) { seen[j] = 1; component[qt++] = j; }
      }
      if (qt > bestSize) { bestSize = qt; best = component.slice(0, qt); }
    }
    if (!best || bestSize < n * 0.06 || bestSize > n * 0.94) { detectByContrast(d, w, h); return; }
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    for (const i of best) {
      const x = i % w, y = (i / w) | 0, s = x + y, delta = x - y;
      minS = Math.min(minS, s); maxS = Math.max(maxS, s);
      minD = Math.min(minD, delta); maxD = Math.max(maxD, delta);
    }
    const nearest = (score, target) => {
      let sumX = 0, sumY = 0, weightSum = 0;
      const band = Math.max(2, Math.min(w, h) * 0.012);
      for (const i of best) {
        const x = i % w, y = (i / w) | 0, gap = Math.abs(score(x, y) - target);
        if (gap <= band) { const weight = 1 / (1 + gap); sumX += x * weight; sumY += y * weight; weightSum += weight; }
      }
      return weightSum ? [sumX / weightSum, sumY / weightSum] : [w / 2, h / 2];
    };
    const candidate = [nearest((x,y)=>x+y,minS), nearest((x,y)=>x-y,maxD),
      nearest((x,y)=>x+y,maxS), nearest((x,y)=>x-y,minD)].map(([x,y])=>[x/w,y/h]);
    const area = Math.abs(candidate.reduce((a,p,i)=>a+p[0]*candidate[(i+1)%4][1]-candidate[(i+1)%4][0]*p[1],0))/2;
    const lengths = candidate.map((p,i)=>Math.hypot((p[0]-candidate[(i+1)%4][0])*w,(p[1]-candidate[(i+1)%4][1])*h));
    const valid = area > 0.06 && area < 0.95 && lengths.every(v=>v > Math.min(w,h)*0.08) &&
      Math.max(...lengths) / Math.max(1, Math.min(...lengths)) < 12;
    if (valid) corners = candidate;
    else detectByContrast(d, w, h);
  }

  function detectByContrast(d, w, h) {
    const cornersRgb = [[2,2],[w-3,2],[2,h-3],[w-3,h-3]].map(([x,y]) => {
      const i = (y*w+x)*4; return [d[i], d[i+1], d[i+2]];
    });
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        const i = (y*w+x)*4, r = d[i], g = d[i+1], b = d[i+2];
        let diff = 765;
        for (const s of cornersRgb) diff = Math.min(diff, Math.abs(r-s[0])+Math.abs(g-s[1])+Math.abs(b-s[2]));
        if (diff > 54) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          count++;
        }
      }
    }
    if (count > w*h*0.025 && (maxX-minX) > w*0.3 && (maxY-minY) > h*0.3)
      corners = [[minX/w, minY/h], [maxX/w, minY/h], [maxX/w, maxY/h], [minX/w, maxY/h]];
  }

  // ═══════════════════════════════════════════════
  //  CROP OVERLAY RENDERING
  // ═══════════════════════════════════════════════

  function renderCrop() {
    if (!image.naturalWidth) return;
    overlay.style.display = 'block';
    const r = image.getBoundingClientRect();
    const p = overlay.getBoundingClientRect();
    if (!r.width || !r.height || !p.width) { overlay.style.display = 'none'; return; }
    const ox = r.left - p.left, oy = r.top - p.top;
    const pts = corners.map(([x, y]) => [ox + x * r.width, oy + y * r.height]);
    svg.innerHTML = `<polygon class="crop-poly" points="${pts.map(p => p.join(',')).join(' ')}"/>`;
    $$('.crop-handle').forEach((h, i) => {
      h.style.left = `${pts[i][0]}px`;
      h.style.top  = `${pts[i][1]}px`;
    });
  }

  function updateCorner(e) {
    const p = overlay.getBoundingClientRect();
    const r = image.getBoundingClientRect();
    const ox = r.left - p.left, oy = r.top - p.top;
    corners[dragging] = [
      Math.max(0, Math.min(1, (e.clientX - p.left - ox) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - p.top  - oy) / r.height)),
    ];
    renderCrop();
  }

  $$('.crop-handle').forEach((h, i) => {
    h.addEventListener('pointerdown', e => {
      dragging = i;
      h.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    h.addEventListener('pointermove', e => { if (dragging >= 0) updateCorner(e); });
    h.addEventListener('pointerup',     () => dragging = -1);
    h.addEventListener('pointercancel', () => dragging = -1);
  });

  window.addEventListener('resize', () => requestAnimationFrame(() => {
    fitPreviewToDocument();
    renderCrop();
  }));

  // ═══════════════════════════════════════════════
  //  FILTERS (CSS preview only — real applied at warp)
  // ═══════════════════════════════════════════════

  const filterCSS = {
    original: 'none',
    magic:    'contrast(1.14) saturate(1.22) brightness(1.04)',
    gray:     'grayscale(1) contrast(1.08)',
    bw:       'grayscale(1) contrast(1.8) brightness(1.08)',
    lighten:  'brightness(1.19) contrast(0.93)',
    sharpen:  'contrast(1.12) brightness(1.02)',
  };

  $$('.filter-btn').forEach(b => b.onclick = () => {
    activeFilter = b.dataset.filter;
    $$('.filter-btn').forEach(x => x.classList.toggle('selected', x === b));
    image.style.filter = filterCSS[activeFilter];
  });

  // ═══════════════════════════════════════════════
  //  ROTATION — PIXEL-PERFECT IMPLEMENTATION
  //
  //  Architecture:
  //  - `baseCanvas` holds the ORIGINAL image pixels (never modified).
  //  - `coarseAngle` = multiples of 90° (via buttons).
  //  - Rotation uses exact 90° steps from the original pixel canvas.
  //  - When the total angle changes we create a NEW rotated
  //    canvas using **bilinear interpolation** for sub-pixel
  //    accuracy, then assign it to `image.src`.
  //  - The crop quad is re-detected after every rotation.
  // ═══════════════════════════════════════════════

  function totalAngle() {
    return coarseAngle;
  }

  /**
   * Produce a rotated version of `baseCanvas` at the given angle (degrees).
   * Uses bilinear interpolation for non-90° multiples so text edges
   * look smooth and no staircase artifacts appear.
   *
   * Returns a canvas containing the rotated image.
   */
  function createRotatedCanvas(angleDeg) {
    if (!baseCanvas) return null;

    const sw = baseCanvas.width;
    const sh = baseCanvas.height;
    const rad = angleDeg * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Calculate bounding box of the rotated rectangle
    const abscos = Math.abs(cos);
    const abssin = Math.abs(sin);
    const dw = Math.round(sw * abscos + sh * abssin);
    const dh = Math.round(sw * abssin + sh * abscos);

    // Exact quarter-turns use lossless pixel remapping. This avoids browser
    // canvas interpolation, which can soften fine print or make it look skewed.
    const isExact90 = (angleDeg % 90 === 0);

    const out = document.createElement('canvas');
    out.width  = dw;
    out.height = dh;
    const ctx = out.getContext('2d');

    if (isExact90) {
      // Use a proper canvas rotation transform for exact quarter-turns.
      // This keeps the page rotation crisp while avoiding mirrored or
      // inverted text caused by manual pixel remapping mistakes.
      const angle = ((angleDeg % 360) + 360) % 360;
      ctx.clearRect(0, 0, dw, dh);
      ctx.save();
      ctx.translate(dw / 2, dh / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.translate(-sw / 2, -sh / 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(baseCanvas, 0, 0);
      ctx.restore();
    } else {
      // ── PRECISE PATH: bilinear interpolation for arbitrary angles ──
      const srcCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
      const srcData = srcCtx.getImageData(0, 0, sw, sh).data;
      const dstImg = ctx.createImageData(dw, dh);
      const dst = dstImg.data;

      // Centre of source and destination
      const cx_dst = dw / 2;
      const cy_dst = dh / 2;
      const cx_src = sw / 2;
      const cy_src = sh / 2;

      // Inverse rotation (map destination → source)
      const icos =  cos;  // cos(-θ) = cos(θ)
      const isin = -sin;  // sin(-θ) = -sin(θ)

      for (let dy = 0; dy < dh; dy++) {
        for (let dx = 0; dx < dw; dx++) {
          // Translate to origin
          const px = dx - cx_dst;
          const py = dy - cy_dst;

          // Inverse-rotate to find source coordinate
          const sx = icos * px - isin * py + cx_src;
          const sy = isin * px + icos * py + cy_src;

          // Bounds check with half-pixel margin
          if (sx < -0.5 || sx >= sw - 0.5 || sy < -0.5 || sy >= sh - 0.5) continue;

          // ── Bilinear interpolation ──
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const x1 = Math.min(x0 + 1, sw - 1);
          const y1 = Math.min(y0 + 1, sh - 1);
          const fx = sx - x0;
          const fy = sy - y0;

          // Clamp for edge pixels
          const cx0 = Math.max(0, x0);
          const cy0 = Math.max(0, y0);

          const i00 = (cy0 * sw + cx0) * 4;
          const i10 = (cy0 * sw + x1)  * 4;
          const i01 = (y1  * sw + cx0) * 4;
          const i11 = (y1  * sw + x1)  * 4;

          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx       * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx       * fy;

          const di = (dy * dw + dx) * 4;
          dst[di]     = srcData[i00]     * w00 + srcData[i10]     * w10 + srcData[i01]     * w01 + srcData[i11]     * w11;
          dst[di + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
          dst[di + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
          dst[di + 3] = srcData[i00 + 3] * w00 + srcData[i10 + 3] * w10 + srcData[i01 + 3] * w01 + srcData[i11 + 3] * w11;
        }
      }
      ctx.putImageData(dstImg, 0, 0);
    }

    return out;
  }

  /**
   * Apply the current rotation (coarse + fine) to the preview image.
   * After the image loads its new src, re-detect page edges.
   */
  function applyRotation() {
    const angle = totalAngle();
    const rotated = createRotatedCanvas(angle);
    if (!rotated) return;

    image.classList.add('rotating');
    image.onload = () => {
      sourceImage = image;
      image.classList.remove('rotating');
      image.style.filter = filterCSS[activeFilter];
      detectPage();
    };
    image.src = rotated.toDataURL('image/png');
  }

  // ── Coarse rotation (90° buttons) ──
  const rotateLeftBtn = $('#rotateLeft');
  const rotateRightBtn = $('#rotateRight');
  if (rotateLeftBtn) {
    rotateLeftBtn.onclick = () => {
      coarseAngle = (coarseAngle - 90 + 360) % 360;
      applyRotation();
    };
  }
  if (rotateRightBtn) {
    rotateRightBtn.onclick = () => {
      coarseAngle = (coarseAngle + 90) % 360;
      applyRotation();
    };
  }

  // ═══════════════════════════════════════════════
  //  PERSPECTIVE WARP + FILTER APPLICATION
  // ═══════════════════════════════════════════════

  /** Solve 8×8 linear system for homography via Gaussian elimination */
  function solve(A, b) {
    for (let i = 0; i < 8; i++) {
      let max = i;
      for (let j = i + 1; j < 8; j++) if (Math.abs(A[j][i]) > Math.abs(A[max][i])) max = j;
      [A[i], A[max]] = [A[max], A[i]];
      [b[i], b[max]] = [b[max], b[i]];
      const d = A[i][i] || 1e-12;
      for (let k = i; k < 8; k++) A[i][k] /= d;
      b[i] /= d;
      for (let j = 0; j < 8; j++) {
        if (j === i) continue;
        const m = A[j][i];
        for (let k = i; k < 8; k++) A[j][k] -= m * A[i][k];
        b[j] -= m * b[i];
      }
    }
    return b;
  }

  /**
   * Warp the image from the detected quad into a rectangle,
   * applying the selected filter in a single pass (per-pixel).
   * Uses bilinear interpolation for sub-pixel accuracy.
   */
  function warpAndFilter() {
    const W = image.naturalWidth, H = image.naturalHeight;
    const src = document.createElement('canvas');
    const sc  = src.getContext('2d', { willReadFrequently: true });
    src.width = W; src.height = H;
    sc.drawImage(image, 0, 0);

    const pts = corners.map(([x, y]) => [x * W, y * H]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const ow = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
    const oh = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));

    const out = document.createElement('canvas');
    out.width  = Math.max(1, Math.min(3200, Math.round(ow)));
    out.height = Math.max(1, Math.min(4200, Math.round(oh)));
    const w = out.width, h = out.height;

    // Build homography
    const dstPts = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [], bv = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dstPts[i], [u, v] = pts[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
    }
    const q = solve(A, bv);

    const id   = sc.getImageData(0, 0, W, H);
    const data = id.data;
    const od   = out.getContext('2d').createImageData(w, h);
    const z    = od.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const den = q[6] * x + q[7] * y + 1;
        const sxf = (q[0] * x + q[1] * y + q[2]) / den;
        const syf = (q[3] * x + q[4] * y + q[5]) / den;

        // ── Bilinear interpolation in the source image ──
        const x0 = Math.floor(sxf), y0 = Math.floor(syf);
        const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
        const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
        const fx = sxf - x0, fy = syf - y0;

        if (cx0 >= W || cy0 >= H || x1 < 0 || y1 < 0) continue;

        const i00 = (cy0 * W + cx0) * 4;
        const i10 = (cy0 * W + x1)  * 4;
        const i01 = (y1  * W + cx0) * 4;
        const i11 = (y1  * W + x1)  * 4;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx       * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx       * fy;

        let r  = data[i00]     * w00 + data[i10]     * w10 + data[i01]     * w01 + data[i11]     * w11;
        let g  = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
        let bl = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;

        // ── Apply filter ──
        if (activeFilter === 'gray' || activeFilter === 'bw') {
          let v = 0.299 * r + 0.587 * g + 0.114 * bl;
          if (activeFilter === 'bw') v = v > 158 ? 255 : Math.max(0, (v - 115) * 2.4);
          r = g = bl = v;
        } else if (activeFilter === 'magic') {
          r  = Math.min(255, (r  - 128) * 1.12 + 128 + 3);
          g  = Math.min(255, (g  - 128) * 1.12 + 128 + 3);
          bl = Math.min(255, (bl - 128) * 1.12 + 128 + 3);
        } else if (activeFilter === 'lighten') {
          r  = Math.min(255, r  * 1.14 + 10);
          g  = Math.min(255, g  * 1.14 + 10);
          bl = Math.min(255, bl * 1.14 + 10);
        } else if (activeFilter === 'sharpen') {
          r  = Math.min(255, Math.max(0, (r  - 128) * 1.15 + 128));
          g  = Math.min(255, Math.max(0, (g  - 128) * 1.15 + 128));
          bl = Math.min(255, Math.max(0, (bl - 128) * 1.15 + 128));
        }

        const di = (y * w + x) * 4;
        z[di]     = r;
        z[di + 1] = g;
        z[di + 2] = bl;
        z[di + 3] = 255;
      }
    }

    out.getContext('2d').putImageData(od, 0, 0);
    return out;
  }

  // ═══════════════════════════════════════════════
  //  SAVE SCAN
  // ═══════════════════════════════════════════════

  const saveScanBtn = $('#saveScan');
  const downloadImageBtn = $('#downloadImageBtn');
  const downloadPdfBtn = $('#downloadPdfBtn');
  const printScanBtn = $('#printScanBtn');

  if (downloadImageBtn) downloadImageBtn.onclick = () => exportCurrentScan('image');
  if (downloadPdfBtn) downloadPdfBtn.onclick = () => exportCurrentScan('pdf');
  if (printScanBtn) printScanBtn.onclick = () => exportCurrentScan('print');

  if (saveScanBtn) {
    saveScanBtn.onclick = () => {
      try {
        if (!image || !image.naturalWidth || !baseCanvas) {
          toast('Please select an image to scan first.');
          return;
        }

        const out = warpAndFilter();
        if (!out) {
          toast('The scan could not be generated. Please try again.');
          return;
        }

        const data = out.toDataURL('image/jpeg', 0.92);
        const name = $('#scanName').value.trim() || 'Untitled scan';

        const doc = {
          id:      Date.now(),
          name,
          created: new Date().toISOString(),
          data,
          filter:  activeFilter,
          starred: false,
          width:   out.width,
          height:  out.height,
        };

        docs.unshift(doc);
        persist();
        renderDocs();
        hideEditor();
        if (pendingFiles.length) {
          toast(`Scan saved · ${pendingFiles.length} page${pendingFiles.length === 1 ? '' : 's'} remaining`);
          processNextFile();
        } else toast('✓ Scan saved to your documents');
      } catch (error) {
        console.error('Save failed:', error);
        toast('Unable to save this scan. Please try again.');
      }
    };
  }

  // ═══════════════════════════════════════════════
  //  DOCUMENT GRID
  // ═══════════════════════════════════════════════

  function renderDocs() {
    const searchInput = $('#searchInput');
    const q = (searchInput ? searchInput.value : '').toLowerCase().trim();
    const items = docs.filter(d => {
      const match = d.name.toLowerCase().includes(q);
      if (currentView === 'starred') return match && d.starred;
      return match;
    });

    const docCount = $('#docCount');
    if (docCount) docCount.textContent = docs.length;
    if (grid) {
      grid.innerHTML = '';
      grid.classList.toggle('list-mode', listMode);
    }

    items.forEach(d => {
      const card = document.createElement('article');
      card.className = 'doc-card';

      // Thumbnail
      const thumb = document.createElement('div');
      thumb.className = 'doc-thumb';

      const badge = document.createElement('span');
      badge.className = 'doc-badge';
      badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 7h4M6 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

      const moreBtn = document.createElement('button');
      moreBtn.className = 'doc-more-btn';
      moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="13" cy="8" r="1.2" fill="currentColor"/></svg>';
      moreBtn.onclick = e => { e.stopPropagation(); showContextMenu(e, d); };

      const frame = document.createElement('div');
      frame.className = 'doc-preview-frame';
      const im = document.createElement('img');
      im.src = d.data;
      im.alt = d.name;
      im.loading = 'lazy';
      frame.appendChild(im);

      thumb.append(badge, frame, moreBtn);

      // Info
      const info = document.createElement('div');
      info.className = 'doc-info';

      const top = document.createElement('div');
      top.className = 'doc-info-top';
      const title = document.createElement('strong');
      title.textContent = d.name;
      const star = document.createElement('button');
      star.className = 'star-btn' + (d.starred ? ' on' : '');
      star.textContent = d.starred ? '★' : '☆';
      star.title = 'Star document';
      star.onclick = e => {
        e.stopPropagation();
        d.starred = !d.starred;
        persist();
        renderDocs();
      };
      top.append(title, star);

      const date = document.createElement('div');
      date.className = 'doc-date';
      date.textContent = `${new Date(d.created).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric'
      })} · ${Math.round(d.width / 10) / 100} × ${Math.round(d.height / 10) / 100} cm`;

      info.append(top, date);
      card.append(thumb, info);

      card.onclick = () => downloadDoc(d);
      grid.appendChild(card);
    });

    if (empty) empty.style.display = items.length ? 'none' : 'flex';
    const sectionTitle = $('#sectionTitle');
    const resultsMeta = $('#resultsMeta');
    if (sectionTitle) sectionTitle.textContent = currentView === 'starred' ? 'Starred documents' : 'Recent scans';
    if (resultsMeta) resultsMeta.textContent = q
      ? `${items.length} result${items.length === 1 ? '' : 's'}`
      : 'Your latest documents';
  }

  // ═══════════════════════════════════════════════
  //  CONTEXT MENU
  // ═══════════════════════════════════════════════

  function showContextMenu(e, doc) {
    contextDoc = doc;
    const menu = contextMenu;
    menu.classList.add('visible');
    const mw = 180, mh = 130;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
  }

  function hideContextMenu() {
    contextMenu.classList.remove('visible');
    contextDoc = null;
  }

  document.addEventListener('click', e => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('contextmenu', e => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });

  $$('#contextMenu button').forEach(btn => {
    btn.onclick = () => {
      if (!contextDoc) return;
      const action = btn.dataset.action;
      if (action === 'download') downloadDoc(contextDoc, 'image');
      else if (action === 'download-pdf') downloadDoc(contextDoc, 'pdf');
      else if (action === 'print') printDoc(contextDoc);
      else if (action === 'rename') {
        const newName = prompt('Rename document:', contextDoc.name);
        if (newName?.trim()) {
          contextDoc.name = newName.trim();
          persist();
          renderDocs();
          toast('Document renamed');
        }
      } else if (action === 'delete') {
        if (confirm(`Delete "${contextDoc.name}"?`)) {
          docs = docs.filter(d => d.id !== contextDoc.id);
          persist();
          renderDocs();
          toast('Document deleted');
        }
      }
      hideContextMenu();
    };
  });

  // ═══════════════════════════════════════════════
  //  DOWNLOAD
  // ═══════════════════════════════════════════════

  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function downloadDataUrl(dataUrl, fileName, mime = 'image/jpeg') {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openPrintableDocument(dataUrl, title) {
    const popup = window.open('', '_blank', 'width=900,height=700');
    if (!popup) {
      toast('Please allow pop-ups so the print dialog can open.');
      return null;
    }

    popup.document.write(`<!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          :root { color-scheme: light; }
          body {
            margin: 0;
            background: #eef3ff;
            font-family: Inter, Arial, sans-serif;
            display: grid;
            place-items: center;
            min-height: 100vh;
          }
          .sheet {
            background: #ffffff;
            max-width: 980px;
            width: min(92vw, 980px);
            min-height: calc(100vh - 48px);
            padding: 24px;
            box-sizing: border-box;
            box-shadow: 0 16px 38px rgba(35, 48, 90, 0.12);
          }
          img {
            display: block;
            width: 100%;
            height: auto;
            border-radius: 12px;
            background: #fff;
          }
          @media print {
            body { background: #fff; }
            .sheet {
              box-shadow: none;
              max-width: none;
              width: 100%;
              min-height: auto;
              padding: 0;
            }
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <img src="${dataUrl}" alt="${escapeHtml(title)}" />
        </div>
      </body>
      </html>`);
    popup.document.close();
    setTimeout(() => {
      try { popup.focus(); popup.print(); } catch { /* browser may block print in some contexts */ }
    }, 400);
    return popup;
  }

  function downloadDoc(d, format = 'image') {
    if (format === 'pdf') {
      openPrintableDocument(d.data, d.name);
      toast('Print dialog opened — choose Save as PDF');
      return;
    }
    const fileName = d.name.replace(/[<>:"/\\|?*]/g, '_') + '.jpg';
    downloadDataUrl(d.data, fileName, 'image/jpeg');
  }

  function printDoc(d) {
    openPrintableDocument(d.data, d.name);
    toast('Print dialog opened');
  }

  function exportCurrentScan(format = 'image') {
    if (!image || !image.naturalWidth || !baseCanvas) {
      toast('Please select an image to scan first.');
      return;
    }

    const out = warpAndFilter();
    if (!out) {
      toast('The scan could not be generated. Please try again.');
      return;
    }

    const data = out.toDataURL('image/jpeg', 0.92);
    const name = $('#scanName').value.trim() || 'Untitled scan';

    if (format === 'image') {
      downloadDataUrl(data, `${name.replace(/[<>:"/\\|?*]/g, '_')}.jpg`, 'image/jpeg');
      toast('Image downloaded');
      return;
    }

    if (format === 'pdf') {
      openPrintableDocument(data, name);
      toast('Print dialog opened — choose Save as PDF');
      return;
    }

    openPrintableDocument(data, name);
    toast('Print dialog opened');
  }

  // ═══════════════════════════════════════════════
  //  NAVIGATION / SEARCH / SORT
  // ═══════════════════════════════════════════════

  const searchInput = $('#searchInput');
  if (searchInput) searchInput.oninput = renderDocs;

  $$('.nav-item[data-view]').forEach(b => b.onclick = () => {
    $$('.nav-item[data-view]').forEach(x => x.classList.toggle('active', x === b));
    currentView = b.dataset.view;
    const pageTitle = $('#pageTitle');
    const crumb = $('#crumb');
    if (pageTitle) pageTitle.innerHTML = (
      currentView === 'starred' ? 'Starred' : 'All documents'
    ) + '<span class="accent-dot">.</span>';
    if (crumb) crumb.textContent = currentView === 'starred' ? 'Starred' : 'All documents';
    renderDocs();
    closeSidebar();
  });

  const gridViewBtn = $('#gridViewBtn');
  const listViewBtn = $('#listViewBtn');
  if (gridViewBtn) {
    gridViewBtn.onclick = () => {
      listMode = false;
      gridViewBtn.classList.add('selected');
      if (listViewBtn) listViewBtn.classList.remove('selected');
      renderDocs();
    };
  }
  if (listViewBtn) {
    listViewBtn.onclick = () => {
      listMode = true;
      listViewBtn.classList.add('selected');
      if (gridViewBtn) gridViewBtn.classList.remove('selected');
      renderDocs();
    };
  }

  const sortBtn = $('#sortBtn');
  if (sortBtn) sortBtn.onclick = () => {
    docs.reverse();
    persist();
    renderDocs();
  };

  const seeAll = $('#seeAll');
  if (seeAll) seeAll.onclick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    currentView = 'all';
    renderDocs();
  };

  // ═══════════════════════════════════════════════
  //  KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════

  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      showScan();
    }
    if (e.key === 'Escape') {
      hideContextMenu();
      hideScan();
      const wasEditing = editorModal.classList.contains('open');
      hideEditor();
      if (wasEditing) processNextFile();
    }
  });

  // ═══════════════════════════════════════════════
  //  DRAG & DROP
  // ═══════════════════════════════════════════════

  let dragDepth = 0;
  const uploadZone = $('#uploadZone');
  window.addEventListener('dragenter', e => {
    if (e.dataTransfer?.types.includes('Files')) {
      dragDepth++;
      document.body.classList.add('dragging');
      uploadZone?.classList.add('drag-active');
    }
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      document.body.classList.remove('dragging');
      uploadZone?.classList.remove('drag-active');
    }
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    uploadZone?.classList.remove('drag-active');
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) enqueueFiles(files);
  });

  // ═══════════════════════════════════════════════
  //  FOLDERS
  // ═══════════════════════════════════════════════

  const addFolderBtn = $('#addFolder');
  const folderList = $('#folderList');
  const folderColors = ['#6B8AFF', '#F59E6C', '#5EC9A0', '#E86B8A', '#A07CF0', '#4ABDE6'];
  if (addFolderBtn && folderList) {
    addFolderBtn.onclick = () => {
      const name = prompt('Name your folder:');
      if (!name?.trim()) return;
      const item = document.createElement('button');
      item.className = 'nav-item';
      const dot = document.createElement('span');
      dot.className = 'folder-dot';
      dot.style.background = folderColors[Math.floor(Math.random() * folderColors.length)];
      item.append(dot, document.createTextNode(' ' + name.trim()));
      folderList.append(item);
      toast('Folder created');
    };
  }

  // ─── Initial render ───
  renderDocs();
})();
