// realm.pixels game: tools on the world viewer. Pickaxe (mine blocks), axe (fell a whole tree, rock, house, the
// castle...), block (place blocks like Minecraft), stamp (put down a castle, a house, a tree...), undo, save.
// The voxel bookkeeping is edit.js; this file draws it and handles the mouse and the panel.
import { API } from './viewer.js';
import { World, loadPrefabs, DIR } from './edit.js';

const { THREE, M, DAYN, vbuf, partFaces, faceMat, shadowMat, quadCorners, sceneMain, sceneShadow, cam, view, derived, H, canvas, stage } = API;
const $ = (id) => document.getElementById(id);
const status = (s) => { $('g-status').textContent = s; };

// ------------------------------------------------------------- data
status('Building the game index…');
await new Promise((r) => setTimeout(r, 0));
const W = new World(vbuf, M.parts, M.q);
let prefabs = null;
try {
  const [pm, pb] = await Promise.all([fetch('data/prefabs.json', { cache: 'no-cache' }), fetch('data/prefabs.bin', { cache: 'no-cache' })]);
  if (pm.ok && pb.ok) prefabs = loadPrefabs(await pb.arrayBuffer(), await pm.json());
} catch { /* no stamps: run python viewer/export.py */ }

// ------------------------------------------------------------- drawing side of edit.js
const touched = new Map();                          // attribute -> [first, last] instance changed
const touch = (attr, j) => { const r = touched.get(attr); if (!r) touched.set(attr, [j, j]); else { r[0] = Math.min(r[0], j); r[1] = Math.max(r[1], j); } };
function flush() {
  for (const [attr, [a, b]] of touched) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(a * attr.itemSize, (b - a + 1) * attr.itemSize);
    attr.needsUpdate = true;
  }
  touched.clear();
  API.stats.extra = edit.n ? ` · ${edit.n.toLocaleString()} edit faces` : '';
  API.invalidateShadow();
}
function editLayer(cap) {
  const g = quadCorners();
  g.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Uint16Array(cap * 3), 3));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4));
  g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(new Uint8Array(cap * 4), 4));
  g.instanceCount = 0;
  return g;
}
const edit = { cap: 1 << 16, n: 0 };
edit.g = editLayer(edit.cap);
const editFace = new THREE.Mesh(edit.g, faceMat), editShadow = new THREE.Mesh(edit.g, shadowMat);
editFace.frustumCulled = editShadow.frustumCulled = false;
editFace.renderOrder = 1;
sceneMain.add(editFace); sceneShadow.add(editShadow);
function grow() {                                   // twice the room, same faces
  const old = edit.g, cap = edit.cap * 2, g = editLayer(cap);
  for (const k of ['aPos', 'aCol', 'aMisc']) g.getAttribute(k).array.set(old.getAttribute(k).array);
  g.instanceCount = edit.n;
  editFace.geometry = editShadow.geometry = g;
  old.dispose();
  edit.g = g; edit.cap = cap;
  touched.clear();
  for (const k of ['aPos', 'aCol', 'aMisc']) g.getAttribute(k).needsUpdate = true;
}
function origFace(k, i, rank) {                     // where the viewer draws voxel i's rank-th face
  const pf = partFaces[k], gi = pf.voxGeom[i];
  return gi < 0 ? null : [pf.geoms[gi].getAttribute('aMisc'), pf.voxFirst[i] + rank];
}
const sink = {
  hideOrig(k, i, r) { const o = origFace(k, i, r); if (o) { o[0].array[o[1] * 4 + 3] = 1; touch(o[0], o[1]); } },
  showOrig(k, i, r) { const o = origFace(k, i, r); if (o) { o[0].array[o[1] * 4 + 3] = 0; touch(o[0], o[1]); } },
  addFace(r) {
    if (edit.n >= edit.cap) grow();
    const e = edit.n++, g = edit.g;
    const P = g.getAttribute('aPos'), C = g.getAttribute('aCol'), X = g.getAttribute('aMisc');
    P.array[e * 3] = r[0] | (r[1] << 8); P.array[e * 3 + 1] = r[2] | (r[3] << 8); P.array[e * 3 + 2] = r[4] | (r[5] << 8);
    C.array.set([r[6], r[7], r[8], r[9]], e * 4);
    X.array.set([r[10], r[11], r[12], 0], e * 4);
    touch(P, e); touch(C, e); touch(X, e);
    g.instanceCount = edit.n;
    return e;
  },
  hideEdit(e) { const X = edit.g.getAttribute('aMisc'); X.array[e * 4 + 3] = 1; touch(X, e); },
  reset() {
    for (const g of partFaces.flatMap((pf) => pf.geoms)) {
      const a = g.getAttribute('aMisc');
      for (let i = 3; i < a.array.length; i += 4) a.array[i] = 0;
      a.clearUpdateRanges(); a.needsUpdate = true;
      touched.delete(a);
    }
    edit.n = 0; edit.g.instanceCount = 0;
  },
};

