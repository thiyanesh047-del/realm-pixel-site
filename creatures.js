// Creatures: every creature and figure of the world in a studio view, one screen each, with a button per motion.
// Data from export_motion.py: data/motion/creatures.json (frames per motion) + creatures.bin (12 bytes per voxel).
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

const $ = (id) => document.getElementById(id);
const J = await (await fetch('data/motion/creatures.json', { cache: 'no-cache' })).json();
const BUF = await (await fetch('data/motion/creatures.bin', { cache: 'no-cache' })).arrayBuffer();
const REC = J.record;

const canvas = $('gl'), stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const world = new THREE.Group();                     // the data is z-up; three.js is y-up
world.rotation.x = -Math.PI / 2;
scene.add(world);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);

// floor: a soft round pad under the creature
const pad = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  vertexShader: 'varying vec2 vU; void main() { vU = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'varying vec2 vU; void main() { float r = length(vU); gl_FragColor = vec4(0.16, 0.20, 0.36, 0.55 * (1.0 - smoothstep(0.55, 1.0, r))); }',
}));
world.add(pad);

const box = new THREE.BoxGeometry(1, 1, 1);
const VS = `
in vec3 iPos; in vec3 iCol; in float iEm; in float iAo;
uniform float size;
out vec3 vN; out vec3 vCol; out float vEm; out float vAo; out vec3 vLocal;
void main() {
  vN = normal; vCol = iCol; vEm = iEm; vAo = iAo; vLocal = position;
  vec3 p = iPos + position * size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FS = `
in vec3 vN; in vec3 vCol; in float vEm; in float vAo; in vec3 vLocal;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.75));        // key light from the front-left, above (z up, front = +y)
  float key = max(dot(n, L), 0.0);
  float sky = 0.55 + 0.25 * n.z;                      // fill from the sky, darker underneath
  vec3 e = abs(vLocal) * 2.0;                         // a soft bevel near each cube's edges: the studded look
  float edge = max(max(min(e.x, e.y), min(e.y, e.z)), min(e.x, e.z));
  float bevel = mix(1.0, 0.82, smoothstep(0.78, 1.0, edge));
  vec3 lin = pow(vCol, vec3(2.2));
  vec3 c = lin * (0.42 * sky + 0.95 * key) * (0.55 + 0.45 * vAo) * bevel + lin * vEm * 1.6;
  c = c / (1.0 + 0.25 * c);
  o = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;
const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, glslVersion: THREE.GLSL3, uniforms: { size: { value: 0.22 } } });

function frameMesh(f) {
  const i16 = new Int16Array(BUF, f.offset * REC, f.count * REC / 2), u8 = new Uint8Array(BUF, f.offset * REC, f.count * REC);
  const pos = new Float32Array(f.count * 3), col = new Uint8Array(f.count * 3), em = new Uint8Array(f.count), ao = new Uint8Array(f.count);
  for (let i = 0; i < f.count; i++) {
    const w = i * REC / 2, b = i * REC;
    pos[i * 3] = i16[w] / 32; pos[i * 3 + 1] = i16[w + 1] / 32; pos[i * 3 + 2] = i16[w + 2] / 32 + f.size / 2;
    col[i * 3] = u8[b + 6]; col[i * 3 + 1] = u8[b + 7]; col[i * 3 + 2] = u8[b + 8];
    em[i] = u8[b + 9] ? 255 : 0; ao[i] = Math.min(255, Math.round(u8[b + 10] / 200 * 255));
  }
  const g = new THREE.InstancedBufferGeometry();
  g.index = box.index; g.setAttribute('position', box.attributes.position); g.setAttribute('normal', box.attributes.normal);
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  g.setAttribute('iCol', new THREE.InstancedBufferAttribute(col, 3, true));
  g.setAttribute('iEm', new THREE.InstancedBufferAttribute(em, 1, true));
  g.setAttribute('iAo', new THREE.InstancedBufferAttribute(ao, 1, true));
  g.instanceCount = f.count;
  const m = new THREE.Mesh(g, mat.clone());
  m.material.uniforms.size.value = f.size;
  m.frustumCulled = false;
  m.visible = false;
  world.add(m);
  // bounds for framing
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < f.count; i++) for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  m.userData.bounds = { lo, hi };
  return m;
}

