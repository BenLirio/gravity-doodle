// Gravity Doodle — an AI-driven falling-sand sandbox.
//
// The seed palette is intentionally tiny (wall, sand, water). Everything
// else is invented by the user via the AI: name an element, describe how
// it behaves in plain words, and the LLM returns a structured physics
// spec that joins the palette for the session.
//
// Physics kinds:
//   static   — never moves (wall, plant, ice).
//   powder   — falls straight or diagonally and piles. denser powders
//              sink through lighter liquids. a `flow` 0..1 controls how
//              steep the pile is (0 = stacks vertically like cubes,
//              1 = collapses flat like flour).
//   liquid   — falls and spreads sideways. denser liquids sink below
//              lighter ones. `viscosity` 0..1 controls how reluctant the
//              liquid is to move sideways or fall (0 = water, 1 = honey).
//   gas      — rises and escapes the top. `lifeMin/lifeMax` decay it.
//
// Reactions: per element, list `{ other, becomes, chance }`. When this
// element is adjacent to `other`, with `chance` per frame `other`'s cell
// becomes `becomes` (or `null`/`"empty"` to destroy it). Built-in rules
// use this same system.

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;
  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'gravity-doodle';

  const EMPTY = 0;

  // ── Element registry ───────────────────────────────────────────────────────
  // 0 = EMPTY is reserved. Each element has a stable numeric id so the grid
  // can store one Uint8 per cell.
  //
  //   {
  //     id, key, displayName,
  //     kind:        'static'|'powder'|'liquid'|'gas',
  //     density:     1..9,
  //     viscosity:   0..1   (liquid only)
  //     flow:        0..1   (powder only — 1 = flows like flour, 0 = stacks)
  //     buoyancy:    0..1   (gas only — chance per frame to rise)
  //     stickiness:  0..1   (liquid/powder — chance per frame to stay put)
  //     lifeMin/lifeMax     (gas only)
  //     colors:      hex strings
  //     reactions:   [{other, becomes, chance}]
  //     isBuiltIn
  //   }

  const registry = {};            // id -> spec
  const keyToId  = {};            // key -> id

  function registerElement(spec) {
    registry[spec.id] = spec;
    keyToId[spec.key] = spec.id;
  }

  function nextCustomId() {
    let max = 0;
    for (const id in registry) if (+id > max) max = +id;
    return max + 1;
  }

  // ── Built-in seed elements ─────────────────────────────────────────────────
  // Three only — the rest are AI-invented. Stable ids so reactions can refer
  // to them.
  const WALL_ID  = 1;
  const SAND_ID  = 2;
  const WATER_ID = 3;

  // Canonical sand: warm amber, the same every time. Per the user, the sand
  // palette is its identity — randomising it broke recognition.
  const SAND_PALETTE = ['#e8a030', '#e06020', '#d44010', '#f0c048', '#c83030', '#e87828', '#f0d060', '#b84020'];

  function initBuiltIns() {
    registerElement({
      id: WALL_ID, key: 'wall', displayName: 'wall',
      kind: 'static', density: 10,
      colors: ['#d8c8a0', '#c8b890', '#b8a880'],
      isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: SAND_ID, key: 'sand', displayName: 'sand',
      kind: 'powder', density: 5, flow: 0.55, stickiness: 0,
      colors: SAND_PALETTE,
      isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: WATER_ID, key: 'water', displayName: 'water',
      kind: 'liquid', density: 5, viscosity: 0, stickiness: 0,
      colors: ['#4aa8d8', '#3e9ac8', '#62b8e0', '#2e84b8', '#6cc0e8'],
      isBuiltIn: true,
      reactions: [],
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let COLS, ROWS;
  let grid;        // Uint8Array of element ids
  let colors;      // per-cell color strings
  let life;        // Uint8Array auxiliary lifetime (gas decay)
  let flags;       // Uint8Array per-cell flags (bit0=moved, bit1=reacted)

  let selectedKey = 'sand';
  let isPointerDown = false;
  let lastCell = null;
  let lastPointer = null;        // {c, r} of most recent pointer position
  let holdPaintTimer = null;     // continuous-paint interval while held still
  let animId = null;

  // Active pours: top-of-screen curtains. { id, frames, total, kind }
  let pours = [];

  // ── Init ───────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');

    initBuiltIns();
    rebuildPalette();

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    animId = requestAnimationFrame(loop);

    showOverlay('paint with your finger\n\ntap "invent element" to add\nany material you can describe');
    syncActionLabel();
    bindModal();
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

  // ── Palette UI ─────────────────────────────────────────────────────────────
  function rebuildPalette() {
    const host = document.getElementById('palette-buttons');
    if (!host) return;
    host.innerHTML = '';

    // Seeds first in their canonical order, then invented elements in insertion
    // order, then the erase tool.
    const orderedIds = [WALL_ID, SAND_ID, WATER_ID];
    const customIds = Object.keys(registry)
      .map(n => +n)
      .filter(id => !registry[id].isBuiltIn)
      .sort((a, b) => a - b);
    orderedIds.push(...customIds);

    for (const id of orderedIds) {
      const spec = registry[id];
      if (!spec) continue;
      host.appendChild(buildMaterialButton(spec));
    }
    host.appendChild(buildEraseButton());

    refreshActiveClass();
  }

  function buildMaterialButton(spec) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn ' + (spec.isBuiltIn ? ('mat-' + spec.key) : 'mat-custom');
    btn.setAttribute('data-key', spec.key);
    if (!spec.isBuiltIn) {
      btn.style.setProperty('--swatch', spec.colors[0] || '#e8a030');
    }
    btn.textContent = spec.displayName.slice(0, 14);
    btn.onclick = () => setMaterial(spec.key);
    return btn;
  }

  function buildEraseButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn mat-erase';
    btn.setAttribute('data-key', 'erase');
    btn.textContent = 'erase';
    btn.onclick = () => setMaterial('erase');
    return btn;
  }

  function refreshActiveClass() {
    document.querySelectorAll('.tool-btn').forEach(b => {
      const k = b.getAttribute('data-key');
      b.classList.toggle('active', k === selectedKey);
    });
  }

  window.setMaterial = function (key) {
    selectedKey = key;
    refreshActiveClass();
    syncActionLabel();
  };

  // Static materials and erase can't be poured — fall back to sand.
  function pourableKeyFor(key) {
    if (key === 'erase') return 'sand';
    const id = keyToId[key];
    if (!id) return 'sand';
    const spec = registry[id];
    if (!spec) return 'sand';
    if (spec.kind === 'static') return 'sand';
    return key;
  }

  function syncActionLabel() {
    const drop = document.getElementById('btn-drop');
    if (drop) drop.textContent = 'pour ' + pourableKeyFor(selectedKey);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  window.clearAll = function () {
    pours = [];
    initGrid();
    selectedKey = 'sand';
    refreshActiveClass();
    syncActionLabel();
    showOverlay('paint with your finger\n\ntap "invent element" to add\nany material you can describe');
  };

  // ── Drawing ────────────────────────────────────────────────────────────────
  function canvasCell(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { c: Math.floor(x / CELL), r: Math.floor(y / CELL) };
  }

  function colorForSpec(spec) {
    if (!spec || !spec.colors || !spec.colors.length) return '#888';
    return spec.colors[Math.floor(Math.random() * spec.colors.length)];
  }

  function paintAt(c, r, brushR) {
    const key = selectedKey;
    if (key === 'erase') {
      for (let dc = -brushR; dc <= brushR; dc++) {
        for (let dr = -brushR; dr <= brushR; dr++) {
          if (dc * dc + dr * dr > brushR * brushR) continue;
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const i = idx(nc, nr);
          grid[i] = EMPTY; colors[i] = null; life[i] = 0;
        }
      }
      return;
    }
    const id = keyToId[key];
    if (!id) return;
    const spec = registry[id];
    for (let dc = -brushR; dc <= brushR; dc++) {
      for (let dr = -brushR; dr <= brushR; dr++) {
        if (dc * dc + dr * dr > brushR * brushR) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const i = idx(nc, nr);
        if (spec.kind === 'static') {
          grid[i] = id;
          colors[i] = colorForSpec(spec);
          life[i] = 0;
        } else {
          // Dynamic: only paint into empty cells so we don't wipe other
          // materials.
          if (grid[i] === EMPTY || grid[i] === id) {
            grid[i] = id;
            colors[i] = colorForSpec(spec);
            life[i] = (spec.kind === 'gas' && spec.lifeMin)
              ? spec.lifeMin + Math.floor(Math.random() * Math.max(1, spec.lifeMax - spec.lifeMin))
              : 0;
          }
        }
      }
    }
  }

  function paintLine(c0, r0, c1, r1, brushR) {
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

  function startHoldPaint() {
    stopHoldPaint();
    // Fires ~30/s while the pointer is held. Even if the cursor is perfectly
    // still, dynamic materials keep being deposited at the cursor — so
    // holding over one spot pours material continuously instead of stopping
    // after the first drop. (User-reported bug: paint stalls when finger
    // doesn't move.)
    holdPaintTimer = setInterval(() => {
      if (!isPointerDown || !lastPointer) return;
      paintAt(lastPointer.c, lastPointer.r, 2);
    }, 33);
  }

  function stopHoldPaint() {
    if (holdPaintTimer) { clearInterval(holdPaintTimer); holdPaintTimer = null; }
  }

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    const cell = canvasCell(e);
    lastCell = cell;
    lastPointer = cell;
    paintAt(cell.c, cell.r, 2);
    hideOverlay();
    startHoldPaint();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) paintLine(lastCell.c, lastCell.r, cell.c, cell.r, 2);
    lastCell = cell;
    lastPointer = cell;
  }

  function onPointerUp() {
    isPointerDown = false;
    lastCell = null;
    lastPointer = null;
    stopHoldPaint();
  }

  // ── Pour ───────────────────────────────────────────────────────────────────
  window.startDrop = function () {
    const key = pourableKeyFor(selectedKey);
    const id = keyToId[key];
    if (!id) return;
    const spec = registry[id];
    pours.push({ id, kind: spec.kind, frames: 0, total: 300 });
    hideOverlay();
  };

  const SPAWN_RATE = 18;

  function spawnFromPours() {
    if (!pours.length) return;
    const next = [];
    for (const p of pours) {
      if (p.frames > p.total) continue;
      const spec = registry[p.id];
      if (!spec) continue;
      for (let s = 0; s < SPAWN_RATE; s++) {
        const c = Math.floor(Math.random() * COLS);
        // Gases rise → spawn near bottom; everything else → top.
        const r = (spec.kind === 'gas')
          ? (Math.random() < 0.5 ? ROWS - 1 : ROWS - 2)
          : (Math.random() < 0.5 ? 0 : 1);
        const i = idx(c, r);
        if (grid[i] !== EMPTY) continue;
        grid[i] = p.id;
        colors[i] = colorForSpec(spec);
        if (spec.kind === 'gas' && spec.lifeMin) {
          life[i] = spec.lifeMin + Math.floor(Math.random() * Math.max(1, spec.lifeMax - spec.lifeMin));
        } else {
          life[i] = 0;
        }
      }
      p.frames++;
      next.push(p);
    }
    pours = next;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  function clearFlags() { flags.fill(0); }

  const NBR_DIRS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

  function applyReactions() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(c, r);
        const id = grid[i];
        if (!id) continue;
        if (flags[i] & 2) continue;
        const spec = registry[id];
        if (!spec || !spec.reactions || !spec.reactions.length) continue;

        for (const rx of spec.reactions) {
          const otherId = keyToId[rx.other];
          if (!otherId) continue;

          for (const [dc, dr] of NBR_DIRS) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
            const ni = idx(nc, nr);
            if (flags[ni] & 2) continue;
            if (grid[ni] !== otherId) continue;

            if (Math.random() < (rx.chance || 0)) {
              if (rx.becomes === null || rx.becomes === '' || rx.becomes === 'empty') {
                grid[ni] = EMPTY;
                colors[ni] = null;
                life[ni] = 0;
              } else {
                const becId = keyToId[rx.becomes];
                if (!becId) continue;
                const becSpec = registry[becId];
                grid[ni] = becId;
                colors[ni] = colorForSpec(becSpec);
                life[ni] = (becSpec.kind === 'gas' && becSpec.lifeMin)
                  ? becSpec.lifeMin + Math.floor(Math.random() * Math.max(1, becSpec.lifeMax - becSpec.lifeMin))
                  : 0;
              }
              flags[ni] |= 2;
            }
          }
        }
      }
    }
  }

  function step() {
    clearFlags();

    // Bottom row is open sky for falling things.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, ROWS - 1);
      const id = grid[i];
      if (!id) continue;
      const spec = registry[id];
      if (!spec) continue;
      if (spec.kind === 'powder' || spec.kind === 'liquid') {
        grid[i] = EMPTY; colors[i] = null;
      }
    }
    // Top row is open sky for gases.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, 0);
      const id = grid[i];
      if (!id) continue;
      const spec = registry[id];
      if (!spec) continue;
      if (spec.kind === 'gas') {
        grid[i] = EMPTY; colors[i] = null; life[i] = 0;
      }
    }

    applyReactions();

    // Gas rise (top to bottom so a rising gas isn't moved twice).
    for (let r = 0; r < ROWS; r++) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (flags[i] & 1) continue;
        const id = grid[i];
        if (!id) continue;
        const spec = registry[id];
        if (!spec || spec.kind !== 'gas') continue;

        // Decay.
        if (spec.lifeMin) {
          if (life[i] > 0) life[i]--;
          if (life[i] === 0) {
            grid[i] = EMPTY; colors[i] = null;
            continue;
          }
        }

        // Buoyancy: chance to skip rising this frame.
        const buoy = (typeof spec.buoyancy === 'number') ? spec.buoyancy : 0.9;
        if (Math.random() > buoy) continue;

        if (r - 1 >= 0) {
          const up = idx(c, r - 1);
          if (grid[up] === EMPTY) { swap(i, up); flags[up] |= 1; continue; }
        }
        const goLeft = Math.random() < 0.5;
        const d1 = goLeft ? -1 : 1, d2 = -d1;
        if (tryGasDiag(c, r, d1) || tryGasDiag(c, r, d2)) continue;
      }
    }

    // Falling passes (bottom to top).
    for (let r = ROWS - 2; r >= 0; r--) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (flags[i] & 1) continue;
        const id = grid[i];
        if (!id) continue;
        const spec = registry[id];
        if (!spec) continue;
        if (spec.kind === 'powder')      stepPowder(c, r, i, spec);
        else if (spec.kind === 'liquid') stepLiquid(c, r, i, spec);
      }
    }
  }

  function stepPowder(c, r, i, spec) {
    // Stickiness: a sticky powder occasionally refuses to move (e.g. wet sand).
    const stick = (typeof spec.stickiness === 'number') ? spec.stickiness : 0;
    if (stick > 0 && Math.random() < stick * 0.7) return;

    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      // Powders sink through liquids of lower density.
      if (bSpec && bSpec.kind === 'liquid' && bSpec.density < spec.density + 0.5) {
        swap(i, below); flags[below] |= 1; return;
      }
    }

    // Diagonal flow controlled by `flow` 0..1. Low flow = high angle of repose.
    const flow = (typeof spec.flow === 'number') ? spec.flow : 0.55;
    if (Math.random() > flow) return;

    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (tryPowderDiag(c, r, d1, spec)) return;
    if (tryPowderDiag(c, r, d2, spec)) return;
  }

  function tryPowderDiag(c, r, dc, spec) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    const nSpec = registry[nt];
    if (nSpec && nSpec.kind === 'liquid' && nSpec.density < spec.density + 0.5) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function stepLiquid(c, r, i, spec) {
    const visc = (typeof spec.viscosity === 'number') ? spec.viscosity : 0;
    const stick = (typeof spec.stickiness === 'number') ? spec.stickiness : 0;

    // Stickiness: chance to anchor (honey/syrup clinging to walls/each other).
    if (stick > 0) {
      // Check if there's a static or higher-density solid neighbour to cling to.
      let supported = false;
      for (const [dc, dr] of NBR_DIRS) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const nid = grid[idx(nc, nr)];
        if (!nid || nid === grid[i]) continue;
        const nSpec = registry[nid];
        if (!nSpec) continue;
        if (nSpec.kind === 'static' || nSpec.kind === 'powder') { supported = true; break; }
      }
      if (supported && Math.random() < stick) return;
    }

    // Viscosity: a viscous liquid sometimes refuses to move at all this frame.
    // viscosity=1 → moves ~1/5 of frames; viscosity=0 → moves every frame.
    if (visc > 0 && Math.random() < visc * 0.8) return;

    // Falling + density separation.
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      if (bSpec && bSpec.kind === 'liquid' && bSpec.density < spec.density) {
        swap(i, below); flags[below] |= 1; return;
      }
      // Diagonal fall.
      const goLeft = Math.random() < 0.5;
      const d1 = goLeft ? -1 : 1, d2 = -d1;
      if (tryLiquidDiag(c, r, d1, spec)) return;
      if (tryLiquidDiag(c, r, d2, spec)) return;
    }

    // Sideways spread: viscous liquids spread less (extra dampening).
    if (visc > 0 && Math.random() < visc * 0.5) return;

    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (trySideways(c, r, d1)) return;
    if (trySideways(c, r, d2)) return;
  }

  function tryLiquidDiag(c, r, dc, spec) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
    const nSpec = registry[nt];
    if (nSpec && nSpec.kind === 'liquid' && nSpec.density < spec.density) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function trySideways(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    const ni = idx(nc, r);
    if (grid[ni] === EMPTY) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function tryGasDiag(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r - 1 < 0) return false;
    const ni = idx(nc, r - 1);
    if (grid[ni] === EMPTY) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
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
        const id = grid[i];
        if (!id) continue;
        ctx.fillStyle = colors[i] || (registry[id] && registry[id].colors[0]) || '#888';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  function loop() {
    spawnFromPours();
    step();
    render();
    animId = requestAnimationFrame(loop);
  }

  // ── Invent modal ───────────────────────────────────────────────────────────
  function bindModal() {
    const overlay = document.getElementById('invent-overlay');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeInvent();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeInvent();
    });
    // Example chips: click to fill the form, then user can submit (or tweak).
    document.querySelectorAll('.invent-example').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('invent-name').value = btn.getAttribute('data-name') || '';
        document.getElementById('invent-desc').value = btn.getAttribute('data-desc') || '';
        document.getElementById('invent-name').focus();
      });
    });
  }

  window.openInvent = function () {
    const overlay = document.getElementById('invent-overlay');
    overlay.classList.remove('hidden');
    setInventStatus('', false);
    const nameEl = document.getElementById('invent-name');
    const descEl = document.getElementById('invent-desc');
    nameEl.value = '';
    descEl.value = '';
    setInventBusy(false);
    setTimeout(() => nameEl.focus(), 30);
  };

  window.closeInvent = function () {
    document.getElementById('invent-overlay').classList.add('hidden');
  };

  function setInventStatus(msg, isErr) {
    const el = document.getElementById('invent-status');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }

  function setInventBusy(busy) {
    document.getElementById('invent-submit').disabled = busy;
    document.getElementById('invent-cancel').disabled = busy;
    document.getElementById('invent-submit').textContent = busy ? 'inventing…' : 'invent';
  }

  window.submitInvent = async function () {
    const nameRaw = (document.getElementById('invent-name').value || '').trim();
    const descRaw = (document.getElementById('invent-desc').value || '').trim();
    if (!nameRaw) { setInventStatus('give it a name first.', true); return; }

    const key = slugify(nameRaw);
    if (!key) { setInventStatus('pick a name with letters in it.', true); return; }
    if (keyToId[key]) { setInventStatus('that name is already taken.', true); return; }

    setInventBusy(true);
    setInventStatus('asking the AI for physics…', false);

    try {
      const spec = await generateElement(nameRaw, descRaw);
      const finalized = finalizeSpec(nameRaw, key, spec);
      registerElement(finalized);
      rebuildPalette();
      setMaterial(finalized.key);
      closeInvent();
    } catch (e) {
      try {
        const fb = fallbackSpec(nameRaw, key, descRaw);
        registerElement(fb);
        rebuildPalette();
        setMaterial(fb.key);
        closeInvent();
      } catch (e2) {
        setInventBusy(false);
        setInventStatus('could not invent right now. try a different name.', true);
      }
    }
  };

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  }

  // ── AI call ────────────────────────────────────────────────────────────────
  // We use the flagship gpt-5.4 model (not mini) because designing a
  // coherent physics spec — picking density, viscosity, stickiness, flow,
  // colors, AND reactive behaviour against existing elements all at once —
  // is exactly the multi-step reasoning case the flagship is for. The user
  // explicitly asked for the best model.
  async function generateElement(name, desc) {
    const existing = Object.keys(keyToId);
    const otherList = existing.join(', ');

    const SYSTEM_PROMPT = [
      'You design elements for a falling-sand physics sandbox.',
      'Given an element name (and optional description), output ONE strict JSON object describing how it behaves.',
      'Be CREATIVE and SPECIFIC: density, viscosity, stickiness, flow, colors, and reactions should reflect the user\'s description, not generic defaults.',
      '',
      'Schema (all fields required unless marked optional):',
      '{',
      '  "kind": "static" | "powder" | "liquid" | "gas",',
      '  "density": number 1-9 (heavier sinks below lighter of same kind, and powders sink through lighter liquids),',
      '  "viscosity": number 0-1 (LIQUID ONLY: 0=water, 0.4=oil, 0.7=syrup, 0.95=tar/honey. Higher = thicker, slower, less spread),',
      '  "flow": number 0-1 (POWDER ONLY: 1=flour/dust spreads flat, 0.5=sand piles, 0.1=gravel stacks steeply),',
      '  "stickiness": number 0-1 (LIQUID/POWDER: 0=normal, 0.5=sticky/wet, 0.9=glue. Sticky things cling to walls and resist falling),',
      '  "buoyancy": number 0-1 (GAS ONLY: 1=hot fast-rising fire, 0.5=lazy smoke, 0.2=heavy fog),',
      '  "lifeMin": integer 0-150 (GAS ONLY: 0=no decay, 60=medium puff, 120=long-lived),',
      '  "lifeMax": integer 0-200 (GAS ONLY: >= lifeMin),',
      '  "colors": array of 3-6 hex strings like "#aabbcc", vivid and coherent, readable on near-black,',
      '  "reactions": array of 0-3 objects, each { "other": "<existing-element-key>", "becomes": "<existing-element-key-or-empty>", "chance": number 0.005-0.25 }',
      '}',
      '',
      'Kind heuristics (use the description, not just the name):',
      '- "static": never moves. wall, plant, ice, metal, crystal, wood, brick, glass, bone, web.',
      '- "powder": falls, piles. sand, salt, dust, glitter, ash, gravel, sugar, snow, seed, gunpowder.',
      '- "liquid": falls + spreads. water, oil, honey, acid, slime, juice, milk, blood, lava, mercury, syrup, tar, soda.',
      '- "gas": rises. fire, smoke, steam, fog, mist, vapor, cloud, spores, plasma.',
      '',
      'Viscosity rules of thumb (LIQUID): water=0, gasoline=0.05, oil=0.3, blood=0.5, syrup=0.75, honey=0.9, tar=0.97. A "viscous" or "thick" or "slow" liquid MUST have viscosity >= 0.6. Do not return 0 viscosity for honey.',
      'Flow rules of thumb (POWDER): flour/talc/dust=1.0, fine sand=0.7, sand=0.55, salt=0.5, gravel=0.25, chunky/jagged=0.1.',
      'Stickiness: slime/glue/tar/web/resin = 0.7-0.95. Anything described as "sticky", "clinging", "gummy" gets >= 0.5.',
      'Density: feathers=1, smoke=2, oil=3, alcohol=4, water=5, blood=6, mercury=8, lead=9. Match physical intuition.',
      '',
      'Reactions:',
      '  "other" must be one of the EXISTING element keys: ' + otherList + '. (You may also reference yourself by your own key in `becomes` — the system passes your name through validly.)',
      '  "becomes" is also an existing key OR the literal string "empty" to destroy the other cell.',
      '  Reads as: "when this element is next to <other>, with <chance> per frame, <other> turns into <becomes>".',
      '  Examples:',
      '    lava → [{"other":"plant","becomes":"fire","chance":0.15},{"other":"water","becomes":"empty","chance":0.1}]',
      '    acid → [{"other":"plant","becomes":"empty","chance":0.12},{"other":"wall","becomes":"empty","chance":0.04}]',
      '    snow → [{"other":"fire","becomes":"empty","chance":0.2}]  (snow extinguishes fire)',
      '  Pick reactions that match the user\'s described behaviour. If the user says "dissolves walls", add {other:"wall",becomes:"empty",chance:0.05}.',
      '  0-2 reactions is usually enough. Keep chances small (0.01-0.2) so the sandbox stays legible.',
      '',
      'Colors: 3-6 hex values from a coherent palette that READS on a near-black background. Honey = warm gold, tar = near-black with brown flecks, acid = vivid green, snow = warm whites and pale blues, fire = orange/yellow/red.',
      '',
      'Respond with ONLY the JSON object. No prose, no code fence.',
    ].join('\n');

    const userPrompt = desc
      ? `Name: ${name}\nDescription: ${desc}`
      : `Name: ${name}`;

    const body = {
      slug: SLUG,
      // Best model — the user explicitly asked for it. Element design is a
      // multi-knob reasoning task (kind + 4-5 numeric params + colors +
      // reactions) where mini was producing generic specs.
      model: 'gpt-5.4',
      temperature: 0.7,
      max_tokens: 600,
      response_format: 'json_object',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    };

    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    if (!data || typeof data.content !== 'string') throw new Error('bad_shape');
    let parsed;
    try { parsed = JSON.parse(data.content); } catch (e) { throw new Error('bad_json'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('bad_obj');
    return parsed;
  }

  // Sanitize and shape whatever the LLM returned into a valid spec.
  function finalizeSpec(displayName, key, raw) {
    const kinds = ['static', 'powder', 'liquid', 'gas'];
    let kind = (raw && typeof raw.kind === 'string') ? raw.kind.toLowerCase() : 'powder';
    if (kinds.indexOf(kind) < 0) kind = 'powder';

    let density = Number(raw && raw.density);
    if (!isFinite(density)) density = 5;
    density = Math.max(1, Math.min(9, density));

    let colorsArr = Array.isArray(raw && raw.colors) ? raw.colors.filter(isHex).slice(0, 6) : [];
    if (colorsArr.length < 3) colorsArr = fillFallbackColors(key);

    // Reactions — `becomes` may reference this new element by its own key.
    const validKeys = new Set(Object.keys(keyToId));
    validKeys.add(key);
    const reactions = [];
    if (Array.isArray(raw && raw.reactions)) {
      for (const rx of raw.reactions.slice(0, 3)) {
        if (!rx || typeof rx !== 'object') continue;
        const other = (typeof rx.other === 'string') ? rx.other.toLowerCase() : '';
        if (!validKeys.has(other)) continue;
        let becomes = rx.becomes;
        if (becomes == null || becomes === '' || /^empty$/i.test(String(becomes))) {
          becomes = null;
        } else {
          becomes = String(becomes).toLowerCase();
          if (!validKeys.has(becomes)) continue;
        }
        let chance = Number(rx.chance);
        if (!isFinite(chance)) chance = 0.05;
        chance = Math.max(0.005, Math.min(0.25, chance));
        reactions.push({ other, becomes, chance });
      }
    }

    const out = {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: colorsArr,
      reactions,
      isBuiltIn: false,
    };

    if (kind === 'liquid') {
      let visc = Number(raw && raw.viscosity);
      if (!isFinite(visc)) visc = 0;
      out.viscosity = Math.max(0, Math.min(1, visc));
      let stick = Number(raw && raw.stickiness);
      if (!isFinite(stick)) stick = 0;
      out.stickiness = Math.max(0, Math.min(1, stick));
    } else if (kind === 'powder') {
      let flow = Number(raw && raw.flow);
      if (!isFinite(flow)) flow = 0.55;
      out.flow = Math.max(0.05, Math.min(1, flow));
      let stick = Number(raw && raw.stickiness);
      if (!isFinite(stick)) stick = 0;
      out.stickiness = Math.max(0, Math.min(1, stick));
    } else if (kind === 'gas') {
      let buoy = Number(raw && raw.buoyancy);
      if (!isFinite(buoy)) buoy = 0.9;
      out.buoyancy = Math.max(0.05, Math.min(1, buoy));
      let lifeMin = Math.round(Number(raw && raw.lifeMin));
      let lifeMax = Math.round(Number(raw && raw.lifeMax));
      if (!isFinite(lifeMin)) lifeMin = 60;
      if (!isFinite(lifeMax) || lifeMax < lifeMin) lifeMax = lifeMin + 40;
      lifeMin = Math.max(0, Math.min(150, lifeMin));
      lifeMax = Math.max(0, Math.min(200, lifeMax));
      if (lifeMin === 0 && lifeMax === 0) { lifeMin = 60; lifeMax = 100; }
      out.lifeMin = lifeMin; out.lifeMax = lifeMax;
    }

    return out;
  }

  function isHex(s) { return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s); }

  function fillFallbackColors(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    const out = [];
    for (let i = 0; i < 5; i++) {
      const hh = (hue + i * 12) % 360;
      const ll = 38 + i * 6;
      out.push(hslToHex(hh, 55, ll));
    }
    return out;
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const col = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * col).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // Offline / rate-limit fallback: keyword-sniff a plausible spec.
  function fallbackSpec(displayName, key, desc) {
    const blob = (key + ' ' + (desc || '')).toLowerCase();
    const has = (...words) => words.some(w => blob.indexOf(w) >= 0);

    let kind = 'powder';
    let density = 5;
    let viscosity = 0;
    let flow = 0.55;
    let stickiness = 0;
    let buoyancy = 0.9;
    let reactions = [];

    if (has('fire', 'flame', 'inferno')) {
      kind = 'gas'; density = 1; buoyancy = 1;
      reactions = [];
    } else if (has('lava', 'magma')) {
      kind = 'liquid'; density = 7; viscosity = 0.6;
      reactions = [
        { other: 'water', becomes: null, chance: 0.05 },
      ];
    } else if (has('smoke', 'steam', 'fog', 'mist', 'gas', 'vapor', 'cloud', 'spore')) {
      kind = 'gas'; density = 2; buoyancy = 0.6;
    } else if (has('ice', 'rock', 'stone', 'metal', 'crystal', 'wood', 'brick', 'glass', 'bone', 'web')) {
      kind = 'static';
    } else if (has('honey', 'syrup', 'tar', 'glue', 'molasses', 'caramel')) {
      kind = 'liquid'; density = 6; viscosity = 0.9; stickiness = 0.7;
    } else if (has('acid')) {
      kind = 'liquid'; density = 4; viscosity = 0.1;
      reactions = [
        { other: 'wall',  becomes: null, chance: 0.04 },
        { other: 'sand',  becomes: null, chance: 0.04 },
      ];
    } else if (has('water', 'oil', 'slime', 'juice', 'milk', 'liquid', 'blood', 'goo', 'soda')) {
      kind = 'liquid'; density = has('oil') ? 3 : 5; viscosity = has('oil') ? 0.3 : 0;
      if (has('slime', 'goo')) { viscosity = 0.6; stickiness = 0.4; }
    } else if (has('snow')) {
      kind = 'powder'; density = 2; flow = 0.4;
    } else if (has('flour', 'powder', 'dust', 'talc', 'ash')) {
      kind = 'powder'; flow = 1.0; density = 2;
    } else if (has('gravel', 'rocks')) {
      kind = 'powder'; flow = 0.15; density = 7;
    } else if (has('sand', 'salt', 'glitter', 'seed', 'sugar')) {
      kind = 'powder'; flow = 0.55;
    }

    const out = {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: fillFallbackColors(key),
      reactions,
      isBuiltIn: false,
    };
    if (kind === 'liquid') { out.viscosity = viscosity; out.stickiness = stickiness; }
    if (kind === 'powder') { out.flow = flow; out.stickiness = stickiness; }
    if (kind === 'gas')    { out.buoyancy = buoyancy; out.lifeMin = 60; out.lifeMax = 110; }
    return out;
  }
})();
