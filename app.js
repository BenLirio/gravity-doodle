// Gravity Doodle — falling-sand sandbox with user-invented elements.
//
// The user can paint with 6 built-in elements (wall, sand, water, oil, fire,
// plant), or tap "invent element" to generate a new one via AI. The LLM
// returns a structured physics spec (kind, density, colors, reactions with
// other elements) and the new element joins the palette for the session.
//
// Physics kinds:
//   static   — never moves (wall-like)
//   powder   — falls straight or diagonally, piles; denser powders sink
//              through lighter liquids (sand-like)
//   liquid   — falls + spreads sideways; denser liquids sink through
//              lighter ones (water/oil-like)
//   gas      — rises; escapes through the top of the screen (fire-like)
//
// Reactions are per-element: when element A is next to element B, with
// some probability per frame, cell B turns into element C (or EMPTY). This
// is the generalization of the built-in fire-ignites-plant /
// water-extinguishes-fire / plant-grows-into-water rules.

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;
  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'gravity-doodle';

  const EMPTY = 0;

  // ── Element registry ───────────────────────────────────────────────────────
  // Each element has a stable numeric id (0 = EMPTY is reserved). We keep a
  // registry so the grid can store a single Uint8 per cell.
  //
  // Shape:
  //   {
  //     id: number,
  //     key: string,                // lowercase slug, unique
  //     displayName: string,        // for the UI
  //     kind: 'static'|'powder'|'liquid'|'gas',
  //     density: number,            // 0..10 (powder/liquid: larger sinks through smaller of same kind or through lighter liquids)
  //     colors: string[],           // 3-8 hex colors; picked at paint time
  //     lifeMin: number,            // gas decay lifetime (frames). 0 = no decay (ignored for non-gas)
  //     lifeMax: number,
  //     burns: boolean,             // fire-likes will try to ignite this (legacy flag)
  //     isBuiltIn: boolean,
  //     // Reactions: when THIS element is adjacent to `other`, there's a chance
  //     // per frame that `other`'s cell becomes `becomes`. Built-in rules use
  //     // this system too.
  //     reactions: [{ other: key, becomes: key|null, chance: number }]
  //   }

  const registry = {};            // id -> spec
  const keyToId  = {};            // key -> id

  function registerElement(spec) {
    const id = spec.id;
    registry[id] = spec;
    keyToId[spec.key] = id;
  }

  function nextCustomId() {
    let max = 0;
    for (const id in registry) if (+id > max) max = +id;
    return max + 1;
  }

  // ── Built-in elements ──────────────────────────────────────────────────────
  // IDs are stable so we can refer to them from reactions.
  const WALL_ID  = 1;
  const SAND_ID  = 2;
  const WATER_ID = 3;
  const OIL_ID   = 4;
  const FIRE_ID  = 5;
  const PLANT_ID = 6;

  // Sand palettes — picked per session so sculptures stay coherent.
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
  let sessionSandPalette = SAND_PALETTES[0];

  function initBuiltIns() {
    registerElement({
      id: WALL_ID, key: 'wall', displayName: 'wall',
      kind: 'static', density: 10,
      colors: ['#d8c8a0'],
      burns: false, isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: SAND_ID, key: 'sand', displayName: 'sand',
      kind: 'powder', density: 5,
      colors: sessionSandPalette,
      burns: false, isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: WATER_ID, key: 'water', displayName: 'water',
      kind: 'liquid', density: 5,
      colors: ['#4aa8d8', '#3e9ac8', '#62b8e0', '#2e84b8', '#6cc0e8'],
      burns: false, isBuiltIn: true,
      // Extinguishes fire:
      reactions: [
        { other: 'fire', becomes: null, chance: 1.0 },
      ],
    });
    registerElement({
      id: OIL_ID, key: 'oil', displayName: 'oil',
      kind: 'liquid', density: 3, // lighter than water
      colors: ['#3a2e20', '#4a3a28', '#2a2218', '#5a4830', '#3e3020'],
      burns: true, isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: FIRE_ID, key: 'fire', displayName: 'fire',
      kind: 'gas', density: 1,
      colors: ['#ff6020', '#ff8840', '#ffb060', '#ff4010', '#ffd080', '#ff3008'],
      burns: false, isBuiltIn: true, lifeMin: 60, lifeMax: 100,
      // Fire ignites oil and plant:
      reactions: [
        { other: 'oil',   becomes: 'fire', chance: 0.08 },
        { other: 'plant', becomes: 'fire', chance: 0.08 },
      ],
    });
    registerElement({
      id: PLANT_ID, key: 'plant', displayName: 'plant',
      kind: 'static', density: 8,
      colors: ['#4a9028', '#6ab040', '#5ca038', '#3a7818', '#7ac050', '#2e5a10'],
      burns: true, isBuiltIn: true,
      // Plant grows into adjacent water:
      reactions: [
        { other: 'water', becomes: 'plant', chance: 0.008 },
      ],
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let COLS, ROWS;
  let grid;        // Uint8Array of element ids
  let colors;      // per-cell color strings
  let life;        // Uint8Array auxiliary lifetime (gas decay)
  let flags;       // Uint8Array per-cell flags (bit0 = moved this tick)

  let selectedKey = 'wall';
  let isPointerDown = false;
  let lastCell = null;
  let animId = null;

  // Active pours: top-of-screen curtains. { id, frames, total, kind }
  let pours = [];

  // ── Init ───────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');

    pickSessionSandPalette();
    initBuiltIns();
    rebuildPalette();

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    animId = requestAnimationFrame(loop);

    showOverlay('paint materials here\nwith your finger or mouse\n\ntap "invent element" to add your own');
    syncActionLabel();
    bindModal();
  });

  function pickSessionSandPalette() {
    sessionSandPalette = SAND_PALETTES[Math.floor(Math.random() * SAND_PALETTES.length)];
    if (registry[SAND_ID]) registry[SAND_ID].colors = sessionSandPalette;
  }

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

    // Keep built-ins in their original order, then custom elements in order
    // of insertion, then erase at the end.
    const orderedIds = [WALL_ID, SAND_ID, WATER_ID, OIL_ID, FIRE_ID, PLANT_ID];
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
    // Erase at end.
    host.appendChild(buildEraseButton());

    // Reflect active selection.
    refreshActiveClass();
  }

  function buildMaterialButton(spec) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn ' + (spec.isBuiltIn ? ('mat-' + spec.key) : 'mat-custom');
    btn.setAttribute('data-key', spec.key);
    if (!spec.isBuiltIn) {
      // Custom elements provide their own swatch via inline style.
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

  // Static materials and erase can't be poured — fall back to sand so the
  // action button always does something sensible.
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
    const label = 'pour ' + pourableKeyFor(selectedKey);
    if (drop) drop.textContent = label;
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  window.clearAll = function () {
    pours = [];
    pickSessionSandPalette();
    initGrid();
    selectedKey = 'wall';
    refreshActiveClass();
    syncActionLabel();
    showOverlay('paint materials here\nwith your finger or mouse\n\ntap "invent element" to add your own');
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
          // Static paints overwrite anything.
          grid[i] = id;
          colors[i] = colorForSpec(spec);
          life[i] = 0;
        } else {
          // Dynamic: only paint into empty cells so we don't wipe other
          // materials by accident.
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

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    const cell = canvasCell(e);
    lastCell = cell;
    paintAt(cell.c, cell.r, 2);
    hideOverlay();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) paintLine(lastCell.c, lastCell.r, cell.c, cell.r, 2);
    lastCell = cell;
  }

  function onPointerUp() {
    isPointerDown = false;
    lastCell = null;
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
        // Gases rise → spawn near bottom; everything else falls → spawn near top.
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

  // Iterate a cell's 4 orthogonal + 4 diagonal neighbours.
  const NBR_DIRS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

  function applyReactions() {
    // For each cell, check that element's reactions against its neighbours.
    // We use flags (bit1 = reacted this tick) so a cell transformed by a
    // reaction doesn't immediately re-react as its new type in the same tick.
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

    // Bottom row is open sky for falling things — they drop off.
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
    // Top row is open sky for gases — they escape upward.
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

    // Gas rise (top to bottom so a gas doesn't ride its own update back up).
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

        // Rise straight.
        if (r - 1 >= 0) {
          const up = idx(c, r - 1);
          if (grid[up] === EMPTY) { swap(i, up); flags[up] |= 1; continue; }
        }
        // Diagonal up.
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
        if (spec.kind === 'powder')  stepPowder(c, r, i, spec);
        else if (spec.kind === 'liquid') stepLiquid(c, r, i, spec);
      }
    }
  }

  function stepPowder(c, r, i, spec) {
    // Straight down into empty, or into any liquid (powders are denser than
    // liquids for gameplay purposes — sand sinks in water, etc.).
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      if (bSpec && bSpec.kind === 'liquid') {
        swap(i, below); flags[below] |= 1; return;
      }
    }
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
    if (nSpec && nSpec.kind === 'liquid') {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function stepLiquid(c, r, i, spec) {
    // Falling + density separation.
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      if (bSpec && bSpec.kind === 'liquid' && bSpec.density < spec.density) {
        // Heavier liquid sinks through lighter one.
        swap(i, below); flags[below] |= 1; return;
      }
      // Diagonal fall.
      const goLeft = Math.random() < 0.5;
      const d1 = goLeft ? -1 : 1, d2 = -d1;
      if (tryLiquidDiag(c, r, d1, spec)) return;
      if (tryLiquidDiag(c, r, d2, spec)) return;
    }
    // Sideways spread (fluid behaviour).
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
      // Local fallback so the user never dead-ends.
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
  async function generateElement(name, desc) {
    const existing = Object.keys(keyToId);
    const otherList = existing.join(', ');

    const SYSTEM_PROMPT = [
      'You design falling-sand elements for a tiny browser physics sandbox.',
      'Given an element name (and optional vibe), output ONE strict JSON object describing its physics.',
      '',
      'Schema (all fields required):',
      '{',
      '  "kind": "static" | "powder" | "liquid" | "gas",',
      '  "density": integer 1-9,',
      '  "colors": array of 3-6 hex strings like "#aabbcc" — vivid, coherent, readable on near-black,',
      '  "reactions": array of 0-3 objects, each { "other": "<existing-element-key>", "becomes": "<existing-element-key-or-empty>", "chance": number 0.005-0.2 },',
      '  "lifeMin": integer 0-120 (only meaningful when kind=="gas"; 0 means "no decay"),',
      '  "lifeMax": integer 0-150 (>= lifeMin)',
      '}',
      '',
      'Kind meanings:',
      '- "static": never moves (e.g. wall, plant, metal, ice).',
      '- "powder": falls, piles; higher density sinks through lighter liquids (sand, gravel, salt, glitter).',
      '- "liquid": falls + spreads sideways; denser liquid sinks below lighter one (water=5, oil=3).',
      '- "gas": rises; if lifeMin>0 it decays (fire, smoke, steam).',
      '',
      'Reactions:',
      '  "other" must be one of the EXISTING element keys: ' + otherList + '.',
      '  "becomes" is also an existing key, OR the literal string "empty" to destroy the other cell.',
      '  Reactions read as: "when this element is next to <other>, with <chance> per frame, <other> turns into <becomes>".',
      '  Example: lava → [{"other":"plant","becomes":"fire","chance":0.15},{"other":"water","becomes":"empty","chance":0.1}].',
      '  Keep chances small (0.01-0.15) so the sandbox stays legible.',
      '',
      'Guidelines:',
      '- Pick a kind that matches the vibe of the name.',
      '- Colors: 3-6 distinct hex values for visual texture, picked from a coherent palette.',
      '- Ice/stone/wood/crystal/metal = static. Sand/salt/seed/glitter/powder = powder. Water/oil/acid/honey/lava = liquid. Smoke/fire/steam/fog = gas.',
      '- Reactions should be tasteful: 0-2 reactions is fine; more than 3 feels chaotic.',
      '- DO NOT invent new element keys in reactions — only reference existing ones.',
      '',
      'Respond with ONLY the JSON object. No prose, no code fence.',
    ].join('\n');

    const userPrompt = desc
      ? `Name: ${name}\nVibe: ${desc}`
      : `Name: ${name}`;

    const body = {
      slug: SLUG,
      model: 'gpt-5.4-mini',
      temperature: 0.6,
      max_tokens: 400,
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

    let density = Math.round(Number(raw && raw.density));
    if (!isFinite(density)) density = 5;
    density = Math.max(1, Math.min(9, density));

    // Colors.
    let colorsArr = Array.isArray(raw && raw.colors) ? raw.colors.filter(isHex).slice(0, 6) : [];
    if (colorsArr.length < 3) colorsArr = fillFallbackColors(key);

    // Reactions.
    const validKeys = new Set(Object.keys(keyToId));
    validKeys.add(key);
    let reactions = [];
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
        chance = Math.max(0.005, Math.min(0.2, chance));
        reactions.push({ other, becomes, chance });
      }
    }

    // Life (gas only).
    let lifeMin = 0, lifeMax = 0;
    if (kind === 'gas') {
      lifeMin = Math.max(0, Math.min(120, Math.round(Number(raw && raw.lifeMin))));
      lifeMax = Math.max(0, Math.min(150, Math.round(Number(raw && raw.lifeMax))));
      if (!isFinite(lifeMin)) lifeMin = 60;
      if (!isFinite(lifeMax) || lifeMax < lifeMin) lifeMax = lifeMin + 40;
      if (lifeMin === 0 && lifeMax === 0) { lifeMin = 60; lifeMax = 100; }
    }

    return {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: colorsArr,
      reactions,
      lifeMin, lifeMax,
      burns: false,
      isBuiltIn: false,
    };
  }

  function isHex(s) { return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s); }

  function fillFallbackColors(key) {
    // Deterministic palette from the key so the swatch is stable on retries.
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
    let reactions = [];
    if (has('fire', 'flame', 'lava', 'magma', 'burn', 'inferno')) {
      kind = 'liquid'; density = 7;
      reactions = [
        { other: 'plant', becomes: 'fire', chance: 0.1 },
        { other: 'oil',   becomes: 'fire', chance: 0.1 },
        { other: 'water', becomes: null,    chance: 0.05 },
      ];
    } else if (has('smoke', 'steam', 'fog', 'mist', 'gas', 'vapor', 'cloud')) {
      kind = 'gas';
    } else if (has('ice', 'rock', 'stone', 'metal', 'crystal', 'wood', 'brick', 'glass', 'bone')) {
      kind = 'static';
    } else if (has('water', 'oil', 'honey', 'acid', 'slime', 'juice', 'milk', 'liquid', 'blood', 'goo')) {
      kind = 'liquid'; density = 5;
      if (has('acid')) reactions = [{ other: 'plant', becomes: null, chance: 0.08 }];
    } else if (has('sand', 'salt', 'dust', 'glitter', 'seed', 'powder', 'ash', 'gravel', 'sugar', 'snow')) {
      kind = 'powder';
    }

    return {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: fillFallbackColors(key),
      reactions,
      lifeMin: kind === 'gas' ? 60 : 0,
      lifeMax: kind === 'gas' ? 110 : 0,
      burns: false,
      isBuiltIn: false,
    };
  }
})();