// ------------------------------------------------------------- the cursor: a glowing cube where the tool will act
const cur = { g: editLayer(64) };
const curMesh = new THREE.Mesh(cur.g, faceMat);
curMesh.frustumCulled = false; curMesh.renderOrder = 2; curMesh.visible = false;
sceneMain.add(curMesh);
function showCursor(boxes, rgb) {                    // boxes: [x, y, h, size]
  const P = cur.g.getAttribute('aPos'), C = cur.g.getAttribute('aCol'), X = cur.g.getAttribute('aMisc');
  let n = 0;
  for (const [x, y, h, s] of boxes.slice(0, 10)) {
    const q = (v) => Math.max(0, Math.min(65535, Math.round((v + 64) * M.q)));
    for (let f = 0; f < 6; f++, n++) {
      P.array.set([q(x - s * 0.02), q(y - s * 0.02), q(h - s * 0.02)], n * 3);
      C.array.set([rgb[0], rgb[1], rgb[2], f | 8], n * 4);          // emissive: it glows through the bloom
      X.array.set([200, 0, Math.min(255, Math.round(s * 104)), 0], n * 4);
    }
  }
  cur.g.instanceCount = n;
  for (const a of [P, C, X]) { a.clearUpdateRanges(); a.needsUpdate = true; }
  curMesh.visible = n > 0;
  API.markDirty();
}

// ------------------------------------------------------------- picking: the engine's projection, inverted
const cliffX = (y) => M.land.CLIFF_X0 + 8 * Math.sin(y * 0.03) + 4 * Math.sin(y * 0.11 + 1.0);
function screenRay(e) {
  const cr = canvas.getBoundingClientRect(), k = H / cr.height;
  const px = (e.clientX - cr.left) * k, py = (e.clientY - cr.top) * k;
  const d = derived(cam);
  const at = (dz) => {
    const sc = d.D / (d.D - dz), u = (px - view.Weng / 2) / d.z, v = (py - H * d.fy) / d.z;
    const rx = u / sc, t1 = v / sc, ry = d.ca * t1 + d.sa * dz, h = -d.sa * t1 + d.ca * dz;
    return [d.cx + d.cs * rx - d.sn * ry, d.cy + d.sn * rx + d.cs * ry, h];
  };
  const a = at(Math.min(600, d.D * 0.9)), b = at(-2000);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return { o: a, d: [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len], len };
}
function pick(e) {
  const r = screenRay(e);
  const v = W.raycast(r.o, r.d, r.len);
  let g = null;                                       // the ground: the plateau, or the lowland west of the cliff
  if (r.d[2] < 0) {
    for (const hh of [0, -M.land.LOW]) {
      const t = (hh - r.o[2]) / r.d[2];
      const p = [r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, hh];
      if ((hh === 0) === (p[0] >= cliffX(p[1]))) { g = { t, p, ground: true }; break; }
    }
  }
  if (v && (!g || v.t <= g.t)) return v;
  return g;
}

// ------------------------------------------------------------- tools
const tool = { name: 'look', brush: 1, bsize: 1, color: [180, 170, 154], prefab: prefabs?.list[0]?.name, rot: 0 };
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const snap = (v, s) => Math.floor(v / s + 1e-6) * s;

