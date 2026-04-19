// Gravity Doodle — cellular automaton falling sand + freehand wall drawing

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;          // px per grid cell
  const EMPTY = 0;
  const WALL  = 1;
  const SAND  = 2;

  // Multiple palettes — each pour rotates to a new scheme so sculptures
  // accumulate bands of different colour families.
  const SAND_PALETTES = [
    // 0: warm amber / orange / red (original)
    ['#e8a030', '#e06020', '#d44010', '#f0c048', '#c83030', '#e87828', '#f0d060', '#b84020'],
    // 1: cool ocean — teal / blue / cyan
    ['#3ec7d0', '#2e8cc8', '#1d5aa8', '#6ee0d8', '#20b2aa', '#4aa0d8', '#b0e8e0', '#0d4b78'],
    // 2: forest — greens / olive / moss
    ['#7cb850', '#4a8028', '#2e5a18', '#b8d870', '#6a9838', '#a0c060', '#d8e890', '#345010'],
    // 3: neon candy — hot pink / magenta / purple
    ['#ff4da6', '#ff80c0', '#c830a0', '#ffb0dc', '#d850b8', '#9040b0', '#ff60d0', '#6820a0'],
    // 4: monochrome grayscale
    ['#f0f0f0', '#c8c8c8', '#989898', '#707070', '#505050', '#e0e0e0', '#b0b0b0', '#383838'],
    // 5: pastel rainbow
    ['#ffb0b0', '#ffd8a0', '#fff0a0', '#b0e8b0', '#b0d8ff', '#d8b0ff', '#ffc0e8', '#a0f0d8'],
    // 6: electric — lime / cyan / magenta
    ['#c8ff00', '#00ffd0', '#ff00c8', '#60ff40', '#30e8e8', '#f040ff', '#a0ff80', '#ff80ff'],
    // 7: earth — browns / tans / ochre
    ['#8c5a28', '#b07840', '#d89860', '#5a3818', '#a06838', '#c89068', '#e8b880', '#3c2410'],
  ];
  let paletteIndex = 0; // which palette is active for the current pour
  let SAND_COLORS = SAND_PALETTES[paletteIndex];

  // ── State ──────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let COLS, ROWS;
  let grid;        // Uint8Array of type codes
  let colors;      // array of color strings (for SAND cells)
  let mode = 'draw';
  let isPointerDown = false;
  let lastCell = null;
  let dropping = false;
  let dropFrame = 0;
  let animId = null;
  let hasDrawn = false;

  // Stroke recording for shareable URL.
  // strokes = list of strokes; each stroke = { m: 'd'|'e', pts: [[c,r],[c,r],...] }
  let strokes = [];
  let currentStroke = null;
  // Logical coordinate space (independent of viewport): we record at a fixed
  // virtual resolution so the drawing reproduces faithfully on any device.
  const VCOLS = 200;
  const VROWS = 267; // matches 3:4 aspect

  // ── Init ───────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');

    // Size canvas to its CSS display size
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Pointer events
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // If a sculpture is encoded in the URL, replay it; otherwise show prompt.
    const loaded = tryLoadFromHash();
    if (!loaded) {
      showOverlay('draw any shape here\nwith your finger or mouse\n\nthen tap DROP');
    }
    render();
  });

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    canvas.width  = w;
    canvas.height = h;
    COLS = Math.floor(w / CELL);
    ROWS = Math.floor(h / CELL);
    initGrid();
    // Replay strokes onto the new grid so resize/orientation doesn't wipe them.
    replayStrokes();
  }

  function initGrid() {
    grid   = new Uint8Array(COLS * ROWS);
    colors = new Array(COLS * ROWS).fill(null);
  }

  function idx(c, r) { return r * COLS + c; }

  // ── Overlay ────────────────────────────────────────────────────────────────
  function showOverlay(msg) {
    const el = document.getElementById('overlay-msg');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideOverlay() {
    document.getElementById('overlay-msg').classList.add('hidden');
  }

  // ── Phase / UI ─────────────────────────────────────────────────────────────
  function setPhase(phase) {
    const drawC = document.getElementById('draw-controls');
    const physC = document.getElementById('physics-controls');
    if (phase === 'physics') {
      drawC.classList.add('hidden');
      physC.classList.remove('hidden');
    } else {
      drawC.classList.remove('hidden');
      physC.classList.add('hidden');
      const status = document.getElementById('share-status');
      if (status) status.textContent = '';
    }
  }

  // ── Mode ───────────────────────────────────────────────────────────────────
  window.setMode = function (m) {
    mode = m;
    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.remove('active');
      if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
    });
    // Activate BOTH the draw-phase and physics-phase tool button for this mode,
    // so the toggle stays in sync across phases.
    const ids = ['btn-' + m, 'btn-' + m + '-phys'];
    ids.forEach(id => {
      const activeBtn = document.getElementById(id);
      if (activeBtn) {
        activeBtn.classList.add('active');
        if (activeBtn.hasAttribute('aria-pressed')) activeBtn.setAttribute('aria-pressed', 'true');
      }
    });
  };

  window.clearAll = function () {
    cancelAnimationFrame(animId);
    dropping = false;
    dropFrame = 0;
    hasDrawn = false;
    strokes = [];
    currentStroke = null;
    // Drop the URL hash so a reset is a clean slate.
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    initGrid();
    setPhase('draw');
    setMode('draw');
    showOverlay('draw any shape here\nwith your finger or mouse\n\nthen tap DROP');
    render();
  };

  // ── Drawing ────────────────────────────────────────────────────────────────
  function canvasCell(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
    return { c, r };
  }

  // Convert grid cell <-> virtual coordinate so strokes survive resize/share.
  function gridToVirtual(c, r) {
    return [
      Math.round((c / Math.max(1, COLS - 1)) * (VCOLS - 1)),
      Math.round((r / Math.max(1, ROWS - 1)) * (VROWS - 1)),
    ];
  }
  function virtualToGrid(vc, vr) {
    return {
      c: Math.round((vc / (VCOLS - 1)) * (COLS - 1)),
      r: Math.round((vr / (VROWS - 1)) * (ROWS - 1)),
    };
  }

  function paintAt(c, r, brushR, m) {
    const useMode = m || mode;
    for (let dc = -brushR; dc <= brushR; dc++) {
      for (let dr = -brushR; dr <= brushR; dr++) {
        if (dc * dc + dr * dr > brushR * brushR) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const i = idx(nc, nr);
        if (useMode === 'draw') {
          // Pen always converts the cell to WALL — including cells that
          // currently hold SAND. Previously we skipped SAND cells to avoid
          // "deleting" mid-flight particles, but that made it impossible to
          // close a hole while sand was actively streaming through it (the
          // stream itself occupied the cells you were trying to paint).
          // Replacing the sand with wall is the intuitive behaviour: the
          // pen does what it looks like it should do.
          grid[i]   = WALL;
          colors[i] = null;
        } else if (useMode === 'erase') {
          grid[i]   = EMPTY;
          colors[i] = null;
        }
      }
    }
  }

  function paintLine(c0, r0, c1, r1, brushR, m) {
    // Bresenham
    let dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
    let dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    let c = c0, r = r0;
    while (true) {
      paintAt(c, r, brushR, m);
      if (c === c1 && r === r1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; c += sx; }
      if (e2 <= dx) { err += dx; r += sy; }
    }
  }

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    const cell = canvasCell(e);
    lastCell = cell;

    // Only record strokes for sharing during the draw phase — mid-physics
    // edits are ephemeral and shouldn't be encoded into the share URL.
    if (!dropping) {
      currentStroke = { m: mode === 'erase' ? 'e' : 'd', pts: [gridToVirtual(cell.c, cell.r)] };
    }

    paintAt(cell.c, cell.r, 2);
    hasDrawn = true;
    hideOverlay();
    if (!dropping) render();
    // While dropping, the animation loop re-renders every frame — no need here.
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) {
      paintLine(lastCell.c, lastCell.r, cell.c, cell.r, 2);
    }
    if (currentStroke) {
      // Push the new point in virtual coords; dedupe consecutive duplicates.
      const v = gridToVirtual(cell.c, cell.r);
      const last = currentStroke.pts[currentStroke.pts.length - 1];
      if (!last || last[0] !== v[0] || last[1] !== v[1]) {
        currentStroke.pts.push(v);
      }
    }
    lastCell = cell;
    if (!dropping) render();
  }

  function onPointerUp(e) {
    isPointerDown = false;
    lastCell = null;
    if (currentStroke && currentStroke.pts.length > 0) {
      strokes.push(currentStroke);
    }
    currentStroke = null;
  }

  // Replay all strokes onto the current grid (used after resize / load-from-hash)
  function replayStrokes() {
    if (!strokes.length) return;
    for (const s of strokes) {
      const m = s.m === 'e' ? 'erase' : 'draw';
      let prev = null;
      for (const p of s.pts) {
        const g = virtualToGrid(p[0], p[1]);
        if (prev) {
          paintLine(prev.c, prev.r, g.c, g.r, 2, m);
        } else {
          paintAt(g.c, g.r, 2, m);
        }
        prev = g;
      }
    }
    hasDrawn = true;
    hideOverlay();
  }

  // ── Drop ───────────────────────────────────────────────────────────────────
  window.startDrop = function () {
    if (!hasDrawn) {
      showOverlay('draw something first —\neven a squiggle counts');
      return;
    }
    if (dropping) {
      // Already pouring: trigger another wave from the top with a NEW palette.
      refillSand();
      return;
    }

    dropping = true;
    dropFrame = 0;
    setPhase('physics');

    // First pour uses a random palette so each session feels fresh.
    rotatePalette(true);

    // Show loading micro-copy briefly
    showOverlay('watching gravity\ndo its thing...');
    setTimeout(hideOverlay, 900);

    loop();
  };

  // Reset the spawn clock so another wave of sand pours from the top.
  // Each re-pour shifts to a new palette so bands stack up in different hues.
  function refillSand() {
    dropFrame = 0;
    rotatePalette(false);
  }

  // Swap to a new palette. On first call we pick randomly; subsequent calls
  // pick any palette other than the current one so colour actually changes.
  function rotatePalette(firstPour) {
    if (firstPour) {
      paletteIndex = Math.floor(Math.random() * SAND_PALETTES.length);
    } else {
      let next = paletteIndex;
      while (next === paletteIndex && SAND_PALETTES.length > 1) {
        next = Math.floor(Math.random() * SAND_PALETTES.length);
      }
      paletteIndex = next;
    }
    SAND_COLORS = SAND_PALETTES[paletteIndex];
    // Reset the streak offset so the new palette starts from its first band.
    paletteOffset = 0;
  }

  // ── Sand Simulation ────────────────────────────────────────────────────────
  // More particles, spawned from a wider band along the top, for a richer "pour".
  const SPAWN_RATE = 18;       // new sand particles per frame
  const SPAWN_FRAMES = 300;    // ~5 s at 60 fps
  // Color "streaks": the current palette shifts slowly so the pile has bands
  // of colour instead of uniform static — keeps it visually interesting.
  let paletteOffset = 0;

  function spawnSand() {
    if (dropFrame > SPAWN_FRAMES) return;
    // Every ~30 frames, rotate the palette so the streaks shift warm→red→gold.
    if (dropFrame % 30 === 0) {
      paletteOffset = (paletteOffset + 1) % SAND_COLORS.length;
    }
    for (let s = 0; s < SPAWN_RATE; s++) {
      const c = Math.floor(Math.random() * COLS);
      // Spawn across the top 2 rows for a fuller curtain.
      const r = Math.random() < 0.5 ? 0 : 1;
      const i = idx(c, r);
      if (grid[i] === EMPTY) {
        grid[i] = SAND;
        // 70% draw from a shifted 3-color window (streaks), 30% any color
        // (sparkles), so the pour stays varied but cohesive.
        if (Math.random() < 0.7) {
          const k = (paletteOffset + Math.floor(Math.random() * 3)) % SAND_COLORS.length;
          colors[i] = SAND_COLORS[k];
        } else {
          colors[i] = SAND_COLORS[Math.floor(Math.random() * SAND_COLORS.length)];
        }
      }
    }
  }

  function stepSand() {
    // Iterate bottom-to-top so falling doesn't cascade in same frame.
    // Bottom row is "open sky": any sand that lands there falls off-screen.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, ROWS - 1);
      if (grid[i] === SAND) {
        grid[i] = EMPTY;
        colors[i] = null;
      }
    }

    for (let r = ROWS - 2; r >= 0; r--) {
      // Randomize column order to avoid directional bias
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (grid[i] !== SAND) continue;

        // Try to fall straight down
        if (r + 1 < ROWS && grid[idx(c, r + 1)] === EMPTY) {
          move(c, r, c, r + 1);
          continue;
        }

        // Try diagonally (randomise L/R)
        const goLeft = Math.random() < 0.5;
        const d1 = goLeft ? -1 : 1;
        const d2 = -d1;

        if (tryDiag(c, r, d1)) continue;
        if (tryDiag(c, r, d2)) continue;
      }
    }
  }

  function tryDiag(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    if (grid[idx(nc, r + 1)] === EMPTY) {
      move(c, r, nc, r + 1);
      return true;
    }
    return false;
  }

  function move(c0, r0, c1, r1) {
    const from = idx(c0, r0);
    const to   = idx(c1, r1);
    grid[to]   = SAND;
    colors[to] = colors[from];
    grid[from]   = EMPTY;
    colors[from] = null;
  }

  // Reuse a shuffled column order per frame (Fisher-Yates)
  let _colArr = null;
  function shuffledCols() {
    if (!_colArr || _colArr.length !== COLS) {
      _colArr = Array.from({ length: COLS }, (_, i) => i);
    }
    for (let i = COLS - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_colArr[i], _colArr[j]] = [_colArr[j], _colArr[i]];
    }
    return _colArr;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    ctx.fillStyle = '#0f0e0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(c, r);
        const t = grid[i];
        if (t === EMPTY) continue;

        if (t === WALL) {
          ctx.fillStyle = '#d8c8a0';
        } else if (t === SAND) {
          ctx.fillStyle = colors[i] || '#e8a030';
        }

        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  // ── Animation Loop ─────────────────────────────────────────────────────────
  function loop() {
    spawnSand();
    stepSand();
    render();
    dropFrame++;
    animId = requestAnimationFrame(loop);
  }

  // ── Share via URL fragment ─────────────────────────────────────────────────
  // Encoding: we serialise strokes as a compact byte stream, then base64url it
  // into the URL fragment. URL fragment lengths in modern browsers are
  // effectively bounded by browser practical limits (~64KB+ in Chrome/FF/Safari);
  // we additionally cap our payload at ~6KB-ish via point decimation.
  //
  // Stream format (varint-coded for compactness):
  //   uint8  version (1)
  //   uint8  mode-mask reserved
  //   for each stroke:
  //     uint8 mode (0=draw, 1=erase)
  //     uvar  numPoints
  //     uvar  x0, y0   (absolute, 0..VCOLS-1 / 0..VROWS-1)
  //     for each subsequent point:
  //       svar dx, svar dy   (signed deltas, zig-zag encoded)
  //   trailing 0xFF terminator
  //
  // varint = base-128 little-endian, high bit = continuation.

  function uvarPush(arr, n) {
    n = n >>> 0;
    while (n >= 0x80) {
      arr.push((n & 0x7f) | 0x80);
      n = n >>> 7;
    }
    arr.push(n & 0x7f);
  }
  function svarPush(arr, n) {
    // zig-zag
    const z = (n << 1) ^ (n >> 31);
    uvarPush(arr, z >>> 0);
  }
  function uvarRead(view, posRef) {
    let result = 0, shift = 0, b;
    do {
      b = view[posRef.p++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  }
  function svarRead(view, posRef) {
    const z = uvarRead(view, posRef);
    return (z >>> 1) ^ -(z & 1);
  }

  function decimateStrokes(src, maxPts) {
    // Drop in-between points until the total is under maxPts.
    // Always keep first and last point of each stroke.
    let total = src.reduce((n, s) => n + s.pts.length, 0);
    if (total <= maxPts) return src;
    const ratio = total / maxPts;
    const step = Math.max(2, Math.ceil(ratio));
    const out = [];
    for (const s of src) {
      if (s.pts.length <= 2) { out.push({ m: s.m, pts: s.pts.slice() }); continue; }
      const kept = [s.pts[0]];
      for (let i = 1; i < s.pts.length - 1; i++) {
        if (i % step === 0) kept.push(s.pts[i]);
      }
      kept.push(s.pts[s.pts.length - 1]);
      out.push({ m: s.m, pts: kept });
    }
    return out;
  }

  function encodeStrokes(src) {
    const data = decimateStrokes(src, 1500);
    const bytes = [];
    bytes.push(1); // version
    bytes.push(0); // reserved
    for (const s of data) {
      bytes.push(s.m === 'e' ? 1 : 0);
      uvarPush(bytes, s.pts.length);
      const p0 = s.pts[0];
      uvarPush(bytes, p0[0]);
      uvarPush(bytes, p0[1]);
      let px = p0[0], py = p0[1];
      for (let i = 1; i < s.pts.length; i++) {
        const p = s.pts[i];
        svarPush(bytes, p[0] - px);
        svarPush(bytes, p[1] - py);
        px = p[0]; py = p[1];
      }
    }
    bytes.push(0xff);

    // base64url
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin)
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64;
  }

  function decodeStrokes(b64) {
    try {
      const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
      const bin = atob(norm + pad);
      const view = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      const pos = { p: 0 };
      const version = view[pos.p++];
      if (version !== 1) return null;
      pos.p++; // reserved
      const out = [];
      while (pos.p < view.length && view[pos.p] !== 0xff) {
        const m = view[pos.p++] === 1 ? 'e' : 'd';
        const n = uvarRead(view, pos);
        if (!n) continue;
        const x0 = uvarRead(view, pos);
        const y0 = uvarRead(view, pos);
        const pts = [[x0, y0]];
        let px = x0, py = y0;
        for (let i = 1; i < n; i++) {
          const dx = svarRead(view, pos);
          const dy = svarRead(view, pos);
          px += dx; py += dy;
          pts.push([px, py]);
        }
        out.push({ m, pts });
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function tryLoadFromHash() {
    const h = location.hash;
    if (!h || h.length < 2) return false;
    const m = h.match(/^#s=(.+)$/);
    if (!m) return false;
    const decoded = decodeStrokes(m[1]);
    if (!decoded || !decoded.length) return false;
    strokes = decoded;
    initGrid();
    replayStrokes();
    return true;
  }

  // ── Share ─────────────────────────────────────────────────────────────────
  window.shareSculpture = function () {
    if (!strokes.length) return;
    const encoded = encodeStrokes(strokes);
    const url = location.origin + location.pathname + '#s=' + encoded;
    const status = document.getElementById('share-status');

    // Update the address bar so the URL bar itself is shareable too.
    history.replaceState(null, '', '#s=' + encoded);

    if (navigator.share) {
      navigator.share({
        title: 'gravity doodle',
        text: 'I made a sand sculpture — try it / remix it:',
        url: url,
      }).then(
        () => { if (status) status.textContent = 'shared!'; },
        () => copyToClipboard(url, status)
      );
    } else {
      copyToClipboard(url, status);
    }
  };

  function copyToClipboard(text, statusEl) {
    const setMsg = (m) => { if (statusEl) statusEl.textContent = m; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setMsg('link copied — paste anywhere'),
        () => setMsg('copy failed — link is in the address bar')
      );
    } else {
      // Legacy fallback
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setMsg('link copied — paste anywhere');
      } catch (e) {
        setMsg('link is in the address bar');
      }
    }
  }
})();
