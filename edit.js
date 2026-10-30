// realm.pixels game: the editable voxel world (no drawing here, so it can be tested outside the browser).
//
// The viewer draws one instance per exposed cube face (see expand() in viewer.js). Editing never rebuilds those
// buffers: a removed voxel's faces get a "hidden" flag, the faces it uncovers on its neighbours are added to a
// separate edit layer, and placed voxels live in that layer too. A `sink` does the drawing side:
//   sink.hideOrig(part, voxel, rank) / sink.showOrig(...)    flag one face of the exported data: the voxel's
//                                                            rank-th exposed face (the viewer knows where it is drawn)
//   sink.addFace(rec) -> index / sink.hideEdit(index)        the edit layer (rec: Uint8 bytes as in expand())
//   sink.reset()                                             back to the exported world
// Every edit is an operation (mine, fell, block, stamp) kept in `ops`, so a saved world is replayed, not stored.
//
// Rules from core/VOXEL_RULES.md that apply here: hidden faces are never drawn (a face appears only when its
// neighbour goes), nothing is re-sent that did not change, and a placed stamp keeps its own face culling.

export const REC = 16;
export const OPP = [5, 2, 1, 4, 3, 0];                            // top, +x, -x, +y, -y, bottom
export const DIR = [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1]];
const POP = Array.from({ length: 64 }, (_, i) => [0, 1, 2, 3, 4, 5].reduce((s, b) => s + ((i >> b) & 1), 0));
const CS = 2, OFF = 64, NCX = Math.ceil((800 + 2 * OFF) / CS);   // column index: 2 x 2 unit columns over the world
const cellOf = (x, y) => {
  const cx = Math.floor((x + OFF) / CS), cy = Math.floor((y + OFF) / CS);
  return cx < 0 || cy < 0 || cx >= NCX || cy >= NCX ? -1 : cy * NCX + cx;
};

export class World {
  constructor(vbuf, parts, q) {
    this.q = q;
    this.u8 = new Uint8Array(vbuf);
    this.u16 = new Uint16Array(vbuf, 0, (this.u8.length >> 1));
    this.NV = this.u8.length / REC;
    this.parts = parts.map((p) => ({ ...p }));
    for (const p of this.parts) {                                // first face instance of each voxel (as expand())
      const first = new Uint32Array(p.count + 1);
      let nf = 0;
      for (let i = 0; i < p.count; i++) { first[i] = nf; nf += POP[this.u8[(p.offset + i) * REC + 9] & 63]; }
      first[p.count] = nf;
      p.first = first;
    }
    this.dead = new Uint8Array(this.NV);
    this.hidden = new Map();                                     // original voxel -> face bits hidden by a neighbour
    this.extra = new Map();                                      // original voxel -> Map(face -> edit face index)
    this.ops = [];
    this._buildColumns();
    this._clearAdded();
  }

  // ----------------------------------------------------------- voxel records
  partOf(g) { for (let k = 0; k < this.parts.length; k++) { const p = this.parts[k]; if (g < p.offset + p.count) return k; } return -1; }
  size(id) { return id < this.NV ? this.u8[id * REC + 13] / 100 : this.A.s[id - this.NV]; }
  pos(id) {
    if (id < this.NV) { const w = id * 8; return [this.u16[w] / this.q - OFF, this.u16[w + 1] / this.q - OFF, this.u16[w + 2] / this.q - OFF]; }
    const k = id - this.NV; return [this.A.x[k], this.A.y[k], this.A.h[k]];
  }
  alive(id) { return id < this.NV ? !this.dead[id] : !!this.A.alive[id - this.NV]; }
  obj(id) { return id < this.NV ? this.u8[id * REC + 14] | (this.u8[id * REC + 15] << 8) : this.A.obj[id - this.NV]; }
  color(id) {
    if (id < this.NV) { const b = id * REC; return [this.u8[b + 6], this.u8[b + 7], this.u8[b + 8]]; }
    const k = id - this.NV; return this.A.col.slice(k * 3, k * 3 + 3);
  }