function target(hit) {                                // what the current tool would do at a pick: [op, cursor boxes]
  if (!hit) return null;
  const t = tool.name;
  if ((t === 'mine' || t === 'fell') && !hit.ground) {
    const p = W.pos(hit.id), s = W.size(hit.id);
    if (t === 'fell') return [{ k: 'fell', p, s }, [[...p, s]], `${hit.id < W.NV ? M.parts[W.partOf(hit.id)].name : 'placed'} object ${W.obj(hit.id)}`];
    const r = tool.brush <= 1 ? s * 0.5 + 0.01 : tool.brush;
    const c = [p[0] + s / 2, p[1] + s / 2, p[2] + s / 2];
    return [{ k: 'mine', p: c, r }, [[...p, s]], tool.brush <= 1 ? `${s} block` : `everything within ${r} of this block`];
  }
  if (t === 'block') {
    const s = tool.bsize;
    let p;
    if (hit.ground) p = [snap(hit.p[0], s), snap(hit.p[1], s), hit.p[2]];
    else {
      const hp = W.pos(hit.id), hs = W.size(hit.id), d = DIR[hit.f];
      p = Math.abs(hs - s) < 0.01 ? [hp[0] + d[0] * s, hp[1] + d[1] * s, hp[2] + d[2] * s]
        : [snap(hit.p[0] + d[0] * s * 0.5, s), snap(hit.p[1] + d[1] * s * 0.5, s), snap(hit.p[2] + d[2] * s * 0.5, s)];
    }
    return [{ k: 'block', p, s, c: tool.color.slice() }, [[...p, s]], ''];
  }
  if (t === 'stamp' && tool.prefab) {
    let p;
    if (hit.ground) p = [Math.round(hit.p[0]), Math.round(hit.p[1]), hit.p[2]];
    else { const hp = W.pos(hit.id), hs = W.size(hit.id); p = [Math.round(hit.p[0]), Math.round(hit.p[1]), hit.f === 0 ? hp[2] + hs : hp[2]]; }
    const pf = prefabs.byName[tool.prefab];
    const [sx, sy] = tool.rot % 2 ? [pf.size[1], pf.size[0]] : [pf.size[0], pf.size[1]];
    return [{ k: 'stamp', name: tool.prefab, p, rot: tool.rot }, [[p[0] - 0.5, p[1] - 0.5, p[2], 1]], `${pf.label}: ${sx.toFixed(0)} × ${sy.toFixed(0)}`];
  }
  return null;
}
const CUR_RGB = { mine: [255, 210, 90], fell: [255, 120, 80], block: [140, 240, 220], stamp: [200, 160, 255] };

function act(op) {
  const tic = performance.now();
  const n = W.run(op, sink, prefabs);
  flush();
  if (n) { save(); status(`${opText(op)}: ${n.toLocaleString()} voxels · ${(performance.now() - tic).toFixed(0)} ms · ${W.ops.length} edits (not saved to the world yet)`); }
  else status('Nothing there to change.');
}
const opText = (op) => ({ mine: 'Mined', fell: 'Felled', block: 'Placed a block', stamp: `Stamped ${prefabs?.byName[op.name]?.label}` }[op.k]);

