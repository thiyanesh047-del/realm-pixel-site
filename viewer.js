// realm.pixels world viewer: draws data/dayN/ (written by export.py from the day's own engine) with the reel's look.
// game.js builds on it (exports `API` at the end): tools that mine, fell, place blocks and stamp buildings.
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import * as S from './shaders.js';

const $ = (id) => document.getElementById(id);
const rad = (d) => d * Math.PI / 180;
const H = 960;                                     // engine rows (reel frame 540 x 960, shown x2 in the reels)
const FRAME_W = 540;
const REC = 16;                                    // bytes per voxel in voxels.bin

// ------------------------------------------------------------- loading
async function fetchBuf(url, label, onProgress) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  // content-length is the size on the wire: with gzip (GitHub Pages) the body we read is larger, so it only drives the
  // progress bar; the bytes are collected in chunks and joined at the end
  const total = +r.headers.get('content-length') || 0;
  const gz = /gzip|br|deflate/.test(r.headers.get('content-encoding') || '');
  if (!r.body || !onProgress) return r.arrayBuffer();
  const rd = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(Math.min(0.99, gz ? got / (total * 3) : got / total), label);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  onProgress(1, label);
  return out.buffer;
}
const bar = $('load-bar'), loadText = $('load-text');
const progress = (f, label) => { bar.style.transform = `scaleX(${f})`; loadText.textContent = `Loading ${label} ${Math.round(f * 100)} %`; };

const hashParams = () => new URLSearchParams(location.hash.slice(1));
const INDEX = await (await fetch('data/days.json', { cache: 'no-cache' })).json();
const wantDay = hashParams().get('day');                // a day number, or a scene's id (e.g. hoard)
const DAYN = (INDEX.days.find((d) => String(d.n) === wantDay) || { n: INDEX.latest }).n;
const DIR = typeof DAYN === 'number' ? `data/day${DAYN}/` : `data/${DAYN}/`;
const NAME = typeof DAYN === 'number' ? `Day ${DAYN}` : (INDEX.days.find((d) => d.n === DAYN)?.title || DAYN);
const M = await (await fetch(DIR + 'manifest.json', { cache: 'no-cache' })).json();
const vbuf = await fetchBuf(DIR + 'voxels.bin', `${NAME}: ${(M.n_voxels / 1e6).toFixed(2)} M voxels`, progress);
const gbuf = new Uint8Array(await fetchBuf(DIR + 'ground.bin'));
const rbuf = new Uint8Array(await fetchBuf(DIR + 'riverd.bin'));
loadText.textContent = 'Building faces…';
await new Promise((r) => setTimeout(r, 0));

// one record per voxel -> one instance per exposed face (as glr.Renderer.face_instances)
const POP = Array.from({ length: 64 }, (_, i) => [0, 1, 2, 3, 4, 5].reduce((s, b) => s + ((i >> b) & 1), 0));
function expand(part, buf = vbuf, keep = null) {
  const u16 = new Uint16Array(buf, part.offset * REC, part.count * REC / 2);
  const u8 = new Uint8Array(buf, part.offset * REC, part.count * REC);
  let nf = 0;
  for (let i = 0; i < part.count; i++) if (!keep || keep[i]) nf += POP[u8[i * REC + 9] & 63];
  const pos = new Uint16Array(nf * 3), col = new Uint8Array(nf * 4), misc = new Uint8Array(nf * 4);
  let j = 0;
  for (let i = 0; i < part.count; i++) {
    if (keep && !keep[i]) continue;
    const b = i * REC, fl = u8[b + 9], kind = (u8[b + 10] & 7) << 3, w = i * REC / 2;
    for (let f = 0; f < 6; f++) {
      if (!(fl & (1 << f))) continue;
      pos[j * 3] = u16[w]; pos[j * 3 + 1] = u16[w + 1]; pos[j * 3 + 2] = u16[w + 2];
      col[j * 4] = u8[b + 6]; col[j * 4 + 1] = u8[b + 7]; col[j * 4 + 2] = u8[b + 8]; col[j * 4 + 3] = f | kind;
      misc[j * 4] = u8[b + 11]; misc[j * 4 + 1] = u8[b + 12]; misc[j * 4 + 2] = u8[b + 13];
      j++;
    }
  }
  return { pos, col, misc, nf };
}

// moving things for the Motion buttons (export_motion.py): the dragon's flight, the hunchback, the black hole (Day 3)
let MO = null, mbuf = null;
try {
  const r = await fetch(`data/motion/world_day${DAYN}.json`, { cache: 'no-cache' });
  if (r.ok) { MO = await r.json(); mbuf = await fetchBuf(`data/motion/world_day${DAYN}.bin`, 'motion', progress); }
} catch (e) { MO = null; }

// ------------------------------------------------------------- renderer and shared uniforms
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.autoClear = false;
if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures (EXT_color_buffer_float).');
const cam0 = new THREE.Camera();
const L = M.light;
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// environments: the reel's own at its last moment, plus the day script's NIGHT / DAWN / DAY when it has them
const DAY_PREVIEW = { amb: [0.5, 0.55, 0.64], sun: [0.95, 0.893, 0.779], el: rad(42), sky_low: [0.74, 0.85, 0.95], sky_top: [0.3, 0.54, 0.86],
  bg: [0.62, 0.74, 0.86], fog: [0.74, 0.85, 0.95], wglow: 0, em_k: 0.45, gk: 0.92, shade_k: 0.55, stars: 0 };   // day3.DAY's values