// ------------------------------------------------------------- state
const cache = new Map();                             // "creature/motion" -> meshes
const state = { c: null, m: null, playing: true, spin: false, speed: 1, t: 0, az: Math.PI - 0.6, el: 0.32, dist: 30, target: new THREE.Vector3() };   // az: front-left three-quarter view (front = +y)
let shown = null;
function meshes(c, m) {
  const key = `${c.id}/${m.name}`;
  if (!cache.has(key)) cache.set(key, m.frames.map(frameMesh));
  return cache.get(key);
}
function frameCreature(c) {
  const ms = meshes(c, c.motions[0]);
  const { lo, hi } = ms[0].userData.bounds;
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, h = hi[2] - lo[2];
  const r = Math.max(hi[0] - lo[0], hi[1] - lo[1], h);
  state.target.set(cx, h * 0.45, -cy);                 // y-up target (world group turns z-up into y-up)
  state.dist = r * 2.3 + 2;
  pad.position.set(cx, cy, 0.01);
  pad.scale.setScalar(Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 0.75 + 1.5);
}
function select(id) {
  const c = J.creatures.find((x) => x.id === id) || J.creatures[0];
  state.c = c;
  $('c-name').textContent = c.name;
  $('c-who').textContent = c.who;
  for (const a of document.querySelectorAll('#list a')) a.classList.toggle('on', a.dataset.id === c.id);
  const mb = $('motions');
  mb.innerHTML = '';
  for (const m of c.motions) {
    const b = document.createElement('button');
    b.className = 'mb';
    b.textContent = m.name;
    b.addEventListener('click', () => pick(m));
    mb.appendChild(b);
  }
  frameCreature(c);
  pick(c.motions.find((m) => m.frames.length > 1) || c.motions[0]);
}
function pick(m) {
  state.m = m; state.t = 0;
  for (const b of $('motions').children) b.classList.toggle('on', b.textContent === m.name);
  if (shown) shown.forEach((x) => (x.visible = false));
  shown = meshes(state.c, m);
  const n = m.frames.reduce((s, f) => s + f.count, 0);
  $('c-stat').textContent = `${m.frames.length} frame${m.frames.length > 1 ? 's' : ''} · ${(n / m.frames.length / 1000).toFixed(1)} K voxels a frame`;
}

// list (plain #name routing so a creature's screen can be linked)
const list = $('list');
for (const c of J.creatures) {
  const a = document.createElement('a');
  a.href = `#${c.id}`; a.dataset.id = c.id;
  a.innerHTML = `<b>${c.name}</b><small>${c.motions.map((m) => m.name).join(' · ')}</small>`;
  list.appendChild(a);
}
window.addEventListener('hashchange', () => select(location.hash.slice(1)));
select(location.hash.slice(1));

// controls
$('play').addEventListener('click', (e) => { state.playing = !state.playing; e.target.textContent = state.playing ? 'Pause' : 'Play'; e.target.classList.toggle('on', state.playing); });
$('spin').addEventListener('click', (e) => { state.spin = !state.spin; e.target.classList.toggle('on', state.spin); });
$('speed').addEventListener('input', (e) => { state.speed = +e.target.value; });
const pts = new Map();
let pinch = 0;
stage.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', (e) => {
  const p = pts.get(e.pointerId);
  if (!p) return;
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    const d0 = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX; p.y = e.clientY;
    const [c, d] = [...pts.values()];
    const d1 = Math.hypot(c.x - d.x, c.y - d.y);
    if (d0 > 0) state.dist *= d0 / d1;
    return;
  }
  state.az -= (e.clientX - p.x) * 0.008;
  state.el = Math.min(1.4, Math.max(-0.1, state.el + (e.clientY - p.y) * 0.006));
  p.x = e.clientX; p.y = e.clientY;
});
const lift = (e) => pts.delete(e.pointerId);
stage.addEventListener('pointerup', lift);
stage.addEventListener('pointercancel', lift);
stage.addEventListener('wheel', (e) => { e.preventDefault(); state.dist *= Math.exp(e.deltaY * 0.0012); }, { passive: false });

function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.playing) state.t += dt * state.speed;
  if (state.spin) state.az += dt * 0.5;
  const m = state.m;
  if (m && shown) {
    const k = m.frames.length > 1 ? Math.floor(state.t * m.fps) % m.frames.length : 0;
    shown.forEach((x, i) => (x.visible = i === k));
  }
  const tg = state.target;
  camera.position.set(tg.x + state.dist * Math.cos(state.el) * Math.sin(state.az), tg.y + state.dist * Math.sin(state.el), tg.z + state.dist * Math.cos(state.el) * Math.cos(state.az));
  camera.lookAt(tg);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
