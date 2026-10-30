// Catalog of everything in the world, from data/catalog.json (export.py reads CANON.md and dayN/*.md).
import { marked } from 'https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.0/lib/marked.esm.min.js';

const C = await (await fetch('data/catalog.json', { cache: 'no-cache' })).json();
const page = document.getElementById('page');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => marked.parseInline(String(s ?? ''));
const camLink = (cam, id) => cam
  ? `<a class="go" href="index.html#cam=${[cam.orbit, cam.zoom, cam.tilt, cam.cx, cam.cy, cam.fy, cam.persp].join(',')}&sel=${encodeURIComponent(id)}">Open in viewer ↗</a>`
  : '<span class="pill">no spot in the world yet</span>';
const rel = (p) => (p ? `C+(${fmtd(p[0] - 400)}, ${fmtd(p[1] - 400)})` : '');
const fmtd = (v) => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v * 10) / 10)}`;
const row = (k, v) => (v && v !== '—' ? `<dt>${k}</dt><dd>${md(v)}</dd>` : '');

const pages = {
  villagers() {
    const cards = C.villagers.map((v) => `
      <article class="card" data-q="${esc([v.handle, v.home, v.look, v.notes].join(' '))}">
        <h3><span class="n">#${esc(v.n)}</span>${esc(v.handle)}</h3>
        <dl>${row('arrived', v.arrived)}${row('home', v.home)}${row('look', v.look)}${row('notes', v.notes)}
        ${v.pos ? `<dt>spot</dt><dd><code>${rel(v.pos)}</code></dd>` : ''}</dl>
        ${camLink(v.cam, v.id)}
      </article>`).join('');
    const byDay = {};
    for (const w of C.waiting) (byDay[w.day] ||= []).push(w);
    const waiting = Object.entries(byDay).map(([d, ws]) => `
      <div class="block" data-q="${esc(ws.map((w) => w.handle).join(' '))}">
        <h3>Arrived for Day ${d}: ${ws.length} followers, no home yet</h3>
        <p class="meta">From <code>${esc(ws[0].source)}</code>, in arrival order. They move in when Day ${d}'s reel is final and CANON.md is updated.</p>
        <div class="chips">${ws.map((w) => `<span data-q="${esc(w.handle)}"><i>${esc(w.n)}</i>${esc(w.handle)}</span>`).join('')}</div>
      </div>`).join('');
    return `<h2 class="page">Villagers</h2>
      <p class="lede">Every follower is a villager with a home and a name tag. ${C.villagers.length} in the canon; their homes are labelled in the viewer.</p>
      <div class="grid">${cards}</div><br>${waiting}`;
  },
  builds() {
    const cards = C.builds.map((b) => `
      <article class="card" data-q="${esc([b.what, b.where, b.by].join(' '))}">
        <h3>${md(b.what)}</h3>
        <dl>${row('where', b.where)}${row('day', b.day)}${row('by', b.by)}</dl>
        ${camLink(b.cam, b.id)}
      </article>`).join('');
    return `<h2 class="page">Builds</h2>
      <p class="lede">What has been built, where, and whose wish it was. The most-liked comment of the day gets built.</p>
      <div class="grid">${cards}</div>`;
  },
  places() {
    const cards = C.places.map((p) => `
      <article class="card" data-q="${esc([p.name, p.desc, ...p.canon].join(' '))}">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.desc)}</p>
        <dl><dt>world</dt><dd><code>(${p.world.join(', ')})</code></dd><dt>from C</dt><dd><code>C+(${p.rel.join(', ')})</code></dd></dl>
        ${p.canon.length ? `<details><summary class="meta">In the canon (${p.canon.length})</summary>${p.canon.map((l) => `<p class="quote">${md(l)}</p>`).join('')}</details>` : ''}
        ${camLink(p.cam, p.id)}
      </article>`).join('');
    return `<h2 class="page">Places</h2>
      <p class="lede">Fixed spots of the world, taken from the engine (C = camp centre (400, 400); +x east, −y north).</p>
      <div class="grid">${cards}</div>`;
  },
  threads() {
    const kinds = {};
    for (const t of C.threads) (kinds[t.kind] ||= []).push(t);
    const lists = Object.entries(kinds).map(([k, ts]) => `
      <div class="block"><h3>${esc(k[0].toUpperCase() + k.slice(1))}</h3><ul>${ts.map((t) => `<li data-q="${esc(t.text)}">${md(t.text)}</li>`).join('')}</ul></div>`).join('');
    const days = [...new Set(C.wishes.map((w) => w.day))].sort();
    const wishes = days.map((d) => {
      const ws = C.wishes.filter((w) => w.day === d).sort((a, b) => b.likes - a.likes);
      return `<div class="block"><h3>Wishes read for Day ${d} <span class="meta">(day${d}/INPUTS.md)</span></h3><div class="grid">${ws.map((w, i) => `
        <article class="card" data-q="${esc(w.handle + ' ' + w.text)}">
          <h3>${esc(w.handle)} <span class="pill ${w.likes ? 'gold' : ''}">${w.likes} ♥</span>
          ${w.built ? '<span class="pill teal">built</span>' : i === 0 && w.likes ? '<span class="pill pink">most liked</span>' : ''}</h3>
          <p class="quote">${md(w.text)}</p>
        </article>`).join('')}</div></div>`;
    }).join('');
    return `<h2 class="page">Open threads &amp; wishes</h2>
      <p class="lede">Promises the audience has seen, what is planned next, and every comment wish read so far.</p>${lists}${wishes}`;
  },
  days() {
    const want = new URLSearchParams(location.hash.split('?')[1] || '');
    const d = C.days.find((x) => String(x.n) === want.get('d')) || C.days[C.days.length - 1];
    const doc = d.docs.find((x) => x.name === want.get('doc')) || d.docs[0];
    const daynav = C.days.map((x) => `<a class="${x === d ? 'on' : ''}" href="#days?d=${x.n}">Day ${x.n}</a>`).join('');
    const docnav = d.docs.map((x) => `<a class="${x === doc ? 'on' : ''}" href="#days?d=${d.n}&doc=${x.name}">${esc(x.name)}</a>`).join('');
    return `<h2 class="page">Days</h2>
      <p class="lede">Each day's script, treatment, inputs and caption, as written in <code>dayN/</code>.</p>
      <div class="docnav">${daynav}</div><div class="docnav">${docnav}</div>
      <p class="meta"><code>${esc(doc.path)}</code></p>
      <article class="md">${marked.parse(doc.markdown)}</article>`;
  },
  canon() {
    const st = C.state;
    return `<h2 class="page">Canon</h2>
      <div class="block"><h3>${esc(st.title)}</h3><ul>${st.items.map((t) => `<li>${md(t)}</li>`).join('')}</ul></div>
      <p class="meta"><code>CANON.md</code>, the world bible, in full:</p>
      <article class="md">${marked.parse(C.canon)}</article>`;
  },
};

function render() {
  const name = (location.hash.slice(1).split('?')[0]) || 'villagers';
  const fn = pages[name] || pages.villagers;
  page.innerHTML = fn();
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('on', a.getAttribute('href') === `#${pages[name] ? name : 'villagers'}`);
  filter();
  window.scrollTo(0, 0);
}
function filter() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  for (const el of page.querySelectorAll('[data-q]')) {
    const own = el.dataset.q.toLowerCase().includes(q);
    const kids = [...el.querySelectorAll('[data-q]')];
    const anyKid = kids.some((k) => k.dataset.q.toLowerCase().includes(q));
    el.style.display = !q || own || anyKid ? '' : 'none';
  }
}
document.getElementById('q').addEventListener('input', filter);
window.addEventListener('hashchange', render);
document.title = `Realm Catalog · Day ${C.day}`;
render();