const ENVS = { reel: M.env, ...M.envs };
if (!ENVS.day) ENVS.day = { ...DAY_PREVIEW, preview: true };
const SPRITE = { night: [0.6855, 0.7347, 0.6897], day: [1.26, 1.2, 1.11] };          // engine.make_env light on sprites
const HAZE = { night: [26 / 255, 30 / 255, 56 / 255], day: [220 / 255, 204 / 255, 166 / 255] };

function dataTex(arr, fmt) {
  const t = new THREE.DataTexture(arr, M.world, M.world, fmt, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const texGround = dataTex(gbuf, THREE.RGBAFormat);
const texRiver = dataTex(rbuf, THREE.RedFormat);
const texSprites = M.sprites.length ? await new THREE.TextureLoader().loadAsync(DIR + 'sprites.png?' + M.generated)
  : new THREE.DataTexture(new Uint8Array(4), 1, 1);   // a scene with no flat sprites (the hoard hall) has no atlas
texSprites.flipY = false; texSprites.minFilter = texSprites.magFilter = THREE.NearestFilter; texSprites.needsUpdate = true;

const SRES = M.shadow.res;
const smRT = new THREE.WebGLRenderTarget(SRES, SRES, { depthBuffer: true });
smRT.depthTexture = new THREE.DepthTexture(SRES, SRES, THREE.FloatType);
smRT.depthTexture.minFilter = smRT.depthTexture.magFilter = THREE.NearestFilter;

function lightMatrix(az, el) {                       // export.light_matrix / glr._light_matrix
  const Lv = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
  const f = Lv.map((x) => -x);
  let r = [f[1] * 1 - 0, 0 - f[0] * 1, 0];          // cross(f, z)
  const rn = Math.hypot(...r); r = r.map((x) => x / rn);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const corners = [];
  for (const x of [0, M.world]) for (const y of [0, M.world]) for (const z of [-60, 160]) corners.push([x, y, z]);
  const m = new THREE.Matrix4();
  const e = m.elements;                              // column-major
  let bias = 0;
  [r, u, f].forEach((axis, row) => {
    const p = corners.map((c) => dot(c, axis));
    const lo = Math.min(...p), hi = Math.max(...p), s = 2 / (hi - lo);
    e[row] = axis[0] * s; e[4 + row] = axis[1] * s; e[8 + row] = axis[2] * s; e[12 + row] = -lo * s - 1;
    if (row === 2) bias = 1.5 / (hi - lo);
  });
  e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
  return { m, bias };
}

const glows = L.glows.slice(0, 8);
const U = {
  cam_c: { value: new THREE.Vector2() }, cam_cs: { value: 1 }, cam_sn: { value: 0 }, cam_ca: { value: 1 }, cam_sa: { value: 0 },
  cam_zoom: { value: 1 }, cam_D: { value: 1e7 }, cam_fy: { value: 0.6 }, W: { value: FRAME_W }, H: { value: H },
  AMB: { value: new THREE.Vector3() }, MOON: { value: new THREE.Vector3() }, SPILL: { value: v3(L.SPILL) }, WARM: { value: v3(L.WARM) },
  FOAM: { value: v3(L.FOAM) }, WATERC: { value: v3(L.WATER) }, MOON_EL: { value: 0.7 },
  moon_dir: { value: new THREE.Vector2(Math.cos(L.MOON_AZ), Math.sin(L.MOON_AZ)) },
  river_d: { value: texRiver },
  glows: { value: Array.from({ length: 8 }, (_, i) => (glows[i] ? new THREE.Vector4(glows[i][0], glows[i][1], glows[i][2], glows[i][4]) : new THREE.Vector4())) },
  glow_r: { value: Array.from({ length: 8 }, (_, i) => (glows[i] ? glows[i][3] : 1)) }, n_glows: { value: glows.length },
  fire_pos: { value: new THREE.Vector3(L.FIRE[0], L.FIRE[1], 0) }, fire_k: { value: L.fire }, t: { value: M.t },
  day: { value: 0 }, wglow: { value: 1 }, em_k: { value: 1 }, gk: { value: 0.62 }, shade_k: { value: 0.6 }, style: { value: M.style },
  shadow_map: { value: smRT.depthTexture }, light_m: { value: new THREE.Matrix4() }, shadow_bias: { value: 0 },
  cam_right: { value: new THREE.Vector2(1, 0) }, water_speed: { value: L.water_speed }, RY: { value: M.land.RY },
  q: { value: M.q }, res: { value: 1 }, t_fire: { value: M.t }, t_sky: { value: M.t },
  xf_on: { value: 0 }, xf: { value: new THREE.Vector4() }, xf_pitch: { value: 0 }, xf_hz: { value: 0 },
};
const raw = (vs, fs, uniforms, extra = {}) => new THREE.RawShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3, side: THREE.DoubleSide, ...extra });
const sphere = new THREE.Sphere(new THREE.Vector3(400, 400, 0), 1e5);
const quadCorners = () => { const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3)); g.setIndex([0, 1, 2, 2, 1, 3]); g.boundingSphere = sphere; return g; };