// ------------------------------------------------------------- saving: this browser, and world/edits/dayN.json
const KEY = `realm-edits-day${DAYN}`;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ day: DAYN, saved: Date.now(), ops: W.ops })); } catch { /* storage full or blocked */ }
  dirtyWorld = true;
  $('g-save').textContent = 'Save to world *';
}
let dirtyWorld = false;
async function saveWorld() {
  try {
    const r = await fetch(`api/edits?day=${DAYN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: DAYN, saved: Date.now(), source: `${typeof DAYN === "number" ? "day" + DAYN : DAYN} exported ${M.generated}`, ops: W.ops }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    dirtyWorld = false;
    $('g-save').textContent = 'Save to world';
    status(`Saved ${j.ops} edits to ${j.saved}.`);
  } catch (err) {
    status(`Could not save to the world (${err.message}); the edits are kept in this browser. Run python viewer/serve.py.`);
  }
}
async function loadSaved() {
  let doc = null;
  try { const r = await fetch(`api/edits?day=${DAYN}`, { cache: 'no-cache' }); if (r.ok) doc = await r.json(); } catch { /* served without the API */ }
  let local = null;
  try { local = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* none */ }
  if (local && (!doc || !doc.ops?.length || (local.saved || 0) > (doc.saved || 0))) doc = local;
  if (doc?.ops?.length) {
    const tic = performance.now();
    W.replay(doc.ops, sink, prefabs);
    flush();
    status(`Loaded ${W.ops.length} edits (${(performance.now() - tic).toFixed(0)} ms).`);
  } else status(prefabs ? 'Pick a tool. Drag still turns the camera.' : 'No stamps found: run python viewer/export.py.');
}
function undo() {
  if (!W.ops.length) return;
  W.replay(W.ops.slice(0, -1), sink, prefabs);
  flush(); save();
  status(`Undone. ${W.ops.length} edits.`);
}

// ------------------------------------------------------------- panel
const tools = [['look', '✋ Look', 'Camera only (1)'], ['mine', '⛏ Pickaxe', 'Break blocks (2)'], ['fell', '🪓 Axe', 'Fell a whole tree, rock, house or castle (3)'],
  ['block', '🧱 Block', 'Place a block next to the one you click (4); Alt-click copies a colour'], ['stamp', '🏰 Stamp', 'Put down a castle, house, tree… (5); X turns it']];
const bar = $('g-tools');
for (const [k, label, title] of tools) {
  const b = document.createElement('button');
  b.className = 'ghost'; b.dataset.tool = k; b.textContent = label; b.title = title;
  b.addEventListener('click', () => setTool(k));
  bar.appendChild(b);
}
function setTool(k) {
  tool.name = k; view.tool = k;
  for (const b of bar.children) b.classList.toggle('on', b.dataset.tool === k);
  for (const el of document.querySelectorAll('#game [data-for]')) el.hidden = el.dataset.for !== k;
  stage.classList.toggle('building', k !== 'look');
  curMesh.visible = false; API.markDirty();
}
$('g-brush').addEventListener('input', (e) => { tool.brush = +e.target.value; $('g-brush-n').textContent = tool.brush === 1 ? '1 block' : `radius ${tool.brush}`; });
$('g-bsize').addEventListener('change', (e) => { tool.bsize = +e.target.value; });
$('g-color').addEventListener('input', (e) => { tool.color = hexToRgb(e.target.value); });
const SWATCH = [['stone', '#b4aa9a'], ['dark stone', '#6e6a64'], ['wood', '#8c5c36'], ['plank', '#a67648'], ['roof red', '#b04a36'],
  ['roof blue', '#3a58a0'], ['grass', '#5a9a46'], ['leaf', '#3e7a38'], ['sand', '#d8c08a'], ['water', '#3cc8c0'], ['gold', '#e8b830'], ['white', '#ece6da']];
for (const [name, hex] of SWATCH) {
  const b = document.createElement('button');
  b.className = 'swatch'; b.title = name; b.style.background = hex;
  b.addEventListener('click', () => { tool.color = hexToRgb(hex); $('g-color').value = hex; });
  $('g-swatches').appendChild(b);
}
const pfSel = $('g-prefab');
for (const p of prefabs?.list || []) { const o = document.createElement('option'); o.value = p.name; o.textContent = p.label; pfSel.appendChild(o); }
pfSel.addEventListener('change', () => { tool.prefab = pfSel.value; });
$('g-rot').addEventListener('click', () => { tool.rot = (tool.rot + 1) % 4; $('g-rot').textContent = `Turn (X) · ${tool.rot * 90}°`; });
$('g-undo').addEventListener('click', undo);
$('g-save').addEventListener('click', saveWorld);
$('g-clear').addEventListener('click', () => {
  if (!W.ops.length || !confirm(`Remove all ${W.ops.length} edits and go back to the world as exported?`)) return;
  W.reset(sink); flush(); save(); status('All edits cleared (save to the world to keep it that way).');
});
window.addEventListener('beforeunload', (e) => { if (dirtyWorld) e.preventDefault(); });

// ------------------------------------------------------------- mouse and keys
let down = null, hoverQueued = false, lastMove = null;
stage.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
stage.addEventListener('pointerup', (e) => {
  if (!down || tool.name === 'look' || down.b !== 0 || e.target.closest('.label, button')) { down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return;                            // that was a camera drag
  const hit = pick(e);
  if (e.altKey && hit && !hit.ground) {              // eyedropper
    tool.color = W.color(hit.id); $('g-color').value = rgbToHex(tool.color);
    status(`Colour picked: ${rgbToHex(tool.color)}`);
    return;
  }
  const tg = target(hit);
  if (tg) act(tg[0]);
  hover(e);
});
function hover(e) {
  const tg = tool.name === 'look' ? null : target(pick(e));
  if (!tg) { if (curMesh.visible) { curMesh.visible = false; API.markDirty(); } return; }
  showCursor(tg[1], CUR_RGB[tool.name]);
  if (tg[2]) $('g-hover').textContent = tg[2];
}
stage.addEventListener('pointermove', (e) => {
  lastMove = e;
  if (tool.name === 'look' || down || hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => { hoverQueued = false; if (lastMove) hover(lastMove); });
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveWorld(); return; }
  const i = '12345'.indexOf(e.key);
  if (i >= 0) { setTool(tools[i][0]); return; }
  if (e.key.toLowerCase() === 'x' && tool.name === 'stamp') { $('g-rot').click(); if (lastMove) hover(lastMove); }
  if (e.key === ']') { $('g-brush').value = Math.min(6, tool.brush + 1); $('g-brush').dispatchEvent(new Event('input')); }
  if (e.key === '[') { $('g-brush').value = Math.max(1, tool.brush - 1); $('g-brush').dispatchEvent(new Event('input')); }
});

setTool('look');
await loadSaved();
window.__game = { W, sink, prefabs, tool, setTool, act, pick, target, flush };
