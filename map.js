// The realm.pixels world map: the 2D pixel world (scenes/pixel2d/world.py) drawn on a canvas without smoothing,
// pan by dragging, zoom with the wheel, pinch or the buttons, find a house by handle. Data: viewer/data2d/.
(() => {
  const cv = document.getElementById('map');
  const ctx = cv.getContext('2d');
  const day = new Image();
  const night = new Image();
  let meta = null;
  let isNight = false;
  let view = { x: 950, y: 800, z: 4 };          // world art pixel at the screen centre; css px per art pixel
  let pin = null;
  let hover = null;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    cv.width = Math.round(innerWidth * dpr());
    cv.height = Math.round(innerHeight * dpr());
    draw();
  }

  function clampView() {
    if (!meta) return;
    view.z = Math.max(0.6, Math.min(28, view.z));
    view.x = Math.max(0, Math.min(meta.width, view.x));
    view.y = Math.max(0, Math.min(meta.height, view.y));
  }

  function toScreen(x, y) {
    return [(x - view.x) * view.z + innerWidth / 2, (y - view.y) * view.z + innerHeight / 2];
  }

  function toWorld(sx, sy) {
    return [(sx - innerWidth / 2) / view.z + view.x, (sy - innerHeight / 2) / view.z + view.y];
  }

  function label(text, x, y, strong) {
    const size = strong ? 13 : 11;
    ctx.font = `${size}px Silkscreen, monospace`;
    const w = ctx.measureText(text).width;
    const px = Math.round(x - w / 2 - 5), py = Math.round(y - size - 10);
    ctx.fillStyle = strong ? '#e5c23c' : 'rgba(36, 22, 12, .86)';
    ctx.fillRect(px, py, Math.ceil(w) + 10, size + 8);
    ctx.fillStyle = strong ? '#24160c' : '#fff6dc';
    ctx.fillText(text, px + 5, py + size + 2);
  }

  function draw() {
    const img = isNight ? night : day;
    const s = dpr();
    if (cv.width !== Math.round(innerWidth * s) || cv.height !== Math.round(innerHeight * s)) {
      cv.width = Math.round(innerWidth * s);                 // the pane can change size without a resize event
      cv.height = Math.round(innerHeight * s);
    }
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = isNight ? '#1c2232' : '#6c7c86';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    if (!meta || !img.complete || !img.naturalWidth) return;
    const [ox, oy] = toScreen(0, 0);
    ctx.drawImage(img, Math.round(ox), Math.round(oy), Math.round(meta.width * view.z), Math.round(meta.height * view.z));
    // names on the houses once they are big enough to read
    if (view.z >= 9) {
      const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(innerWidth, innerHeight);
      for (const h of meta.homes) {
        if (h.x < x0 - 20 || h.x > x1 + 20 || h.y < y0 - 20 || h.y > y1 + 20) continue;
        if (pin && h.handle === pin.handle) continue;
        const [sx, sy] = toScreen(h.x, h.y - 4);
        label('@' + h.handle, sx, sy, false);
      }
    } else if (hover) {
      const [sx, sy] = toScreen(hover.x, hover.y - 4);
      label('@' + hover.handle, sx, sy, false);
    }
    for (const p of [meta.castle, meta.structure, meta.church, meta.cityhall]) {
      if (view.z < 2.5) continue;
      const [sx, sy] = toScreen(p.x, p.y);
      label(p.name, sx, sy, false);
    }
    if (pin) {
      const [sx, sy] = toScreen(pin.x, pin.y - 4);
      label('@' + pin.handle, sx, sy, true);
      ctx.fillStyle = '#e5c23c';
      ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 10, 3, 6);
    }
  }

  function flyTo(x, y, z) {
    const from = { ...view }, to = { x, y, z: z || view.z };
    if (reduce) { view = to; clampView(); draw(); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e };
      clampView(); draw();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function find(q) {
    const out = document.getElementById('found');
    const key = q.trim().replace(/^@/, '').toLowerCase();
    if (!key) return;
    const h = meta.homes.find((v) => v.handle.toLowerCase() === key)
      || meta.homes.find((v) => v.handle.toLowerCase().startsWith(key))
      || meta.homes.find((v) => v.handle.toLowerCase().includes(key));
    if (!h) { out.textContent = `No house for @${key} yet. Follow @realm.pixels and one goes up in the next ring.`; return; }
    pin = h;
    out.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = '@' + h.handle;
    out.append(b, h.where ? ` lives in ${h.where}.` : ` lives in ring ${h.ring}, counted from the castle.`);
    flyTo(h.x, h.y, 12);
  }

  // dragging, wheel and pinch
  const pts = new Map();
  let last = null, pinch0 = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    cv.classList.add('drag');
    last = [e.clientX, e.clientY];
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: view.z };
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) {
      if (!meta || view.z >= 9) return;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      let best = null, bd = 64 / view.z;
      for (const h of meta.homes) {
        const d = Math.hypot(h.x - wx, h.y - wy);
        if (d < bd) { bd = d; best = h; }
      }
      if (best !== hover) { hover = best; draw(); }
      return;
    }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2 && pinch0) {
      const [a, b] = [...pts.values()];
      view.z = pinch0.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0.d;
    } else if (last) {
      view.x -= (e.clientX - last[0]) / view.z;
      view.y -= (e.clientY - last[1]) / view.z;
    }
    last = [e.clientX, e.clientY];
    clampView(); draw();
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch0 = null;
    if (!pts.size) { cv.classList.remove('drag'); last = null; }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    view.z *= Math.exp(-e.deltaY * 0.0015);
    clampView();
    const [nx, ny] = toWorld(e.clientX, e.clientY);
    view.x += wx - nx; view.y += wy - ny;
    clampView(); draw();
  }, { passive: false });

  document.getElementById('find').addEventListener('submit', (e) => { e.preventDefault(); find(document.getElementById('q').value); });
  document.getElementById('night').addEventListener('click', (e) => {
    isNight = !isNight;
    e.currentTarget.setAttribute('aria-pressed', String(isNight));
    e.currentTarget.textContent = isNight ? 'Day' : 'Night';
    if (isNight && !night.src) night.src = 'data2d/world_night.png';
    draw();
  });
  document.getElementById('go-castle').addEventListener('click', () => flyTo(meta.castle.x, meta.castle.y + 20, 6));
  document.getElementById('go-struct').addEventListener('click', () => flyTo(meta.structure.x, meta.structure.y + 20, 6));
  document.getElementById('zoom-in').addEventListener('click', () => flyTo(view.x, view.y, view.z * 1.6));
  document.getElementById('zoom-out').addEventListener('click', () => flyTo(view.x, view.y, view.z / 1.6));
  const modal = document.getElementById('hoard');
  const openHoard = (e) => { if (e) e.preventDefault(); modal.hidden = false; document.getElementById('close-hoard').focus(); };
  const closeHoard = () => { modal.hidden = true; history.replaceState(null, '', location.pathname); };
  document.getElementById('open-hoard').addEventListener('click', openHoard);
  document.getElementById('close-hoard').addEventListener('click', closeHoard);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeHoard(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeHoard(); });
  addEventListener('resize', resize);
  night.onload = draw;
  day.onload = draw;

  fetch('data2d/world_homes.json').then((r) => r.json()).then((m) => {
    meta = m;
    m.castle.name = 'Castle · @' + m.castle.handle;
    m.structure.name = 'The structure';
    m.church.name = 'Church · bell tower';
    m.cityhall.name = 'City hall';
    document.getElementById('n-homes').textContent = m.homes.length;
    document.getElementById('n-cap').textContent = m.capacity.toLocaleString('en');
    const dl = document.getElementById('handles');
    for (const h of m.homes) { const o = document.createElement('option'); o.value = '@' + h.handle; dl.append(o); }
    view = { x: m.castle.x, y: m.castle.y + 30, z: innerWidth < 640 ? 3 : 4 };
    day.src = 'data2d/world.png';
    resize();
    if (location.hash === '#hoard') openHoard();
    const q = new URLSearchParams(location.search).get('find');
    if (q) { document.getElementById('q').value = q; find(q); }
  });
})();