// ------------------------------------------------------------- scenes
const sceneShadow = new THREE.Scene(), sceneMain = new THREE.Scene();
let nFaces = 0;
// per exported part, where each voxel's faces are drawn (the scene may be split into the motion pieces): the game
// (game.js) hides a voxel's face f as instance voxFirst[i] + rank of geometry geoms[voxGeom[i]]
const partFaces = M.parts.map((p) => ({ geoms: [], voxGeom: new Int16Array(p.count).fill(-1), voxFirst: new Uint32Array(p.count) }));
function register(k, part, keep, g) {
  const pf = partFaces[k], gi = pf.geoms.push(g) - 1, u8 = new Uint8Array(vbuf, part.offset * REC, part.count * REC);
  let nf = 0;
  for (let i = 0; i < part.count; i++) {
    if (keep && !keep[i]) continue;
    pf.voxGeom[i] = gi; pf.voxFirst[i] = nf; nf += POP[u8[i * REC + 9] & 63];
  }
}
const faceMat = raw(S.FACE_VS, S.FACE_FS, U, { depthFunc: THREE.LessDepth });
const shadowMat = raw(S.SHADOW_VS, S.SHADOW_FS, U);
function addFaces(d, fm = faceMat, sm = shadowMat, visible = true) {
  nFaces += d.nf;
  const g = quadCorners();
  g.setAttribute('aPos', new THREE.InstancedBufferAttribute(d.pos, 3));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(d.col, 4));
  g.setAttribute('aMisc', new THREE.InstancedBufferAttribute(d.misc, 4));
  g.instanceCount = d.nf;
  const face = new THREE.Mesh(g, fm), shad = new THREE.Mesh(g, sm);
  face.frustumCulled = shad.frustumCulled = false;
  face.renderOrder = 1;
  face.visible = shad.visible = visible;
  sceneMain.add(face);
  sceneShadow.add(shad);
  return { face, shad, show(v) { face.visible = shad.visible = v; } };
}
const frozen = {};                                   // the reel's still copy of each moving thing (hidden while it moves)
for (const [k, part] of M.parts.entries()) {
  if (!MO || part.name !== 'scene') { register(k, part, null, addFaces(expand(part)).face.geometry); continue; }
  const u16 = new Uint16Array(vbuf, part.offset * REC, part.count * REC / 2), u8 = new Uint8Array(vbuf, part.offset * REC, part.count * REC);
  const rest = new Uint8Array(part.count).fill(1);
  for (const m of MO.meshes) {
    const h = m.hide, mask = new Uint8Array(part.count);
    for (let i = 0; i < part.count; i++) {
      if (!rest[i] || u8[i * REC + 13] !== h.size) continue;
      if (h.near && Math.hypot(u16[i * 8] / M.q - 64 - h.near[0], u16[i * 8 + 1] / M.q - 64 - h.near[1]) > h.r) continue;
      mask[i] = 1; rest[i] = 0;
    }
    frozen[m.name] = addFaces(expand(part, vbuf, mask));
    register(k, part, mask, frozen[m.name].face.geometry);
  }
  register(k, part, rest, addFaces(expand(part, vbuf, rest)).face.geometry);
}
const moving = {};                                   // per moving thing: its frames and its own transform uniforms
for (const m of MO ? MO.meshes : []) {
  const xu = { xf_on: { value: m.local ? 1 : 0 }, xf: { value: new THREE.Vector4() }, xf_pitch: { value: 0 }, xf_hz: { value: 0 } };
  const fm = raw(S.FACE_VS, S.FACE_FS, { ...U, ...xu }, { depthFunc: THREE.LessDepth }), sm = raw(S.SHADOW_VS, S.SHADOW_FS, { ...U, ...xu });
  moving[m.name] = { info: m, xu, frames: m.frames.map((f) => addFaces(expand(f, mbuf), fm, sm, false)) };
}

const quad = new THREE.PlaneGeometry(2, 2);
const groundU = {
  ...U, ground_tex: { value: texGround }, horizon: { value: null }, cliff_x0: { value: M.land.CLIFF_X0 }, low: { value: M.land.LOW },
  persp: { value: 1 }, orbit: { value: 0 }, frame_x0: { value: 0 }, crack_k: { value: L.crack_k }, scar_k: { value: L.scar_k },
  stars: { value: 1 }, low_fall_r: { value: L.low_fall_r }, SKY_LOW: { value: new THREE.Vector3() }, SKY_TOP: { value: new THREE.Vector3() },
  BG: { value: new THREE.Vector3() }, sun_px: { value: new THREE.Vector2(-999, -999) }, fall_foot: { value: new THREE.Vector2(...L.fall_foot) },
  mode: { value: 1 },
};
const fullscreen = (mat, order = 0) => { const m = new THREE.Mesh(quad, mat); m.frustumCulled = false; m.renderOrder = order; const sc = new THREE.Scene(); sc.add(m); return { m, sc }; };
const ground = new THREE.Mesh(quad, raw(S.QUAD_VS, S.GROUND_FS, groundU, { depthFunc: THREE.LessEqualDepth }));
ground.frustumCulled = false; ground.renderOrder = 0;
if (!M.interior) sceneMain.add(ground);              // underground scenes have no ground plane and no sky
const sceneMask = fullscreen(raw(S.QUAD_VS, S.GROUND_FS, { ...groundU, mode: { value: 0 } }, { depthTest: false, depthWrite: false })).sc;
const horU = { mask: { value: null }, res: U.res, H: U.H };
const sceneHor = fullscreen(raw(S.QUAD_VS, S.HORIZON_FS, horU, { depthTest: false, depthWrite: false })).sc;

// sprites
const spriteU = { ...U, sprites: { value: texSprites }, atlas: { value: new THREE.Vector2(M.atlas[0], M.atlas[1]) },
  sprite_k: { value: v3(L.sprite_k) }, haze: { value: v3(L.haze) } };
