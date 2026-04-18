// Gravity Doodle — cellular automaton falling sand + freehand wall drawing

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;          // px per grid cell
  const EMPTY = 0;
  const WALL  = 1;
  const SAND  = 2;

  // Warm palette: each sand particle picks one of these on spawn
  const SAND_COLORS = [
    '#e8a030', // amber
    '#e06020', // burnt orange
    '#d44010', // terracotta
    '#f0c048', // gold
    '#c83030', // deep red
    '#e87828', // coral-orange
    '#f0d060', // pale gold
    '#b84020', // brick
  ];

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
  let settleTimer = null;

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

    showOverlay('draw any shape here\nwith your finger or mouse\n\nthen tap DROP');
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

  // ── Mode ───────────────────────────────────────────────────────────────────
  window.setMode = function (m) {
    mode = m;
    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.remove('active');
      if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
    });
    // 'pen' button id is btn-draw (mode is 'draw'); erase maps directly.
    const activeBtn = document.getElementById('btn-' + m);
    if (activeBtn) {
      activeBtn.classList.add('active');
      if (activeBtn.hasAttribute('aria-pressed')) activeBtn.setAttribute('aria-pressed', 'true');
    }
  };

  window.clearAll = function () {
    cancelAnimationFrame(animId);
    dropping = false;
    dropFrame = 0;
    hasDrawn = false;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    document.getElementById('share').style.display = 'none';
    const dropBtn = document.getElementById('btn-drop');
    dropBtn.disabled = false;
    dropBtn.textContent = 'drop the sand';
    initGrid();
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

  function paintAt(c, r, brushR) {
    for (let dc = -brushR; dc <= brushR; dc++) {
      for (let dr = -brushR; dr <= brushR; dr++) {
        if (dc * dc + dr * dr > brushR * brushR) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const i = idx(nc, nr);
        if (mode === 'draw') {
          grid[i]   = WALL;
          colors[i] = null;
        } else if (mode === 'erase') {
          grid[i]   = EMPTY;
          colors[i] = null;
        }
      }
    }
  }

  function paintLine(c0, r0, c1, r1, brushR) {
    // Bresenham
    let dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
    let dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    let c = c0, r = r0;
    while (true) {
      paintAt(c, r, brushR);
      if (c === c1 && r === r1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; c += sx; }
      if (e2 <= dx) { err += dx; r += sy; }
    }
  }

  function onPointerDown(e) {
    if (dropping) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    const cell = canvasCell(e);
    lastCell = cell;
    paintAt(cell.c, cell.r, 2);
    hasDrawn = true;
    hideOverlay();
    render();
  }

  function onPointerMove(e) {
    if (!isPointerDown || dropping) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) {
      paintLine(lastCell.c, lastCell.r, cell.c, cell.r, 2);
    }
    lastCell = cell;
    render();
  }

  function onPointerUp(e) {
    isPointerDown = false;
    lastCell = null;
  }

  // ── Drop ───────────────────────────────────────────────────────────────────
  window.startDrop = function () {
    if (!hasDrawn) {
      showOverlay('draw something first —\neven a squiggle counts');
      return;
    }
    if (dropping) {
      // Already pouring: let the user trigger a refill so they can keep going.
      refillSand();
      return;
    }

    dropping = true;
    dropFrame = 0;
    document.getElementById('btn-drop').disabled = false;
    document.getElementById('btn-drop').textContent = 'pour more';

    // Show loading micro-copy briefly
    showOverlay('watching gravity\ndo its thing...');
    setTimeout(hideOverlay, 900);

    loop();

    // Show share panel after the sand has had time to settle.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      document.getElementById('share').style.display = 'flex';
    }, 6500);
  };

  // Reset the spawn clock so another wave of sand pours from the top.
  function refillSand() {
    dropFrame = 0;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      document.getElementById('share').style.display = 'flex';
    }, 6500);
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
    // Iterate bottom-to-top so falling doesn't cascade in same frame
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

  // ── Save ───────────────────────────────────────────────────────────────────
  window.saveSculpture = function () {
    const link = document.createElement('a');
    link.download = 'gravity-doodle.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  // share() is also exposed for URL sharing
  window.share = function () {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href });
    } else {
      navigator.clipboard.writeText(location.href)
        .then(() => alert('Link copied!'));
    }
  };
})();
