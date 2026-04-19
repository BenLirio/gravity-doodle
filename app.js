// Gravity Doodle — multi-material falling-sand sandbox
//
// Materials have different physical properties. Paint with any of them on the
// canvas, then press "pour" to rain more of the selected material from the top.
// Interactions happen naturally as the simulation runs:
//   - sand falls and piles
//   - water falls and spreads sideways (fluid)
//   - oil behaves like water but is lighter than water (floats)
//   - fire rises, ignites plant/oil, is extinguished by water, dies out
//   - plant is static but sprouts into adjacent water
//   - wall never moves

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;          // px per grid cell

  // Cell types (also used as material codes for the painter).
  const EMPTY = 0;
  const WALL  = 1;
  const SAND  = 2;
  const WATER = 3;
  const OIL   = 4;
  const FIRE  = 5;
  const PLANT = 6;

  // Ordered list used for the share encoding (index = on-wire byte).
  const MATERIAL_LIST = ['erase', 'wall', 'sand', 'water', 'oil', 'fire', 'plant'];
  const MATERIAL_CODE = { erase: 0, wall: 1, sand: 2, water: 3, oil: 4, fire: 5, plant: 6 };
  const MATERIAL_TYPE = { wall: WALL, sand: SAND, water: WATER, oil: OIL, fire: FIRE, plant: PLANT, erase: EMPTY };

  // Sand palettes — each pour rotates, so sculptures accumulate bands.
  const SAND_PALETTES = [
    ['#e8a030', '#e06020', '#d44010', '#f0c048', '#c83030', '#e87828', '#f0d060', '#b84020'],
    ['#3ec7d0', '#2e8cc8', '#1d5aa8', '#6ee0d8', '#20b2aa', '#4aa0d8', '#b0e8e0', '#0d4b78'],
    ['#7cb850', '#4a8028', '#2e5a18', '#b8d870', '#6a9838', '#a0c060', '#d8e890', '#345010'],
    ['#ff4da6', '#ff80c0', '#c830a0', '#ffb0dc', '#d850b8', '#9040b0', '#ff60d0', '#6820a0'],
    ['#f0f0f0', '#c8c8c8', '#989898', '#707070', '#505050', '#e0e0e0', '#b0b0b0', '#383838'],
    ['#ffb0b0', '#ffd8a0', '#fff0a0', '#b0e8b0', '#b0d8ff', '#d8b0ff', '#ffc0e8', '#a0f0d8'],
    ['#c8ff00', '#00ffd0', '#ff00c8', '#60ff40', '#30e8e8', '#f040ff', '#a0ff80', '#ff80ff'],
    ['#8c5a28', '#b07840', '#d89860', '#5a3818', '#a06838', '#c89068', '#e8b880', '#3c2410'],
  ];
  let paletteIndex = 0;
  let SAND_COLORS = SAND_PALETTES[paletteIndex];

  // Fixed colour ranges for non-sand materials (we still randomize within range
  // so the result doesn't feel like flat paint).
  const WATER_COLORS = ['#4aa8d8', '#3e9ac8', '#62b8e0', '#2e84b8', '#6cc0e8'];
  const OIL_COLORS   = ['#3a2e20', '#4a3a28', '#2a2218', '#5a4830', '#3e3020'];
  const FIRE_COLORS  = ['#ff6020', '#ff8840', '#ffb060', '#ff4010', '#ffd080', '#ff3008'];
  const PLANT_COLORS = ['#4a9028', '#6ab040', '#5ca038', '#3a7818', '#7ac050', '#2e5a10'];

  const WALL_COLOR = '#d8c8a0';

  // ── State ──────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let COLS, ROWS;
  let grid;        // Uint8Array of type codes
  let colors;      // color strings (per cell)
  let life;        // Uint8Array auxiliary lifetime (fire)
  let flags;       // Uint8Array per-cell flags (bit0 = moved this tick)

  let material = 'wall';   // currently selected material
  let isPointerDown = false;
  let lastCell = null;
  let dropping = false;
  let dropFrame = 0;
  let animId = null;
  let hasDrawn = false;

  // Stroke recording for shareable URL.
  // strokes = list of strokes; each stroke = { t: typeCode, pts: [[vc,vr],...] }
  let strokes = [];
  let currentStroke = null;
  const VCOLS = 200;
  const VROWS = 267; // matches 3:4 aspect

  // ── Init ───────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');

    pickSessionSandPalette();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // Materials need a live simulation even before "pour" is pressed — water
    // you paint should flow, fire you paint should rise. We run a lightweight
    // sim loop constantly; spawning from the top only happens after pour.
    animId = requestAnimationFrame(loop);

    const loaded = tryLoadFromHash();
    if (!loaded) {
      showOverlay('paint materials here\nwith your finger or mouse\n\ntry walls + water + fire');
    }
    render();
    syncPourButtonLabel();
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
    replayStrokes();
  }

  function initGrid() {
    grid   = new Uint8Array(COLS * ROWS);
    colors = new Array(COLS * ROWS).fill(null);
    life   = new Uint8Array(COLS * ROWS);
    flags  = new Uint8Array(COLS * ROWS);
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

  // ── Material selection ─────────────────────────────────────────────────────
  window.setMaterial = function (m) {
    material = m;
    document.querySelectorAll('.tool-btn').forEach(b => {
      const btnMat = b.getAttribute('data-material');
      if (!btnMat) return; // ignore non-material buttons (clear, etc.)
      const active = btnMat === m;
      b.classList.toggle('active', active);
      if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncPourButtonLabel();
  };

  // Static materials (wall, plant) and erase can't be poured — fall back to
  // sand so the pour button always does something sensible.
  const POURABLE = { sand: true, water: true, oil: true, fire: true };
  function pourMaterialFor(m) {
    return POURABLE[m] ? m : 'sand';
  }

  function syncPourButtonLabel() {
    const drop = document.getElementById('btn-drop');
    const pour = document.getElementById('btn-pour');
    const label = 'pour ' + pourMaterialFor(material);
    if (drop) drop.textContent = label;
    if (pour) pour.textContent = label;
  }

  window.clearAll = function () {
    dropping = false;
    dropFrame = 0;
    hasDrawn = false;
    strokes = [];
    currentStroke = null;
    pours = [];
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    initGrid();
    pickSessionSandPalette();
    setPhase('draw');
    setMaterial('wall');
    showOverlay('paint materials here\nwith your finger or mouse\n\ntry walls + water + fire');
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

  function colorFor(type) {
    switch (type) {
      case WALL:  return WALL_COLOR;
      case SAND:  return SAND_COLORS[Math.floor(Math.random() * SAND_COLORS.length)];
      case WATER: return WATER_COLORS[Math.floor(Math.random() * WATER_COLORS.length)];
      case OIL:   return OIL_COLORS[Math.floor(Math.random() * OIL_COLORS.length)];
      case FIRE:  return FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)];
      case PLANT: return PLANT_COLORS[Math.floor(Math.random() * PLANT_COLORS.length)];
      default:    return null;
    }
  }

  function paintAt(c, r, brushR, mat) {
    const m = mat || material;
    const type = MATERIAL_TYPE[m];
    for (let dc = -brushR; dc <= brushR; dc++) {
      for (let dr = -brushR; dr <= brushR; dr++) {
        if (dc * dc + dr * dr > brushR * brushR) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const i = idx(nc, nr);
        if (m === 'erase') {
          grid[i]   = EMPTY;
          colors[i] = null;
          life[i]   = 0;
        } else if (m === 'wall' || m === 'plant') {
          // Static materials overwrite anything.
          grid[i]   = type;
          colors[i] = colorFor(type);
          life[i]   = 0;
        } else {
          // Dynamic materials: only paint into empty cells so you don't
          // wipe out other materials by accident.
          if (grid[i] === EMPTY || grid[i] === type) {
            grid[i]   = type;
            colors[i] = colorFor(type);
            life[i]   = (type === FIRE) ? 60 + Math.floor(Math.random() * 40) : 0;
          }
        }
      }
    }
  }

  function paintLine(c0, r0, c1, r1, brushR, mat) {
    let dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
    let dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    let c = c0, r = r0;
    while (true) {
      paintAt(c, r, brushR, mat);
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

    if (!dropping) {
      currentStroke = { t: MATERIAL_CODE[material], pts: [gridToVirtual(cell.c, cell.r)] };
    }

    paintAt(cell.c, cell.r, 2);
    hasDrawn = true;
    hideOverlay();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) {
      paintLine(lastCell.c, lastCell.r, cell.c, cell.r, 2);
    }
    if (currentStroke) {
      const v = gridToVirtual(cell.c, cell.r);
      const last = currentStroke.pts[currentStroke.pts.length - 1];
      if (!last || last[0] !== v[0] || last[1] !== v[1]) {
        currentStroke.pts.push(v);
      }
    }
    lastCell = cell;
  }

  function onPointerUp() {
    isPointerDown = false;
    lastCell = null;
    if (currentStroke && currentStroke.pts.length > 0) {
      strokes.push(currentStroke);
    }
    currentStroke = null;
  }

  function replayStrokes() {
    if (!strokes.length) return;
    for (const s of strokes) {
      const mat = MATERIAL_LIST[s.t] || 'wall';
      let prev = null;
      for (const p of s.pts) {
        const g = virtualToGrid(p[0], p[1]);
        if (prev) paintLine(prev.c, prev.r, g.c, g.r, 2, mat);
        else      paintAt(g.c, g.r, 2, mat);
        prev = g;
      }
    }
    hasDrawn = true;
    hideOverlay();
  }

  // ── Pour ───────────────────────────────────────────────────────────────────
  window.startDrop = function () {
    // Pour the currently selected material. Static materials (wall, plant) and
    // erase can't be poured meaningfully — fall back to sand so the action is
    // always sensible.
    const mat = pourMaterialFor(material);

    if (!dropping) {
      dropping = true;
      setPhase('physics');
      showOverlay('watching gravity\ndo its thing...');
      setTimeout(hideOverlay, 900);
    }

    beginPour(mat);
  };

  // Active pours: each is a top-of-screen curtain of a given material with a
  // frame countdown. Multiple can run concurrently if the user presses pour
  // with different materials.
  let pours = []; // { mat: 'sand'|..., type: SAND|..., frames: 0, total: 300 }

  function beginPour(mat) {
    pours.push({
      mat: mat,
      type: MATERIAL_TYPE[mat],
      frames: 0,
      total: 300, // ~5s @ 60fps
    });
  }

  // Pick a single sand palette per session so pours stay color-consistent.
  // Called once at startup and again on clearAll. We deliberately do NOT
  // rotate between pours — users found the rotating colours confusing.
  function pickSessionSandPalette() {
    paletteIndex = Math.floor(Math.random() * SAND_PALETTES.length);
    SAND_COLORS = SAND_PALETTES[paletteIndex];
    paletteOffset = 0;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  const SPAWN_RATE = 18;
  let paletteOffset = 0;

  function spawnFromPours() {
    if (!pours.length) return;
    const next = [];
    for (const p of pours) {
      if (p.frames > p.total) continue;
      if (p.mat === 'sand' && p.frames % 30 === 0) {
        paletteOffset = (paletteOffset + 1) % SAND_COLORS.length;
      }
      for (let s = 0; s < SPAWN_RATE; s++) {
        const c = Math.floor(Math.random() * COLS);
        // Fire rises, so spawn fire at the bottom; everything else at the top.
        const r = (p.type === FIRE)
          ? ((Math.random() < 0.5 ? ROWS - 1 : ROWS - 2))
          : ((Math.random() < 0.5 ? 0 : 1));
        const i = idx(c, r);
        if (grid[i] !== EMPTY) continue;
        grid[i] = p.type;
        if (p.type === SAND) {
          // Streaks like before
          if (Math.random() < 0.7) {
            const k = (paletteOffset + Math.floor(Math.random() * 3)) % SAND_COLORS.length;
            colors[i] = SAND_COLORS[k];
          } else {
            colors[i] = SAND_COLORS[Math.floor(Math.random() * SAND_COLORS.length)];
          }
        } else {
          colors[i] = colorFor(p.type);
        }
        if (p.type === FIRE) life[i] = 60 + Math.floor(Math.random() * 40);
      }
      p.frames++;
      next.push(p);
    }
    pours = next;
  }

  function clearFlags() {
    flags.fill(0);
  }

  function step() {
    clearFlags();

    // Bottom row open sky for falling particles (sand/water/oil): they fall off.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, ROWS - 1);
      const t = grid[i];
      if (t === SAND || t === WATER || t === OIL) {
        grid[i] = EMPTY;
        colors[i] = null;
      }
    }
    // Top row is "sky" for fire — it escapes upward and disappears.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, 0);
      if (grid[i] === FIRE) {
        grid[i] = EMPTY;
        colors[i] = null;
        life[i] = 0;
      }
    }

    // Pass 1: fire rises + interactions (top to bottom).
    for (let r = 0; r < ROWS; r++) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (grid[i] !== FIRE) continue;
        if (flags[i] & 1) continue;

        // Decay
        if (life[i] > 0) life[i]--;
        if (life[i] === 0) {
          grid[i] = EMPTY;
          colors[i] = null;
          continue;
        }

        // Ignite neighbours + get extinguished by water.
        let extinguished = false;
        for (let dc = -1; dc <= 1; dc++) {
          for (let dr = -1; dr <= 1; dr++) {
            if (dc === 0 && dr === 0) continue;
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
            const ni = idx(nc, nr);
            const nt = grid[ni];
            if (nt === WATER) {
              // Water next to fire: fire dies, water stays.
              extinguished = true;
            } else if (nt === OIL || nt === PLANT) {
              // Small chance per frame to ignite.
              if (Math.random() < 0.08) {
                grid[ni]   = FIRE;
                colors[ni] = colorFor(FIRE);
                life[ni]   = 50 + Math.floor(Math.random() * 40);
                flags[ni] |= 1;
              }
            }
          }
        }
        if (extinguished) {
          grid[i] = EMPTY;
          colors[i] = null;
          life[i]  = 0;
          continue;
        }

        // Try to rise.
        if (r - 1 >= 0) {
          const up = idx(c, r - 1);
          if (grid[up] === EMPTY) { swap(i, up); flags[up] |= 1; continue; }
        }
        // Diagonal up-left / up-right
        const goLeft = Math.random() < 0.5;
        const d1 = goLeft ? -1 : 1, d2 = -d1;
        if (tryFireDiag(c, r, d1) || tryFireDiag(c, r, d2)) continue;
      }
    }

    // Pass 2: plant growth (random sample so it's slow/organic).
    {
      const attempts = Math.floor(COLS * ROWS * 0.0006);
      for (let k = 0; k < attempts; k++) {
        const c = Math.floor(Math.random() * COLS);
        const r = Math.floor(Math.random() * ROWS);
        const i = idx(c, r);
        if (grid[i] !== PLANT) continue;
        // Grow into one adjacent WATER cell.
        const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        for (let s = dirs.length - 1; s > 0; s--) {
          const j = Math.floor(Math.random() * (s + 1));
          [dirs[s], dirs[j]] = [dirs[j], dirs[s]];
        }
        for (const [dc, dr] of dirs) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const ni = idx(nc, nr);
          if (grid[ni] === WATER) {
            grid[ni]   = PLANT;
            colors[ni] = colorFor(PLANT);
            break;
          }
        }
      }
    }

    // Pass 3: falling + liquid passes (bottom to top).
    for (let r = ROWS - 2; r >= 0; r--) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        const t = grid[i];
        if (flags[i] & 1) continue;

        if (t === SAND) {
          stepSand(c, r, i);
        } else if (t === WATER) {
          stepLiquid(c, r, i, WATER);
        } else if (t === OIL) {
          stepLiquid(c, r, i, OIL);
        }
      }
    }
  }

  function stepSand(c, r, i) {
    // Straight down into empty/water/oil.
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      // Sand is denser than water/oil — it displaces (swaps) downward.
      if (bt === WATER || bt === OIL) { swap(i, below); flags[below] |= 1; return; }
    }
    // Diagonal fallthrough.
    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (trySandDiag(c, r, d1)) return;
    if (trySandDiag(c, r, d2)) return;
  }

  function trySandDiag(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY || nt === WATER || nt === OIL) {
      const from = idx(c, r);
      swap(from, ni);
      flags[ni] |= 1;
      return true;
    }
    return false;
  }

  function stepLiquid(c, r, i, mat) {
    // Falling.
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      // Water is denser than oil — water sinks down through oil (oil floats).
      if (mat === WATER && bt === OIL) { swap(i, below); flags[below] |= 1; return; }
      // Diagonal settle
      const goLeft = Math.random() < 0.5;
      const d1 = goLeft ? -1 : 1, d2 = -d1;
      if (tryLiquidDiag(c, r, d1, mat)) return;
      if (tryLiquidDiag(c, r, d2, mat)) return;
    }
    // Sideways spread (fluid behaviour). Try to move left/right if blocked below.
    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (trySideways(c, r, d1, mat)) return;
    if (trySideways(c, r, d2, mat)) return;
  }

  function tryLiquidDiag(c, r, dc, mat) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
    if (mat === WATER && nt === OIL) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
    return false;
  }

  function trySideways(c, r, dc, mat) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    const ni = idx(nc, r);
    if (grid[ni] === EMPTY) {
      swap(idx(c, r), ni);
      flags[ni] |= 1;
      return true;
    }
    return false;
  }

  function tryFireDiag(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r - 1 < 0) return false;
    const ni = idx(nc, r - 1);
    if (grid[ni] === EMPTY) {
      swap(idx(c, r), ni);
      flags[ni] |= 1;
      return true;
    }
    return false;
  }

  function swap(a, b) {
    const g = grid[a], co = colors[a], l = life[a];
    grid[a] = grid[b];  colors[a] = colors[b];  life[a] = life[b];
    grid[b] = g;        colors[b] = co;         life[b] = l;
  }

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
        ctx.fillStyle = colors[i] || colorFor(t) || WALL_COLOR;
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  function loop() {
    spawnFromPours();
    step();
    render();
    dropFrame++;

    // If pours ran out AND there's nothing dynamic moving, we could idle —
    // but keeping a constant loop is simpler and lets paint-while-idle still
    // animate (e.g. paint water onto walls — it'll flow immediately).
    animId = requestAnimationFrame(loop);
  }

  // ── Share via URL fragment ─────────────────────────────────────────────────
  // Format v2:
  //   uint8 version (2)
  //   uint8 reserved
  //   for each stroke:
  //     uint8 materialCode (0=erase, 1=wall, 2=sand, 3=water, 4=oil, 5=fire, 6=plant)
  //     uvar  numPoints
  //     uvar  x0, y0
  //     for each subsequent point: svar dx, svar dy
  //   trailing 0xFF terminator
  //
  // v1 legacy (mode 0=draw/wall, 1=erase) still decodes for older links.

  function uvarPush(arr, n) {
    n = n >>> 0;
    while (n >= 0x80) { arr.push((n & 0x7f) | 0x80); n = n >>> 7; }
    arr.push(n & 0x7f);
  }
  function svarPush(arr, n) {
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
    let total = src.reduce((n, s) => n + s.pts.length, 0);
    if (total <= maxPts) return src;
    const ratio = total / maxPts;
    const step = Math.max(2, Math.ceil(ratio));
    const out = [];
    for (const s of src) {
      if (s.pts.length <= 2) { out.push({ t: s.t, pts: s.pts.slice() }); continue; }
      const kept = [s.pts[0]];
      for (let i = 1; i < s.pts.length - 1; i++) {
        if (i % step === 0) kept.push(s.pts[i]);
      }
      kept.push(s.pts[s.pts.length - 1]);
      out.push({ t: s.t, pts: kept });
    }
    return out;
  }

  function encodeStrokes(src) {
    const data = decimateStrokes(src, 1500);
    const bytes = [];
    bytes.push(2); // version
    bytes.push(0); // reserved
    for (const s of data) {
      bytes.push(s.t & 0x7f);
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

    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
      if (version !== 1 && version !== 2) return null;
      pos.p++; // reserved
      const out = [];
      while (pos.p < view.length && view[pos.p] !== 0xff) {
        const raw = view[pos.p++];
        let t;
        if (version === 1) {
          // v1: 0=draw (wall), 1=erase
          t = raw === 1 ? MATERIAL_CODE.erase : MATERIAL_CODE.wall;
        } else {
          t = raw & 0x7f;
          if (t < 0 || t >= MATERIAL_LIST.length) t = MATERIAL_CODE.wall;
        }
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
        out.push({ t: t, pts: pts });
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

    history.replaceState(null, '', '#s=' + encoded);

    if (navigator.share) {
      navigator.share({
        title: 'gravity doodle',
        text: 'I built a material-physics sandbox — try it / remix it:',
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