if (M.sprites.length) {
  const sp = M.sprites, g = quadCorners();
  g.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(new Float32Array(sp.flatMap((s) => [s.x, s.y, s.h])), 3));
  g.setAttribute('aRect', new THREE.InstancedBufferAttribute(new Float32Array(sp.flatMap((s) => s.rect)), 4));
  g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(sp.flatMap((s) => [s.scale, s.emissive ? 1 : 0, s.frame, s.frames])), 4));
  g.instanceCount = sp.length;
  const m = new THREE.Mesh(g, raw(S.SPRITE_VS, S.SPRITE_FS, spriteU, { depthFunc: THREE.LessDepth }));
  m.frustumCulled = false; m.renderOrder = 2;
  sceneMain.add(m);
}
// particles recorded at the reel's last moment (wisps, mist)
if (M.splats.length) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(M.splats.flatMap((s) => s.slice(0, 3)), 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(M.splats.flatMap((s) => s.slice(3, 6)), 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(M.splats.flatMap((s) => s.slice(6, 8)), 2));
  var splats = new THREE.Points(g, raw(S.SPLAT_VS, S.SPLAT_FS, U, { depthFunc: THREE.LessDepth, depthWrite: false }));
  splats.frustumCulled = false; splats.renderOrder = 3;
  sceneMain.add(splats);
}

// post
const rtOpt = (extra = {}) => ({ type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, ...extra });
const mainRT = new THREE.WebGLRenderTarget(1, 1, rtOpt({ count: 3, depthBuffer: true }));
const maskRT = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
const horRT = new THREE.WebGLRenderTarget(1, 1, rtOpt());
const fogRT = new THREE.WebGLRenderTarget(1, 1, rtOpt({ count: 3 }));
const blurA = new THREE.WebGLRenderTarget(1, 1, rtOpt()), blurB = new THREE.WebGLRenderTarget(1, 1, rtOpt());
const b3RT = new THREE.WebGLRenderTarget(1, 1, rtOpt()), b10RT = new THREE.WebGLRenderTarget(1, 1, rtOpt()), sky3RT = new THREE.WebGLRenderTarget(1, 1, rtOpt());
groundU.horizon.value = horRT.texture;
horU.mask.value = maskRT.texture;
const post = (fs, u) => fullscreen(raw(S.QUAD_VS, fs, u, { depthTest: false, depthWrite: false })).sc;
const fogU = { t_col: { value: mainRT.textures[0] }, t_em: { value: mainRT.textures[1] }, t_z: { value: mainRT.textures[2] },
  persp: { value: 1 }, sa: { value: 1 }, stars: { value: 1 }, FOG: { value: new THREE.Vector3() }, style: U.style };
const boxU = { src: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, r: { value: 3 } };
const compU = { t_img: { value: fogRT.textures[0] }, t_ez: { value: fogRT.textures[1] }, t_b3: { value: b3RT.texture }, t_b10: { value: b10RT.texture },
  t_sky3: { value: sky3RT.texture }, style: U.style, stars: { value: 1 } };
const sceneFog = post(S.FOG_FS, fogU), sceneBox = post(S.BOX_FS, boxU), sceneComp = post(S.COMPOSE_FS, compU);

// ------------------------------------------------------------- camera state (span.cam parameters)
const pickShot = M.shots.filter((s) => !s.label.startsWith('CANON'));
const last = pickShot[pickShot.length - 1] || { orbit: 38, zoom: 1.5, tilt: 60, cx: M.C[0], cy: M.C[1], fy: 0.6, persp: 1 };
const cam = { orbit: last.orbit, zoom: last.zoom, tilt: last.tilt, cx: last.cx, cy: last.cy, fy: last.fy, persp: last.persp };
const view = { res: 1, env: 'reel', animate: false, t: M.t, Weng: FRAME_W, labels: { villager: true, build: true, place: false },
  safe: true, cover: false, outside: true, sel: null, tool: 'look' };

function derived(c) {
  const a = rad(c.tilt), th = rad(c.orbit);
  const D = Math.min(1 / Math.max(c.persp * c.zoom / 1400, 1e-7), 1e7);
  return { cx: c.cx, cy: c.cy, z: c.zoom, fy: c.fy, ca: Math.cos(a), sa: Math.sin(a), cs: Math.cos(th), sn: Math.sin(th), D, persp: c.persp };
}
function project(d, x, y, h) {                       // engine.project, in engine pixels of the wide canvas
  const dx = x - d.cx, dy = y - d.cy;
  const rx = d.cs * dx + d.sn * dy, ry = -d.sn * dx + d.cs * dy;
  const dz = ry * d.sa + h * d.ca;
  const sc = d.D / Math.max(d.D - dz, 1e-3);
  return { sx: view.Weng / 2 + d.z * rx * sc, sy: H * d.fy + d.z * (ry * d.ca - h * d.sa) * sc, dz, sc };
}
function groundAt(d, px, py) {                       // inverse for the plateau (h = 0): the ground point under a pixel
  const u = (px - view.Weng / 2) / d.z, v = (py - H * d.fy) / d.z;
  const den = d.D * d.ca + v * d.sa;
  if (den <= 1e-6) return null;
  const ry = v * d.D / den;
  const sc = d.D / Math.max(d.D - ry * d.sa, 1e-6);
  const rx = u / sc;
  return [d.cx + d.cs * rx - d.sn * ry, d.cy + d.sn * rx + d.cs * ry];
}