  _buildColumns() {
    const counts = new Int32Array(NCX * NCX + 1);
    const each = (fn) => {
      for (let g = 0; g < this.NV; g++) {
        const [x, y] = this.pos(g), s = this.size(g);
        const c0 = cellOf(x, y), c1 = cellOf(x + s * 0.999, y + s * 0.999);
        if (c0 < 0 || c1 < 0) continue;
        const x0 = c0 % NCX, y0 = (c0 / NCX) | 0, x1 = c1 % NCX, y1 = (c1 / NCX) | 0;
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) fn(cy * NCX + cx, g);
      }
    };
    each((c) => { counts[c + 1]++; });
    for (let i = 0; i < NCX * NCX; i++) counts[i + 1] += counts[i];
    const idx = new Uint32Array(counts[NCX * NCX]), fill = counts.slice(0, NCX * NCX);
    each((c, g) => { idx[fill[c]++] = g; });
    for (let c = 0; c < NCX * NCX; c++) {                         // by height, so findAt() can binary-search
      const a = counts[c], b = counts[c + 1];
      if (b - a > 1) idx.subarray(a, b).sort((p, r) => this.u16[p * 8 + 2] - this.u16[r * 8 + 2]);
    }
    this.colStart = counts; this.colIdx = idx;
  }

  _clearAdded() {
    this.A = { x: [], y: [], h: [], s: [], col: [], kind: [], ao: [], alive: [], obj: [], faces: [] };
    this.addedCols = new Map();
    this.nextObj = 1 << 16;                                      // stamps get object ids above the exported ones
  }

  // ----------------------------------------------------------- lookups
  *inCell(c) {
    if (c < 0) return;
    for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) yield this.colIdx[i];
    const a = this.addedCols.get(c);
    if (a) yield* a;
  }
  findAt(x, y, h, s) {                                          // a live voxel of size s with its corner at x, y, h
    const c = cellOf(x + s / 2, y + s / 2);
    if (c < 0) return -1;
    const eps = s * 0.08, qh = (h + OFF) * this.q, qe = eps * this.q;
    let lo = this.colStart[c], hi = this.colStart[c + 1];
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.u16[this.colIdx[m] * 8 + 2] < qh - qe) lo = m + 1; else hi = m; }
    for (let i = lo; i < this.colStart[c + 1]; i++) {
      const g = this.colIdx[i];
      if (this.u16[g * 8 + 2] > qh + qe) break;
      if (this.dead[g] || Math.abs(this.size(g) - s) > 0.011) continue;
      const [gx, gy] = this.pos(g);
      if (Math.abs(gx - x) < eps && Math.abs(gy - y) < eps) return g;
    }
    const a = this.addedCols.get(c);
    if (a) for (const id of a) {
      const k = id - this.NV;
      if (this.A.alive[k] && Math.abs(this.A.s[k] - s) < 0.011 && Math.abs(this.A.x[k] - x) < eps && Math.abs(this.A.y[k] - y) < eps &&
          Math.abs(this.A.h[k] - h) < eps) return id;
    }
    return -1;
  }
  neighbour(id, f) {
    const p = this.pos(id), s = this.size(id), d = DIR[f];
    return this.findAt(p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s, s);
  }

  // ----------------------------------------------------------- faces
  faceVisible(id, f) {
    if (id >= this.NV) return this.A.faces[id - this.NV][f] >= 0;
    const bits = this.u8[id * REC + 9] & 63, hid = this.hidden.get(id) || 0;
    if ((bits >> f) & 1 && !((hid >> f) & 1)) return true;
    const ex = this.extra.get(id);
    return !!(ex && ex.has(f));
  }
  _origFace(id, f) {                                           // part, voxel in the part, rank of the face among its own
    const k = this.partOf(id), p = this.parts[k], i = id - p.offset, bits = this.u8[id * REC + 9] & 63;
    return [k, i, POP[bits & ((1 << f) - 1)]];
  }
  _faceRec(id, f) {
    const r = new Uint8Array(14);
    const put16 = (o, v) => { const q = Math.max(0, Math.min(65535, Math.round((v + OFF) * this.q))); r[o] = q & 255; r[o + 1] = q >> 8; };
    if (id < this.NV) {
      const b = id * REC;
      r.set(this.u8.subarray(b, b + 6), 0);
      r[6] = this.u8[b + 6]; r[7] = this.u8[b + 7]; r[8] = this.u8[b + 8]; r[9] = f | ((this.u8[b + 10] & 7) << 3);
      r[10] = this.u8[b + 11]; r[11] = this.u8[b + 12]; r[12] = this.u8[b + 13];
    } else {
      const k = id - this.NV;
      put16(0, this.A.x[k]); put16(2, this.A.y[k]); put16(4, this.A.h[k]);
      r[6] = this.A.col[k * 3]; r[7] = this.A.col[k * 3 + 1]; r[8] = this.A.col[k * 3 + 2]; r[9] = f | ((this.A.kind[k] & 7) << 3);
      r[10] = this.A.ao[k]; r[11] = 0; r[12] = Math.round(this.A.s[k] * 100);
    }
    return r;
  }
  showFace(id, f, sink) {
    if (this.faceVisible(id, f)) return;
    if (id >= this.NV) { this.A.faces[id - this.NV][f] = sink.addFace(this._faceRec(id, f)); return; }
    const bits = this.u8[id * REC + 9] & 63, hid = this.hidden.get(id) || 0;
    if ((bits >> f) & 1 && (hid >> f) & 1) {                   // it was exported and only hidden: show it again
      sink.showOrig(...this._origFace(id, f));
      this.hidden.set(id, hid & ~(1 << f));
      return;
    }
    let ex = this.extra.get(id);
    if (!ex) this.extra.set(id, (ex = new Map()));
    ex.set(f, sink.addFace(this._faceRec(id, f)));
  }
  hideFace(id, f, sink) {
    if (id >= this.NV) { const fs = this.A.faces[id - this.NV]; if (fs[f] >= 0) { sink.hideEdit(fs[f]); fs[f] = -1; } return; }
    const ex = this.extra.get(id);
    if (ex && ex.has(f)) { sink.hideEdit(ex.get(f)); ex.delete(f); return; }
    const bits = this.u8[id * REC + 9] & 63, hid = this.hidden.get(id) || 0;
    if ((bits >> f) & 1 && !((hid >> f) & 1)) {
      sink.hideOrig(...this._origFace(id, f));
      this.hidden.set(id, hid | (1 << f));
    }
  }

  // ----------------------------------------------------------- remove and add
  _kill(id, sink) {
    if (!this.alive(id)) return false;
    for (let f = 0; f < 6; f++) this.hideFace(id, f, sink);
    if (id < this.NV) this.dead[id] = 1; else this.A.alive[id - this.NV] = 0;
    return true;
  }
  _uncover(ids, sink) {                                        // neighbours of removed voxels show the faces they gained
    for (const id of ids) for (let f = 0; f < 6; f++) {
      const n = this.neighbour(id, f);
      if (n >= 0) this.showFace(n, OPP[f], sink);
    }
  }
  removeMany(ids, sink) {
    const gone = ids.filter((id) => this._kill(id, sink));
    this._uncover(gone, sink);
    return gone.length;
  }
  add(x, y, h, s, col, sink, { kind = 0, ao = 200, bits = null, obj = 0 } = {}) {
    if (this.findAt(x, y, h, s) >= 0) return -1;
    const k = this.A.x.length, id = this.NV + k;
    this.A.x.push(x); this.A.y.push(y); this.A.h.push(h); this.A.s.push(s); this.A.col.push(col[0], col[1], col[2]);
    this.A.kind.push(kind); this.A.ao.push(ao); this.A.alive.push(1); this.A.obj.push(obj); this.A.faces.push([-1, -1, -1, -1, -1, -1]);
    const c0 = cellOf(x, y), c1 = cellOf(x + s * 0.999, y + s * 0.999);
    if (c0 >= 0 && c1 >= 0) {
      for (let cy = (c0 / NCX) | 0; cy <= ((c1 / NCX) | 0); cy++) for (let cx = c0 % NCX; cx <= c1 % NCX; cx++) {
        const c = cy * NCX + cx;
        if (!this.addedCols.has(c)) this.addedCols.set(c, []);
        this.addedCols.get(c).push(id);
      }
    }
    for (let f = 0; f < 6; f++) {
      if (bits !== null) { if ((bits >> f) & 1) this.showFace(id, f, sink); continue; }
      const n = this.neighbour(id, f);
      if (n >= 0) this.hideFace(n, OPP[f], sink); else this.showFace(id, f, sink);
    }
    return id;
  }

  // ----------------------------------------------------------- picking
  // Ray from o along unit d: nearest voxel hit within tmax, as { id, t, f (the face hit), p (the point) }.
  raycast(o, d, tmax) {
    let t = 0;
    const tb = (lo, hi, oo, dd) => (dd > 0 ? [(lo - oo) / dd, (hi - oo) / dd] : dd < 0 ? [(hi - oo) / dd, (lo - oo) / dd]
      : oo >= lo && oo <= hi ? [-Infinity, Infinity] : [Infinity, -Infinity]);
    const [ax0, ax1] = tb(-OFF, 800 + OFF, o[0], d[0]), [ay0, ay1] = tb(-OFF, 800 + OFF, o[1], d[1]);
    t = Math.max(0, ax0, ay0);
    const tend = Math.min(tmax, ax1, ay1);
    if (t > tend) return null;
    let cx = Math.floor((o[0] + d[0] * t + OFF) / CS), cy = Math.floor((o[1] + d[1] * t + OFF) / CS);
    const sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1;
    const nextB = (c, s_, oo, dd) => (dd === 0 ? Infinity : (((c + (s_ > 0 ? 1 : 0)) * CS - OFF) - oo) / dd);
    let tx = nextB(cx, sx, o[0], d[0]), ty = nextB(cy, sy, o[1], d[1]);
    const dtx = d[0] === 0 ? Infinity : CS / Math.abs(d[0]), dty = d[1] === 0 ? Infinity : CS / Math.abs(d[1]);
    let best = null;
    for (let guard = 0; guard < 4 * NCX && t <= tend; guard++) {
      if (cx >= 0 && cy >= 0 && cx < NCX && cy < NCX) {
        for (const id of this.inCell(cy * NCX + cx)) {
          if (!this.alive(id)) continue;
          const p = this.pos(id), s = this.size(id);
          let t0 = -Infinity, t1 = Infinity, face = -1;
          for (let a = 0; a < 3; a++) {
            const [u0, u1] = tb(p[a], p[a] + s, o[a], d[a]);
            if (u0 > t0) { t0 = u0; face = a === 0 ? (d[0] > 0 ? 2 : 1) : a === 1 ? (d[1] > 0 ? 4 : 3) : (d[2] > 0 ? 5 : 0); }
            t1 = Math.min(t1, u1);
          }
          if (t0 <= t1 && t1 >= 0 && t0 <= tend && (!best || t0 < best.t)) best = { id, t: Math.max(t0, 0), f: face };
        }
      }
      const texit = Math.min(tx, ty);
      if (best && best.t <= texit) break;
      t = texit;
      if (tx < ty) { tx += dtx; cx += sx; } else { ty += dty; cy += sy; }
    }
    if (best) best.p = [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t];
    return best;
  }

  // ----------------------------------------------------------- tools (each one an operation)
  near(p, r) {                                                 // live voxels whose centre is within r of p
    const out = [];
    const c0 = Math.floor((p[0] - r - 1 + OFF) / CS), c1 = Math.floor((p[0] + r + 1 + OFF) / CS);
    const r0 = Math.floor((p[1] - r - 1 + OFF) / CS), r1 = Math.floor((p[1] + r + 1 + OFF) / CS);
    for (let cy = Math.max(0, r0); cy <= Math.min(NCX - 1, r1); cy++) for (let cx = Math.max(0, c0); cx <= Math.min(NCX - 1, c1); cx++) {
      for (const id of this.inCell(cy * NCX + cx)) {
        if (!this.alive(id)) continue;
        const q = this.pos(id), s = this.size(id) / 2;
        if (Math.hypot(q[0] + s - p[0], q[1] + s - p[1], q[2] + s - p[2]) <= r) out.push(id);
      }
    }
    return [...new Set(out)];
  }
  objectOf(id) {                                               // every live voxel of the clicked voxel's object
    const o = this.obj(id);
    if (id < this.NV && o > 0) {
      if (!this.objIndex) {                                    // built on the first swing of the axe
        let max = 0;
        for (let g = 0; g < this.NV; g++) max = Math.max(max, this.obj(g));
        const st = new Int32Array(max + 2);
        for (let g = 0; g < this.NV; g++) st[this.obj(g) + 1]++;
        for (let i = 0; i <= max; i++) st[i + 1] += st[i];
        const ix = new Uint32Array(this.NV), fl = st.slice(0, max + 1);
        for (let g = 0; g < this.NV; g++) ix[fl[this.obj(g)]++] = g;
        this.objIndex = { st, ix };
      }
      const { st, ix } = this.objIndex;
      return Array.from(ix.subarray(st[o], st[o + 1])).filter((g) => !this.dead[g]);
    }
    if (id >= this.NV && o > 0) return this.A.obj.flatMap((v, k) => (v === o && this.A.alive[k] ? [this.NV + k] : []));
    const out = [id], seen = new Set(out);                      // placed blocks: everything touching, face to face
    for (let i = 0; i < out.length && out.length < 200000; i++) for (let f = 0; f < 6; f++) {
      const n = this.neighbour(out[i], f);
      if (n >= this.NV && !seen.has(n) && this.obj(n) === 0) { seen.add(n); out.push(n); }
    }
    return out;
  }

  apply(op, sink, prefabs) {
    let n = 0;
    if (op.k === 'mine') n = this.removeMany(this.near(op.p, op.r), sink);
    else if (op.k === 'fell') { const id = this.findAt(op.p[0], op.p[1], op.p[2], op.s); if (id >= 0) n = this.removeMany(this.objectOf(id), sink); }
    else if (op.k === 'block') n = this.add(op.p[0], op.p[1], op.p[2], op.s, op.c, sink) >= 0 ? 1 : 0;
    else if (op.k === 'stamp') n = this.stamp(prefabs, op.name, op.p, op.rot || 0, sink);
    return n;
  }
  run(op, sink, prefabs) { const n = this.apply(op, sink, prefabs); if (n) this.ops.push(op); return n; }
  replay(ops, sink, prefabs) { this.reset(sink); for (const op of ops) this.run(op, sink, prefabs); }
  reset(sink) {
    this.dead.fill(0); this.hidden.clear(); this.extra.clear(); this._clearAdded(); this.ops = [];
    sink.reset();
  }

  stamp(prefabs, name, p, rot, sink) {
    const pf = prefabs && prefabs.byName[name];
    if (!pf) return 0;
    const obj = this.nextObj++;
    const u8 = prefabs.u8, u16 = prefabs.u16, q = prefabs.q;
    const turn = ((rot % 4) + 4) % 4;
    const ROT = [0, 3, 4, 2, 1, 5];                              // one quarter turn: +x -> +y -> -x -> -y -> +x
    let n = 0;
    for (let i = pf.offset; i < pf.offset + pf.count; i++) {
      const b = i * REC, w = i * 8, s = u8[b + 13] / 100;
      let x = u16[w] / q - OFF, y = u16[w + 1] / q - OFF;
      const h = u16[w + 2] / q - OFF;
      let bits = u8[b + 9] & 63;
      for (let k = 0; k < turn; k++) {
        [x, y] = [-y - s, x];
        let nb = 0;
        for (let f = 0; f < 6; f++) if ((bits >> f) & 1) nb |= 1 << ROT[f];
        bits = nb;
      }
      if (this.add(p[0] + x, p[1] + y, p[2] + h, s, [u8[b + 6], u8[b + 7], u8[b + 8]], sink,
                   { kind: u8[b + 10] & 1, ao: u8[b + 11], bits, obj }) >= 0) n++;
    }
    return n;
  }
}

export function loadPrefabs(buf, meta) {
  const u8 = new Uint8Array(buf);
  return { u8, u16: new Uint16Array(buf, 0, u8.length >> 1), q: meta.q, list: meta.prefabs,
           byName: Object.fromEntries(meta.prefabs.map((p) => [p.name, p])) };
}