let shadowKey = '';
function applyEnv() {
  const e = ENVS[view.env] || ENVS.reel;
  U.AMB.value.fromArray(e.amb); U.MOON.value.fromArray(e.sun); U.MOON_EL.value = e.el;
  U.wglow.value = e.wglow; U.em_k.value = e.em_k; U.gk.value = e.gk; U.shade_k.value = e.shade_k; U.day.value = e.stars < 0.5 ? 1 : 0;
  groundU.stars.value = e.stars; fogU.stars.value = e.stars; compU.stars.value = e.stars;
  groundU.SKY_LOW.value.fromArray(e.sky_low); groundU.SKY_TOP.value.fromArray(e.sky_top); groundU.BG.value.fromArray(e.bg);
  fogU.FOG.value.fromArray(e.fog);
  const reel = view.env === 'reel';
  U.fire_k.value = reel ? L.fire : 1.3 * e.wglow + (M.style === 1 ? 0.3 : 0);
  const k = e.stars < 0.5 ? 'day' : 'night';
  spriteU.sprite_k.value.fromArray(reel ? L.sprite_k : SPRITE[k]); spriteU.haze.value.fromArray(reel ? L.haze : HAZE[k]);
  if (typeof splats !== 'undefined') splats.visible = e.stars >= 0.5;
  const key = `${L.MOON_AZ}/${e.el}`;
  if (key !== shadowKey) {                           // the light moved: a new shadow map
    const lm = lightMatrix(L.MOON_AZ, e.el);
    U.light_m.value.copy(lm.m); U.shadow_bias.value = lm.bias;
    shadowKey = key; shadowDone = false;
  }
  $('env-note').textContent = e.preview ? 'Day 3\'s daylight values used as a preview; this day\'s reel has no daytime.' : '';
}

function setUniforms() {
  const d = derived(cam);
  U.cam_c.value.set(d.cx, d.cy); U.cam_cs.value = d.cs; U.cam_sn.value = d.sn; U.cam_ca.value = d.ca; U.cam_sa.value = d.sa;
  U.cam_zoom.value = d.z; U.cam_D.value = d.D; U.cam_fy.value = d.fy; U.W.value = view.Weng; U.t.value = view.t;
  U.cam_right.value.set(d.cs, d.sn); U.res.value = view.res;
  groundU.persp.value = cam.persp; groundU.orbit.value = cam.orbit; groundU.frame_x0.value = (view.Weng - FRAME_W) / 2;
  const e = ENVS[view.env] || ENVS.reel;
  groundU.sun_px.value.set(e.stars < 0.5 ? FRAME_W * 0.78 - (cam.orbit - 40) * 1.5 : -999, e.stars < 0.5 ? (L.sun_px[1] > 0 ? L.sun_px[1] : 120) : -999);
  fogU.persp.value = cam.persp; fogU.sa.value = d.sa;
  return d;
}

// ------------------------------------------------------------- sizing
const stage = $('stage');
let Wpx = 0, Hpx = 0;
function resize() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  view.Weng = Math.max(FRAME_W, Math.round(H * r.width / r.height / 2) * 2);
  Wpx = Math.round(view.Weng * view.res); Hpx = H * view.res;
  renderer.setSize(Wpx, Hpx, false);
  for (const rt of [mainRT, fogRT, blurA, blurB, b3RT, b10RT, sky3RT, maskRT]) rt.setSize(Wpx, Hpx);
  horRT.setSize(Wpx, 1);
  const s = Math.min(r.width / view.Weng, r.height / H);
  canvas.style.width = `${view.Weng * s}px`; canvas.style.height = `${H * s}px`;
  layoutOverlay();
  dirty = true;
}

// ------------------------------------------------------------- drawing
let dirty = true, shadowDone = false;
function blur(srcTex, dst, r) {
  let src = srcTex;
  for (let i = 0; i < 3; i++) {
    for (const [dir, out] of [[[1, 0], blurA], [[0, 1], i === 2 ? dst : blurB]]) {
      boxU.src.value = src; boxU.dir.value.set(dir[0], dir[1]); boxU.r.value = r;
      renderer.setRenderTarget(out); renderer.render(sceneBox, cam0);
      src = out.texture;
    }
  }
}
function draw() {
  const tic = performance.now();
  const d = setUniforms();
  if (!shadowDone) {                                  // nothing moves: one shadow map until the light changes
    renderer.setRenderTarget(smRT); renderer.setClearColor(0, 1); renderer.clear(true, true, false);
    renderer.render(sceneShadow, cam0);
    shadowDone = true;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(maskRT); renderer.clear(true, false, false); renderer.render(sceneMask, cam0);
  renderer.setRenderTarget(horRT); renderer.render(sceneHor, cam0);
  renderer.setRenderTarget(mainRT); renderer.clear(true, true, false); renderer.render(sceneMain, cam0);
  renderer.setRenderTarget(fogRT); renderer.render(sceneFog, cam0);
  blur(fogRT.textures[1], b3RT, 3 * view.res);
  blur(fogRT.textures[1], b10RT, 10 * view.res);
  if (M.style === 1) blur(fogRT.textures[2], sky3RT, 3 * view.res);
  renderer.setRenderTarget(null); renderer.clear(true, true, false); renderer.render(sceneComp, cam0);
  placeLabels(d);
  $('stat').textContent = `${(M.n_voxels / 1e6).toFixed(2)} M voxels · ${(nFaces / 1e6).toFixed(2)} M faces${stats.extra} · ${Wpx}×${Hpx} px · ${(performance.now() - tic).toFixed(0)} ms cpu`;
}
const stats = { extra: '' };
const motion = { water: false, fire: false, sky: false, dragon: false, hunchback: false, 'black hole': false };
const since = {};                                    // when each motion was switched on (performance.now ms)
const held = { water: 0, fire: 0, sky: 0 };          // clock value carried over when a motion is paused
function dragonPose(el) {
  // take off from the keep (2.5 s), then loop over the castle and the river, wings beating rib by rib
  const P = moving.dragon.info.perch, C = MO.castle;
  const a = el * 0.32, R = 78;
  const lx = C[0] + R * Math.cos(a) + 10, ly = C[1] + 0.8 * R * Math.sin(a) + 20, lz = 70 + 6 * Math.sin(el * 1.3);
  const vx = -R * Math.sin(a), vy = 0.8 * R * Math.cos(a);
  const u = Math.min(1, el / 2.5), e = u * u * (3 - 2 * u);
  const x = P[0] + (lx - P[0]) * e, y = P[1] + (ly - P[1]) * e, z = P[2] + (lz - P[2]) * e + 10 * Math.sin(Math.PI * u);
  const yaw = Math.atan2(vy, vx) * e + Math.atan2(ly - P[1], lx - P[0]) * (1 - e);
  return { x, y, z, yaw, pitch: 0.6 * e };
}
function tickMotion(now) {
  const el = (k) => (now - since[k]) / 1000;
  view.t = M.t + held.water + (motion.water ? el('water') : 0);
  U.t_fire.value = M.t + held.fire + (motion.fire ? el('fire') : 0);
  U.t_sky.value = M.t + held.sky + (motion.sky ? el('sky') : 0);
  let movers = false;
  for (const name of ['dragon', 'hunchback', 'black hole']) {
    const mv = moving[name];
    if (!mv) continue;
    const on = motion[name];
    frozen[name] && frozen[name].show(!on);
    const n = mv.frames.length, k = on ? Math.floor(el(name) * mv.info.fps) % n : -1;
    mv.frames.forEach((f, i) => f.show(i === k));
    if (!on) continue;
    movers = true;
    if (name === 'dragon') {
      const p = dragonPose(el(name));
      mv.xu.xf.value.set(p.x, p.y, p.z, p.yaw); mv.xu.xf_pitch.value = p.pitch; mv.xu.xf_hz.value = 13.75;
    } else if (name === 'hunchback') {
      const s0 = mv.info.start, ph = (el(name) * 0.08) % 2, fwd = ph < 1, d = fwd ? ph : 2 - ph;
      mv.xu.xf.value.set(s0[0] + 26 * d, s0[1], 0, fwd ? -Math.PI / 2 : Math.PI / 2);
    }
  }
  if (movers) shadowDone = false;                    // moving things cast moving shadows
}
function loop() {
  if (Object.values(motion).some(Boolean)) { tickMotion(performance.now()); dirty = true; }
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}
function setMotion(name, on) {
  const now = performance.now();
  if (on === motion[name]) return;
  if (!on && name in held) held[name] += (now - since[name]) / 1000;
  motion[name] = on; since[name] = now;
  tickMotion(now);
  for (const b of document.querySelectorAll('.mb')) b.classList.toggle('on', b.dataset.m === 'all' ? Object.values(motion).every(Boolean) : !!motion[b.dataset.m]);
  dirty = true;
}
for (const b of document.querySelectorAll('.mb')) {
  const m = b.dataset.m;
  if (m !== 'all' && !(m in held) && !moving[m]) { b.disabled = true; b.title = 'Not in this day\'s world'; continue; }
  b.addEventListener('click', () => {
    if (m === 'all') { const on = !Object.entries(motion).every(([k, v]) => v || (!(k in held) && !moving[k])); for (const k of Object.keys(motion)) if (k in held || moving[k]) setMotion(k, on); }
    else setMotion(m, !motion[m]);
  });
}

// ------------------------------------------------------------- overlay: frame, safe zones, labels
const ov = $('overlay');
function layoutOverlay() {
  const cr = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const s = cr.height / H, fx = cr.left - sr.left + (view.Weng - FRAME_W) / 2 * s, fy = cr.top - sr.top;
  const fw = FRAME_W * s, fh = H * s;
  Object.assign($('frame').style, { left: `${fx}px`, top: `${fy}px`, width: `${fw}px`, height: `${fh}px` });
  Object.assign($('dim-l').style, { left: `${cr.left - sr.left}px`, top: `${fy}px`, width: `${Math.max(0, fx - (cr.left - sr.left))}px`, height: `${fh}px` });
  Object.assign($('dim-r').style, { left: `${fx + fw}px`, top: `${fy}px`, width: `${Math.max(0, cr.right - sr.left - fx - fw)}px`, height: `${fh}px` });
  $('frame').classList.toggle('show-safe', view.safe);
  $('frame').classList.toggle('show-cover', view.cover);
  ov.classList.toggle('no-dim', !view.outside);
}
const labelEls = new Map();
for (const lb of M.labels) {
  const el = document.createElement('button');
  el.className = `label ${lb.kind}`;
  el.innerHTML = '<b></b><small></small>';
  el.querySelector('b').textContent = lb.text;
  el.querySelector('small').textContent = lb.sub || '';
  el.title = `${lb.text}${lb.sub ? ' · ' + lb.sub : ''}: click to centre`;
  el.addEventListener('click', (e) => { e.stopPropagation(); focusOn(lb); });
  ov.appendChild(el);
  labelEls.set(lb.id, { lb, el });
}
function placeLabels(d) {
  const cr = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const s = cr.height / H;
  const shown = [];
  for (const { lb, el } of labelEls.values()) {
    const on = view.labels[lb.kind] || view.sel === lb.id;
    const p = project(d, lb.pos[0], lb.pos[1], lb.pos[2]);
    const x = cr.left - sr.left + p.sx * s, y = cr.top - sr.top + p.sy * s;
    const vis = on && p.dz < d.D * 0.92 && p.sc > 0 && x > -40 && x < sr.width + 40 && y > -20 && y < sr.height + 20;
    el.style.display = vis ? '' : 'none';
    if (!vis) continue;
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    el.classList.toggle('sel', view.sel === lb.id);
    el.classList.toggle('far', cam.zoom < 2.5 && view.sel !== lb.id);
    shown.push({ lb, el, x, y, dz: p.dz });
  }
  // nearer labels and the selected one win; a label that would cover one already placed waits for a closer view
  shown.sort((a, b) => (b.lb.id === view.sel) - (a.lb.id === view.sel) || b.dz - a.dz);
  const boxes = [];
  for (const it of shown) {
    const w = it.el.offsetWidth, h = it.el.offsetHeight;
    const box = [it.x - w / 2, it.y - h, it.x + w / 2, it.y];
    const hit = boxes.some((o) => box[0] < o[2] - 4 && box[2] > o[0] + 4 && box[1] < o[3] - 2 && box[3] > o[1] + 2);
    if (hit && it.lb.id !== view.sel) { it.el.style.display = 'none'; continue; }
    boxes.push(box);
  }
}
function focusOn(lb) {
  view.sel = lb.id;
  cam.cx = lb.pos[0]; cam.cy = lb.pos[1];
  if (cam.zoom < 3.5) cam.zoom = lb.kind === 'villager' ? 6 : 3.5;
  changed();
}

// ------------------------------------------------------------- controls
const SL = [
  ['orbit', -180, 180, 0.5], ['zoom', Math.log(0.4), Math.log(16), 0.001, true], ['tilt', 10, 85, 0.5],
  ['cx', 0, 800, 0.5], ['cy', 0, 800, 0.5], ['fy', 0.2, 0.95, 0.01], ['persp', 0, 1, 0.01],
];
for (const [k, lo, hi, step, isLog] of SL) {
  const r = $(`s-${k}`), n = $(`n-${k}`);
  r.min = lo; r.max = hi; r.step = step;
  r.addEventListener('input', () => { cam[k] = isLog ? Math.exp(+r.value) : +r.value; changed(true); });
  n.addEventListener('change', () => { if (n.value !== '' && isFinite(+n.value)) { cam[k] = +n.value; changed(); } });
}
const fmt = (v, dp) => { const s = (+v).toFixed(dp); return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s; };
function syncInputs(skipSliders) {
  for (const [k, , , , isLog] of SL) {
    if (!skipSliders) $(`s-${k}`).value = isLog ? Math.log(cam[k]) : cam[k];
    if (document.activeElement !== $(`n-${k}`)) $(`n-${k}`).value = fmt(cam[k], k === 'zoom' || k === 'fy' || k === 'persp' ? 2 : 1);
  }
  $('keyline').value = keyLine();
}
function rel(v, base, name) { const d = v - base; return Math.abs(d) < 0.05 ? name : `${name} ${d < 0 ? '-' : '+'} ${fmt(Math.abs(d), 1)}`; }
function keyLine() {                                // a line in the day scripts' KEYS format
  const t = $('key-t').value || '0.0', ease = $('key-ease').value;
  const e = ease === 'None' ? 'None' : `"${ease}"`;
  return `(${t}, ${fmt(cam.orbit, 1)}, ${fmt(cam.zoom, 2)}, (${rel(cam.cx, M.C[0], 'CX0')}, ${rel(cam.cy, M.C[1], 'CY0')}), ${fmt(cam.fy, 2)}, ${e}, ${fmt(cam.tilt, 1)}, ${fmt(cam.persp, 2)}),`;
}
let hashTimer = 0;
function writeHash() {
  const h = `day=${DAYN}&cam=${[cam.orbit, cam.zoom, cam.tilt, cam.cx, cam.cy, cam.fy, cam.persp].map((v) => fmt(v, 3)).join(',')}` + (view.sel ? `&sel=${view.sel}` : '');
  history.replaceState(null, '', `#${h}`);
}
function changed(fromSlider) {
  cam.tilt = Math.min(85, Math.max(10, cam.tilt));
  cam.zoom = Math.min(16, Math.max(0.4, cam.zoom));
  cam.orbit = ((cam.orbit + 180) % 360 + 360) % 360 - 180;
  syncInputs(fromSlider);
  dirty = true;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 200);
}
function readHash() {
  const p = hashParams();
  const c = p.get('cam');
  if (c) {
    const v = c.split(',').map(Number);
    if (v.length >= 7 && v.every(isFinite)) [cam.orbit, cam.zoom, cam.tilt, cam.cx, cam.cy, cam.fy, cam.persp] = v;
  }
  view.sel = p.get('sel');
}

// day switch: a different day reloads with that day's data, keeping the camera
const daySel = $('day');
for (const d of INDEX.days) {
  const o = document.createElement('option');
  o.value = d.n;
  o.textContent = d.scene ? `${d.title} (scene, t = ${d.t} s)` : `Day ${d.n}${d.final ? '' : ' (in production)'} · end of reel, t = ${d.t} s`;
  daySel.appendChild(o);
}
daySel.value = DAYN;
daySel.addEventListener('change', () => {
  const p = hashParams(); p.set('day', daySel.value);
  location.hash = p.toString();
  location.reload();
});

// shots: the day script's KEYS (+ CANON's last camera)
const shotSel = $('shots');
M.shots.forEach((s, i) => {
  const o = document.createElement('option');
  o.value = i;
  o.textContent = `${s.label}  (orbit ${s.orbit}, zoom ${s.zoom}, tilt ${s.tilt}${s.persp ? ', persp ' + s.persp : ', iso'})`;
  shotSel.appendChild(o);
});
const lastIdx = M.shots.indexOf(last);
shotSel.addEventListener('change', () => {
  const s = M.shots[+shotSel.value];
  if (!s) return;
  Object.assign(cam, { orbit: s.orbit, zoom: s.zoom, tilt: s.tilt, cx: s.cx, cy: s.cy, fy: s.fy, persp: s.persp });
  $('key-t').value = s.t.toFixed(1);
  if (s.ease) $('key-ease').value = s.ease;
  changed();
});

// light
const envSel = $('env');
const envName = { reel: `as the reel ends (${M.env_is_day ? 'day' : 'night'})`, night: 'night', dawn: 'dawn', day: 'day' };
for (const k of Object.keys(ENVS)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = envName[k] + (ENVS[k].preview ? ' (preview)' : '');
  envSel.appendChild(o);
}
envSel.addEventListener('change', () => { view.env = envSel.value; applyEnv(); dirty = true; });

// toggles
const bindToggle = (id, fn) => { const el = $(id); el.addEventListener('change', () => { fn(el.checked); layoutOverlay(); dirty = true; }); fn(el.checked); };
bindToggle('t-vill', (v) => { view.labels.villager = v; });
bindToggle('t-build', (v) => { view.labels.build = v; });
bindToggle('t-place', (v) => { view.labels.place = v; });
bindToggle('t-safe', (v) => { view.safe = v; });
bindToggle('t-cover', (v) => { view.cover = v; });
bindToggle('t-outside', (v) => { view.outside = v; });
$('t-sharp').addEventListener('change', (e) => { view.res = e.target.checked ? 2 : 1; resize(); });
for (const id of ['key-t', 'key-ease']) $(id).addEventListener('input', () => { $('keyline').value = keyLine(); });
$('copy').addEventListener('click', async () => {
  const line = keyLine();
  try { await navigator.clipboard.writeText(line); } catch { $('keyline').select(); document.execCommand('copy'); }
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy camera key'; }, 1400);
});
$('reset').addEventListener('click', () => { shotSel.value = lastIdx; shotSel.dispatchEvent(new Event('change')); });
$('panel-toggle').addEventListener('click', () => { document.body.classList.toggle('panel-hidden'); setTimeout(resize, 220); });

// mouse: drag = pan (map style), right/ctrl-drag = orbit and tilt, wheel = zoom, double-click = centre on the ground there
// touch: one finger pans; two fingers pinch to zoom, twist to orbit, slide up/down together to tilt
const pts = new Map();                                // active pointers: id -> {x, y}
let drag = null, pinch = null;
stage.addEventListener('contextmenu', (e) => e.preventDefault());
function panBy(dx, dy) {
  const k = H / canvas.getBoundingClientRect().height, d = derived(cam);
  const a = dx * k / cam.zoom, b = dy * k / (cam.zoom * Math.max(d.ca, 0.2));
  cam.cx -= d.cs * a - d.sn * b;
  cam.cy -= d.sn * a + d.cs * b;
}
function twoFinger() {
  const [p, q] = [...pts.values()];
  return { d: Math.hypot(q.x - p.x, q.y - p.y), a: Math.atan2(q.y - p.y, q.x - p.x), my: (p.y + q.y) / 2, mx: (p.x + q.x) / 2 };
}
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.label, button')) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  stage.setPointerCapture(e.pointerId);
  if (pts.size === 2) { drag = null; pinch = twoFinger(); return; }
  drag = { x: e.clientX, y: e.clientY, orbit: e.button === 2 || e.button === 1 || e.ctrlKey || e.altKey };
});
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pts.size >= 2) {
    const n = twoFinger();
    if (pinch.d > 0) cam.zoom *= n.d / pinch.d;
    cam.orbit -= (n.a - pinch.a) * 180 / Math.PI;
    cam.tilt += (n.my - pinch.my) * 0.15;
    panBy(n.mx - pinch.mx, 0);
    pinch = n;
    changed();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.orbit) {
    cam.orbit -= dx * 0.3;
    cam.tilt += dy * 0.15;
  } else {
    panBy(dx, dy);
  }
  changed();
});
const lift = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 0) drag = null; };
stage.addEventListener('pointerup', lift);
stage.addEventListener('pointercancel', lift);
stage.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom *= Math.exp(-e.deltaY * 0.0012); changed(); }, { passive: false });
stage.addEventListener('dblclick', (e) => {
  if (view.tool !== 'look') return;                // building: double-clicks are two clicks of the tool
  const cr = canvas.getBoundingClientRect(), k = H / cr.height;
  const g = groundAt(derived(cam), (e.clientX - cr.left) * k, (e.clientY - cr.top) * k);
  if (g) { cam.cx = g[0]; cam.cy = g[1]; changed(); }
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const d = derived(cam), step = (e.shiftKey ? 120 : 40) / cam.zoom;      // hold Shift for big steps
  const pan = (a, b) => { cam.cx += d.cs * a - d.sn * b; cam.cy += d.sn * a + d.cs * b; };
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') pan(0, -step);
  else if (k === 's' || k === 'arrowdown') pan(0, step);
  else if (k === 'a' || k === 'arrowleft') pan(-step, 0);
  else if (k === 'd' || k === 'arrowright') pan(step, 0);
  else if (k === 'q') cam.orbit -= 5;
  else if (k === 'e') cam.orbit += 5;
  else if (k === 'r') cam.tilt += 2;
  else if (k === 'f') cam.tilt -= 2;
  else if (k === '+' || k === '=') cam.zoom *= 1.15;
  else if (k === '-') cam.zoom /= 1.15;
  else return;
  e.preventDefault();
  changed();
});

// ------------------------------------------------------------- go
$('meta').textContent = `${M.title} · world at t = ${M.t} s of the reel · exported ${M.generated.replace('T', ' ')}`;
shotSel.value = lastIdx;
readHash();
window.addEventListener('hashchange', () => { readHash(); changed(); });
applyEnv();
new ResizeObserver(resize).observe(stage);
resize();
changed();
$('loading').remove();
window.__viewer = { cam, view, M, project: (x, y, h) => project(derived(cam), x, y, h) };
loop();

export const API = {
  THREE, M, DAYN, vbuf, partFaces, faceMat, shadowMat, quadCorners, sceneMain, sceneShadow, cam, view, derived, H, canvas, stage,
  stats, markDirty: () => { dirty = true; }, invalidateShadow: () => { shadowDone = false; dirty = true; },
};
