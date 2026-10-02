import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ================================================================== shared
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const resultsP = fetch("assets/results.json").then((r) => r.json()).catch(() => null);   // charts data, requested first
const DATASETS = [["hdepic", "Kitchen", "HD-EPIC"], ["ucs", "Mall", "UCS-Bench"], ["vq3d", "Workshop", "Ego4D VQ3D"]];
const UP = { hdepic: "z", vq3d: "z", ucs: "-y" };                  // which world axis points up
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const hue = (id) => (id * 137.508) % 360;
const col = (id, a = 1, l = 62) => `hsla(${hue(id)},72%,${l}%,${a})`;
const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
const cache = {};
async function getDS(name) {
  if (cache[name]) return cache[name];
  const A = `assets/${name}/`;
  const [D, task] = await Promise.all([fetch(A + "data.json").then((r) => r.json()), fetch(A + "task.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  const sprite = await loadImg(A + D.sprite.file);
  let pts = null; try { const r = await fetch(A + "points.bin"); if (r.ok) pts = await r.arrayBuffer(); } catch (e) { /* none */ }
  const objById = new Map(D.objects.map((o) => [o.id, o])), detsByOb = new Map();
  D.frames.forEach((f, fi) => f.dets.forEach((d) => { if (d.ob === undefined) return; if (!detsByOb.has(d.ob)) detsByOb.set(d.ob, []); detsByOb.get(d.ob).push({ ...d, t: f.t, fi }); }));
  const moves = D.objects.filter((o) => o.segs.length >= 2 && o.segs.every((s) => s.w));
  const X = { name, A, D, task, sprite, pts, objById, detsByOb, moves, speed: D.speed || 1, up: UP[name] };
  X.W2T = X.up === "z" ? (p) => new THREE.Vector3(p[0], p[2], -p[1]) : (p) => new THREE.Vector3(p[0], -p[1], -p[2]);
  return (cache[name] = X);
}
function posAt(o, t) {
  const tr = o.traj; if (!tr.length || t < tr[0][0]) return null;
  const i = tr.findIndex((p) => p[0] > t); if (i === -1) return tr[tr.length - 1].slice(1);
  const a = tr[i - 1], b = tr[i]; if (b[0] - a[0] > 12) return a.slice(1);
  const f = (t - a[0]) / (b[0] - a[0]); return [0, 1, 2].map((k) => a[k + 1] + f * (b[k + 1] - a[k + 1]));
}
const firstDS = getDS(Q.get("ds") || "hdepic");                  // start loading before any WebGL context exists
const eventAt = (X, t) => { let e = null; for (const x of X.D.events) if (x.t <= t + 1e-6) e = x; return e; };
const camAt = (X, t) => { let c = X.D.camera[0]; for (const x of X.D.camera) { if (x[0] > t) break; c = x; } return c; };
const tileXY = (X, id) => { const c = X.D.sprite.cols, s = X.D.sprite.tile; return [(id % c) * s, Math.floor(id / c) * s]; };
const nearestFrame = (X, t) => X.D.frames.reduce((b, f, i) => (Math.abs(f.t - t) < Math.abs(X.D.frames[b].t - t) ? i : b), 0);
const frameSrc = (X, i) => `${X.A}frames/${String(i).padStart(2, "0")}.jpg`;
const iou = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0; const i = w * h; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i); };
function textSprite(text, color = "#fff", size = 30) {
  const c = document.createElement("canvas"), g = c.getContext("2d"); g.font = `600 ${size}px Inter, -apple-system, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 24; c.width = w; c.height = size + 18; g.font = `600 ${size}px Inter, -apple-system, sans-serif`;
  g.fillStyle = "rgba(8,10,13,.82)"; g.beginPath(); g.roundRect(0, 0, w, c.height, c.height / 2); g.fill(); g.fillStyle = color; g.fillText(text, 12, size + 2);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.renderOrder = 10; s.userData.aspect = w / c.height; return s;
}

// ================================================================== 3D memory view (hero + ask)
class View3D {
  constructor(host, autoRotate = true, showPath = true) {
    this.host = host; this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true }); this.r.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(this.r.domElement); this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    this.ctl = new OrbitControls(this.cam, this.r.domElement); this.ctl.enableDamping = true; this.ctl.autoRotate = autoRotate; this.ctl.autoRotateSpeed = 0.5;
    new ResizeObserver(() => this.resize()).observe(host); this.resize(); this.hl = null; this.labels = new Map(); this.showPath = showPath; this.goal = null;
    this.tagLayer = document.createElement("div"); this.tagLayer.className = "tags3d"; host.appendChild(this.tagLayer); this.tags = new Map();
  }
  resize() { const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return; this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
  set(X) {
    if (this.g) this.scene.remove(this.g); const g = (this.g = new THREE.Group()); this.scene.add(g); this.X = X; this.hl = null; this.labels = new Map();
    this.tagLayer.innerHTML = ""; this.tags = new Map();
    const camPts = X.D.camera.map((c) => X.W2T(c.slice(1, 4)));
    const objPts = X.D.objects.flatMap((o) => o.traj.map((p) => X.W2T(p.slice(1))));
    const box = new THREE.Box3().setFromPoints(objPts.length ? objPts : camPts), ctr = box.getCenter(new THREE.Vector3());
    const rad = Math.max(1.5, box.getSize(new THREE.Vector3()).length() * 0.5); this.rad = rad; this.ctr = ctr;
    this.scene.fog = new THREE.Fog(0x111419, rad * 1.6, rad * 4.5); this.cloud = null;
    if (X.pts) {
      const n = X.pts.byteLength / 15, xyz = new Float32Array(X.pts, 0, n * 3), rgb = new Uint8Array(X.pts, n * 12, n * 3), pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const v = X.W2T([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]); pos[3 * i] = v.x; pos[3 * i + 1] = v.y; pos[3 * i + 2] = v.z; }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(rgb, 3, true));
      this.cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: rad * 0.006, vertexColors: true, transparent: true, opacity: 0.6 })); g.add(this.cloud);
    }
    const pathAll = new THREE.Line(new THREE.BufferGeometry().setFromPoints(camPts), new THREE.LineBasicMaterial({ color: 0x3a414c })); pathAll.visible = this.showPath; g.add(pathAll);
    this.pathNow = new THREE.Line(new THREE.BufferGeometry().setFromPoints(camPts), new THREE.LineBasicMaterial({ color: 0xffffff })); this.pathNow.visible = this.showPath; g.add(this.pathNow);
    this.frustum = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.04, rad * 0.09, 4, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true })); g.add(this.frustum);
    const dot = new THREE.SphereGeometry(rad * 0.016, 16, 12);
    this.nodes = X.D.objects.map((o) => { const m = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue(o.id)},72%,62%)`), transparent: true }));
      m.visible = false; m.userData = { o, born: -1 }; g.add(m); return m; });
    this.arrows = X.moves.map((o) => { const p = o.segs.map((s) => X.W2T(s.w)), lift = new THREE.Vector3(0, rad * 0.08, 0);
      const curve = new THREE.CatmullRomCurve3(p.flatMap((q, i) => (i ? [p[i - 1].clone().lerp(q, 0.5).add(lift), q] : [q])));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, rad * 0.003, 6), new THREE.MeshBasicMaterial({ color: 0xe8703a })); tube.visible = false; g.add(tube);
      return { tube, t: o.segs[1].t[0] }; });
    this.extra = new THREE.Group(); g.add(this.extra);
    this.cam.position.copy(ctr).add(new THREE.Vector3(rad * 0.9, rad * 1.0, rad * 0.9)); this.ctl.target.copy(ctr); this.goal = null;
  }
  focus(p, dist) {                                                // fly the camera to look at world point p (memory frame) from `dist`
    const tgt = p.isVector3 ? p.clone() : this.X.W2T(p), dir = this.cam.position.clone().sub(this.ctl.target).normalize();
    this.goal = { tgt, pos: tgt.clone().add(dir.multiplyScalar(dist)) };
  }
  update(t) {
    if (!this.X) return 0; let n = 0; const now = performance.now();
    for (const m of this.nodes) {
      const p = posAt(m.userData.o, t); if (!p) { m.visible = false; m.userData.born = -1; continue; }
      if (m.userData.born < 0) m.userData.born = now; const age = (now - m.userData.born) / 600; let s = age < 1 ? 1 + 1.6 * (1 - age) : 1;
      const lit = !this.hl || this.hl.has(m.userData.o.id); if (this.hl && lit) s *= 1.6;
      m.material.opacity = lit ? 1 : 0.07; m.position.copy(this.X.W2T(p)); m.scale.setScalar(s); m.visible = true; n++;
    }
    for (const a of this.arrows) a.tube.visible = t >= a.t && !this.hl;
    const k = this.X.D.camera.findIndex((c) => c[0] > t); this.pathNow.geometry.setDrawRange(0, k === -1 ? this.X.D.camera.length : Math.max(1, k));
    const c = camAt(this.X, t); this.frustum.position.copy(this.X.W2T(c.slice(1, 4)));
    this.frustum.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.X.W2T(c.slice(4, 7)).normalize());
    if (this.cloud) this.cloud.material.opacity = this.hl ? 0.3 : 0.6;
    for (const s of this.extra.children) if (s.isSprite) { const h = this.rad * 0.05; s.scale.set(h * s.userData.aspect, h, 1); }
    return n;
  }
  highlight(ids, keys = null) { this.hl = ids && ids.size ? ids : null; this.keys = keys || new Set(); }
  placeTags() {                                                   // a name tag on every visible dot; overlapping tags give way to bigger ones
    const w = this.host.clientWidth, h = this.host.clientHeight, placed = [], shown = new Set(), v = new THREE.Vector3();
    const K = this.keys || new Set(), cand = this.nodes.filter((m) => m.visible && (!this.hl || this.hl.has(m.userData.o.id)))
      .sort((a, b) => (K.has(b.userData.o.id) - K.has(a.userData.o.id)) || b.userData.o.n_obs - a.userData.o.n_obs);
    for (const m of cand) {
      v.copy(m.position).project(this.cam); if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      const o = m.userData.o, x = ((v.x + 1) / 2) * w + 7, y = ((1 - v.y) / 2) * h - 9; let el = this.tags.get(o.id);
      if (!el) { el = document.createElement("span"); el.textContent = o.name; el.style.borderLeftColor = col(o.id, 1, 66); this.tagLayer.appendChild(el); this.tags.set(o.id, el); el._w = el.offsetWidth || o.name.length * 6.4 + 14; }
      const r = [x, y, x + el._w, y + 17];
      if (!K.has(o.id) && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      placed.push(r); shown.add(o.id); el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; el.classList.toggle("lit", !!this.hl); el.classList.toggle("key", K.has(o.id));
    }
    for (const [id, el] of this.tags) el.style.display = shown.has(id) ? "" : "none";
  }
  marker(p, color, label, size = 1) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(this.rad * 0.022 * size, 20, 14), new THREE.MeshBasicMaterial({ color })); m.position.copy(this.X.W2T(p)); this.extra.add(m);
    if (label) { const s = textSprite(label, "#fff", 26); s.position.copy(m.position).add(new THREE.Vector3(0, this.rad * 0.07 * size, 0)); this.extra.add(s); }
  }
  line(a, b, color) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.X.W2T(a), this.X.W2T(b)]), new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.05 })); l.computeLineDistances(); this.extra.add(l); }
  clearExtra() { for (const c of [...this.extra.children]) this.extra.remove(c); this.labels.clear(); }
  render() {
    if (this.goal) { this.ctl.target.lerp(this.goal.tgt, 0.06); this.cam.position.lerp(this.goal.pos, 0.06); if (this.cam.position.distanceTo(this.goal.pos) < 0.01) this.goal = null; }
    this.ctl.update(); this.r.render(this.scene, this.cam); this.placeTags();
  }
}

// ================================================================== dataset switch
let X = null; const listeners = [];
const sw = $("switch");
for (const [k, a, b] of DATASETS) { const btn = document.createElement("button"); btn.innerHTML = `${a} <small>${b}</small>`; btn.dataset.k = k; btn.onclick = () => select(k); sw.appendChild(btn); }
async function select(k) { X = await (k === (Q.get("ds") || "hdepic") ? firstDS : getDS(k)); [...sw.children].forEach((b) => b.classList.toggle("on", b.dataset.k === k)); for (const f of listeners) f(X); }

// ================================================================== HERO: video + live memory, pause -> hover
const vid = $("vid"), vpane = $("vpane"), hero3d = new View3D($("mem3d"));
const vover = document.createElement("canvas"); vover.style.pointerEvents = "none"; vpane.appendChild(vover); const vctx = vover.getContext("2d");
const bar = $("bar"), fill = $("fill"), knob = $("knob");
listeners.push((X) => {
  vid.src = X.A + X.D.video; for (const id of ["vpane", "mem3d"]) $(id).style.setProperty("--ar", `${X.D.res[0]}/${X.D.res[1]}`);
  document.querySelector(".stage").style.setProperty("--arn", X.D.res[0] / X.D.res[1]);
  hero3d.set(X); bar.querySelectorAll(".tick").forEach((e) => e.remove());
  for (const o of X.moves) { const d = document.createElement("div"); d.className = "tick"; d.style.left = `${(100 * o.segs[1].t[0]) / X.D.duration}%`; bar.appendChild(d); }
  $("speedNote").textContent = X.speed > 1 ? `${X.speed}× time-lapse` : ""; vid.play().catch(() => {});
});
let tFix = Q.get("t") !== null ? +Q.get("t") : null;           // deep link: open the memory at a moment (until the user plays)
const tNow = () => (X ? Math.min(tFix ?? (vid.currentTime || 0) * X.speed, X.D.duration) : 0);
function seekFrom(e) { tFix = null; const r = bar.getBoundingClientRect(); vid.currentTime = (Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * X.D.duration) / X.speed; }
let dragging = false;
bar.addEventListener("pointerdown", (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seekFrom(e); });
bar.addEventListener("pointermove", (e) => dragging && seekFrom(e)); bar.addEventListener("pointerup", () => (dragging = false));
$("play").onclick = () => { tFix = null; vid.paused ? vid.play() : vid.pause(); };
vid.addEventListener("play", () => { $("play").textContent = "❚❚"; $("phint").style.opacity = 0; hero3d.highlight(null); vctx.clearRect(0, 0, vover.width, vover.height); });
vid.addEventListener("pause", () => { $("play").textContent = "▶"; $("phint").style.opacity = 1; });
new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? vid.play().catch(() => {}) : vid.pause())), { threshold: 0.3 }).observe($("mem3d"));
const pick = (f, mx, my) => f.dets.filter((d) => d.ob !== undefined && mx >= d.box[0] && mx <= d.box[2] && my >= d.box[1] && my <= d.box[3])
  .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
vpane.addEventListener("pointermove", (e) => {
  if (!X || !vid.paused) return; $("phint").style.opacity = 0;
  const r = vpane.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height, t = tNow();
  const fi = nearestFrame(X, t), f = X.D.frames[fi], S = (vover.width = r.width * 2), H = (vover.height = r.height * 2);
  vctx.clearRect(0, 0, S, H); const hit = Math.abs(f.t - t) <= 2.5 * X.speed ? pick(f, mx, my) : null;
  if (!hit) { hideSG(); hero3d.highlight(null); return; }
  vctx.strokeStyle = col(hit.ob); vctx.lineWidth = 4; vctx.strokeRect(hit.box[0] * S, hit.box[1] * H, (hit.box[2] - hit.box[0]) * S, (hit.box[3] - hit.box[1]) * H);
  showSG(sceneGraph(X, hit, f, t), e); hero3d.highlight(new Set([hit.ob]));
});
vpane.addEventListener("pointerleave", () => { hideSG(); vctx.clearRect(0, 0, vover.width, vover.height); if (vid.paused) hero3d.highlight(null); });

// ---- scene graph card (hero hover + pipeline "Ledger")
const sgEl = $("sg");
function showSG(svg, e) { sgEl.innerHTML = svg; sgEl.classList.add("on"); sgEl.style.left = `${Math.min(e.clientX + 24, innerWidth - 340)}px`; sgEl.style.top = `${Math.min(Math.max(10, e.clientY - 165), innerHeight - 340)}px`; }
function hideSG() { sgEl.classList.remove("on"); }
function tileSvg(X, det, x, y, s, ring) {
  const [sx, sy] = tileXY(X, det.id), T = X.D.sprite.tile, id = `c${det.id}_${Math.round(x)}_${Math.round(y)}`;
  return `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${s / 2}"/></clipPath><g clip-path="url(#${id})">
    <svg x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" viewBox="${sx} ${sy} ${T} ${T}"><image href="${X.A + X.D.sprite.file}" width="${X.D.sprite.cols * T}" height="${X.sprite.height}"/></svg></g>
    <circle cx="${x}" cy="${y}" r="${s / 2}" fill="none" stroke="${ring}" stroke-width="2.5"/>`;
}
function sceneGraph(X, hit, f, t) {
  const o = X.objById.get(hit.ob), C = 165, here = posAt(o, t) || (o.traj[0] || []).slice(1), inFrame = new Map();
  for (const d of f.dets) if (d.ob !== undefined && d.ob !== o.id && iou(d.box, hit.box) < 0.2 && (!inFrame.has(d.ob) || d.s > inFrame.get(d.ob).s)) inFrame.set(d.ob, d);
  const near = [...inFrame.entries()].map(([id, d]) => { const q = X.objById.get(id), p = posAt(q, t); return p && here.length ? [q, Math.hypot(p[0] - here[0], p[1] - here[1], p[2] - here[2]), d] : null; })
    .filter((z) => z && z[1] < 1.5).sort((a, b) => a[1] - b[1]).slice(0, 3);
  const ev = eventAt(X, t), aka = [...new Set(o.tags)].filter((n) => n !== o.name), sats = [];
  near.forEach(([q, d, det], i) => sats.push({ ang: -150 + i * 38, kind: "near", q, d, det }));
  sats.push({ ang: -30, kind: "time" }); if (o.segs.length) sats.push({ ang: 25, kind: "moves" }); if (aka.length) sats.push({ ang: 80, kind: "aka" }); if (ev) sats.push({ ang: 128, kind: "doing" });
  let svg = `<svg viewBox="0 0 330 330" xmlns="http://www.w3.org/2000/svg"><circle cx="${C}" cy="${C}" r="160" fill="#0d1014ee" stroke="#2a3038"/>`;
  for (const s of sats) {
    const a = (s.ang * Math.PI) / 180, x = C + 112 * Math.cos(a), y = C + 112 * Math.sin(a);
    svg += `<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" stroke="#3a414c" stroke-dasharray="3 3"/>`;
    if (s.kind === "near") svg += tileSvg(X, s.det, x, y, 40, col(s.q.id)) + `<text x="${x}" y="${y + 33}" fill="#cfd3da" font-size="10" text-anchor="middle">${s.q.name} · ${s.d.toFixed(1)} m</text>`;
    if (s.kind === "time") svg += `<text x="${x}" y="${y}" fill="#9cc3f5" font-size="11" text-anchor="middle">seen ${o.n_obs}×</text><text x="${x}" y="${y + 13}" fill="#666d78" font-size="10" text-anchor="middle">${fmt(o.t[0])}–${fmt(o.t[1])}</text>`;
    if (s.kind === "moves") { const n = o.segs.length; svg += `<g transform="translate(${x - 34},${y - 10})">`;
      for (let i = 0; i < n; i++) svg += `<circle cx="${n > 1 ? (i * 68) / (n - 1) : 34}" cy="10" r="5" fill="${i ? "#e8703a" : "#9cc3f5"}"/>` + (i ? `<line x1="${((i - 1) * 68) / (n - 1) + 6}" y1="10" x2="${(i * 68) / (n - 1) - 6}" y2="10" stroke="#e8703a" stroke-width="2"/>` : "");
      svg += `</g><text x="${x}" y="${y + 18}" fill="#666d78" font-size="10" text-anchor="middle">${n > 1 ? `moved ${n - 1}×` : "stayed put"}</text>`; }
    if (s.kind === "aka") svg += `<text x="${x}" y="${y}" fill="#c2bbff" font-size="11" text-anchor="middle">aka</text><text x="${x}" y="${y + 13}" fill="#c2bbff" font-size="10" text-anchor="middle">${aka.slice(0, 2).join(", ")}</text>`;
    if (s.kind === "doing") { const w = ev.text.replace(/^The camera wearer is /, "").replace(/\.$/, "").split(" ");
      svg += `<text x="${x}" y="${y + 6}" fill="#87e0c0" font-size="10" text-anchor="middle">${w.slice(0, 4).join(" ")}</text><text x="${x}" y="${y + 19}" fill="#87e0c0" font-size="10" text-anchor="middle">${w.slice(4, 8).join(" ")}${w.length > 8 ? "…" : ""}</text>`; }
  }
  return svg + tileSvg(X, hit, C, C, 92, col(o.id)) + `<text x="${C}" y="${C + 64}" fill="#fff" font-size="15" font-weight="700" text-anchor="middle">${o.name}</text></svg>`;
}

// ================================================================== PIPELINE lens
const STAGES = [{ k: "look", n: "Look", c: "#ffffff" }, { k: "tag", n: "Tag", c: "#e0a21b" }, { k: "detect", n: "Detect", c: "#3987e5" },
  { k: "segment", n: "Segment", c: "#9085e9", masks: true }, { k: "lift", n: "Lift to 3D", c: "#22b58a" }, { k: "track", n: "Track", c: "#e8703a" }, { k: "ledger", n: "Ledger", c: "#f3f4f6" }];
let stage = Q.get("stage") || "detect", fi = 0, lensOn = Q.get("lens") !== "0", mouse = null;
const pills = $("pills"), viewer = $("viewer"), vbase = $("vbase"), vlens = $("vlens"), bctx = vbase.getContext("2d"), lctx = vlens.getContext("2d"), strip = $("strip");
const overlay = document.createElement("canvas"), octx = overlay.getContext("2d"); let frameImgs = [];
function buildPills() { pills.innerHTML = ""; if (stage === "segment" && !X.D.masks) stage = "detect";
  for (const s of STAGES) { if (s.masks && !X.D.masks) continue; const b = document.createElement("button"); b.className = "pill"; b.dataset.k = s.k;
    b.innerHTML = `<i style="background:${s.c}"></i>${s.n}`; b.onclick = () => { stage = s.k; draw(); }; pills.appendChild(b); } }
listeners.push((X) => {
  buildPills(); frameImgs = new Array(X.D.frames.length); viewer.style.setProperty("--ar", `${X.D.res[0]}/${X.D.res[1]}`);
  fi = Q.get("frame") !== null && X.name === (Q.get("ds") || "hdepic") ? +Q.get("frame") : X.D.frames.reduce((b, f, i, F) => { const n = (g) => new Set(g.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size; return n(f) > n(F[b]) ? i : b; }, 0);
  strip.innerHTML = ""; X.D.frames.forEach((f, i) => { const im = document.createElement("img"); im.loading = "lazy"; im.src = frameSrc(X, i); im.title = fmt(f.t); im.onclick = () => { fi = i; draw(); }; strip.appendChild(im); });
  sizeViewer();
});
function sizeViewer() { const k = Math.min(devicePixelRatio, 2), w = viewer.clientWidth * k, h = viewer.clientHeight * k; for (const c of [vbase, vlens]) { c.width = w; c.height = h; } draw(); }
new ResizeObserver(() => X && sizeViewer()).observe(viewer);
viewer.addEventListener("pointermove", (e) => { const r = viewer.getBoundingClientRect(); mouse = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; drawLens(); hoverPipe(e); });
viewer.addEventListener("pointerleave", () => { mouse = null; drawLens(); hideSG(); });
addEventListener("keydown", (e) => { const r = $("pipeline").getBoundingClientRect(); if (r.top > innerHeight || r.bottom < 0 || !X) return;
  if (e.key === " ") { lensOn = !lensOn; viewer.classList.toggle("free", !lensOn); e.preventDefault(); drawLens(); }
  if (e.key === "ArrowRight") { fi = Math.min(X.D.frames.length - 1, fi + 1); draw(); } if (e.key === "ArrowLeft") { fi = Math.max(0, fi - 1); draw(); } });
function chip(ctx, x, y, text, color, S) {
  ctx.font = `600 ${Math.round(S * 0.02)}px Inter, -apple-system, sans-serif`; const w = ctx.measureText(text).width + S * 0.018, h = S * 0.031;
  ctx.fillStyle = "rgba(10,12,15,.78)"; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, S * 0.0016);
  ctx.beginPath(); ctx.roundRect(x, y - h, w, h, h / 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#fff"; ctx.fillText(text, x + S * 0.009, y - h * 0.3); return w;
}
function poly(ctx, p, W, H) { ctx.beginPath(); for (let i = 0; i < p.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, p[i] * W, p[i + 1] * H); ctx.closePath(); }
function renderOverlay(f, W, H) {
  overlay.width = W; overlay.height = H; const c = octx, S = Math.max(W, H); c.clearRect(0, 0, W, H); if (stage === "look") return;
  if (stage === "tag") {
    c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(0, 0, W, H); const placed = new Set(); let y = H * 0.08, x = W * 0.03;
    for (const tg of f.tags) { const d = f.dets.filter((q) => q.tag === tg).sort((a, b) => b.s - a.s)[0]; if (d) { chip(c, d.box[0] * W, d.box[1] * H, tg, "#e0a21b", S); placed.add(tg); } }
    for (const tg of f.tags) if (!placed.has(tg)) { c.font = `600 ${Math.round(S * 0.02)}px Inter, sans-serif`; const w = c.measureText(tg).width + S * 0.03; if (x + w > W * 0.97) { x = W * 0.03; y += S * 0.042; } x += chip(c, x, y, tg, "rgba(224,162,27,.6)", S) + S * 0.008; }
    return;
  }
  for (const d of f.dets) {
    const x0 = d.box[0] * W, y0 = d.box[1] * H, x1 = d.box[2] * W, y1 = d.box[3] * H;
    if (stage === "detect") { c.strokeStyle = d.s > 0.25 ? "#3987e5" : "rgba(57,135,229,.45)"; c.lineWidth = S * 0.0028; c.strokeRect(x0, y0, x1 - x0, y1 - y0); if (d.s > 0.25) chip(c, x0, y0, `${d.tag} ${d.s.toFixed(2)}`, "#3987e5", S); }
    else if (stage === "segment") { if (!d.poly.length) continue; poly(c, d.poly, W, H); c.fillStyle = `hsla(${(d.tag.length * 47) % 360},70%,60%,.42)`; c.fill(); c.strokeStyle = "#fff"; c.lineWidth = S * 0.0015; c.stroke(); }
    else if (stage === "lift") {
      if (!d.cam) { c.strokeStyle = "rgba(255,255,255,.16)"; c.lineWidth = S * 0.002; c.strokeRect(x0, y0, x1 - x0, y1 - y0); continue; }
      const z = Math.hypot(...d.cam), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = (S * 0.03) / Math.max(0.4, z);
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2); g.addColorStop(0, "rgba(34,181,138,.9)"); g.addColorStop(1, "rgba(34,181,138,0)");
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r * 2.2, 0, 7); c.fill(); c.fillStyle = "#fff"; c.beginPath(); c.arc(cx, cy, S * 0.004, 0, 7); c.fill();
      chip(c, cx + S * 0.01, cy - S * 0.008, `${z.toFixed(1)} m`, "#22b58a", S);
    } else if (d.ob !== undefined) {
      const a = stage === "ledger" ? 0.16 : 0.32;
      if (X.D.masks && d.poly.length) { poly(c, d.poly, W, H); c.fillStyle = col(d.ob, a); c.fill(); c.strokeStyle = col(d.ob); c.lineWidth = S * 0.0022; c.stroke(); }
      else { c.fillStyle = col(d.ob, a); c.fillRect(x0, y0, x1 - x0, y1 - y0); c.strokeStyle = col(d.ob); c.lineWidth = S * 0.0026; c.strokeRect(x0, y0, x1 - x0, y1 - y0); }
      if (stage === "track") chip(c, x0, y0, `#${d.ob} ${X.objById.get(d.ob).name}`, col(d.ob), S);
    }
  }
}
function drawLens() {
  const W = vlens.width, H = vlens.height; lctx.clearRect(0, 0, W, H); if (stage === "look") return;
  if (!lensOn || !mouse) { if (!lensOn || matchMedia("(hover:none)").matches) lctx.drawImage(overlay, 0, 0); else { lctx.globalAlpha = 0.18; lctx.drawImage(overlay, 0, 0); lctx.globalAlpha = 1; } return; }
  const mx = mouse[0] * W, my = mouse[1] * H, r = Math.max(W, H) * 0.2;
  lctx.save(); lctx.beginPath(); lctx.arc(mx, my, r, 0, 7); lctx.clip(); lctx.drawImage(overlay, 0, 0); lctx.restore();
  lctx.strokeStyle = "rgba(255,255,255,.9)"; lctx.lineWidth = Math.max(W, H) * 0.003; lctx.beginPath(); lctx.arc(mx, my, r, 0, 7); lctx.stroke();
}
const SIDE = {
  look: () => [`one frame every 4 s`, `<div class="big3">${X.D.frames.length}</div><div class="mini">frames from ${fmt(X.D.duration)} of video</div>`],
  tag: (f) => [`open-vocabulary tags · Qwen3.5-9B`, `<div class="tagcloud">${f.tags.map((t) => `<span>${t}</span>`).join("")}</div>`],
  detect: (f) => [`boxes · ${X.D.masks ? "SAM3" : "YOLO-World"}`, `<div class="big3">${f.dets.length}</div><div class="mini">boxes in this frame</div>`],
  segment: (f) => [`masks · SAM3`, `<div class="big3">${f.dets.filter((d) => d.poly.length).length}</div><div class="mini">object masks</div>`],
  lift: (f) => [`metric 3D · WildDet3D`, `<div class="big3">${f.dets.filter((d) => d.cam).length}</div><div class="mini">boxes placed in 3D, labelled with their distance</div>`],
  track: (f) => [`one identity per object`, `<div class="big3">${new Set(f.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size}</div><div class="mini">objects · same colour = same object in every frame</div>`],
  ledger: () => [`the memory`, `<div class="mini" style="font-size:14px;color:#cfd3da">hover any object</div>`],
};
async function draw() {
  if (!X) return; const f = X.D.frames[fi]; [...pills.children].forEach((b) => b.classList.toggle("on", b.dataset.k === stage));
  [...strip.children].forEach((c, i) => c.classList.toggle("on", i === fi)); { const c = strip.children[fi]; if (c) strip.scrollLeft = c.offsetLeft - strip.clientWidth / 2 + c.clientWidth / 2; }
  $("vlabel").textContent = `${fmt(f.t)} · frame ${fi + 1} of ${X.D.frames.length}`;
  const [t1, b1] = SIDE[stage](f); $("sideTitle").textContent = t1; $("sideBody").innerHTML = b1;
  const nl = f.dets.filter((d) => d.cam).length, no = new Set(f.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size;
  $("frameStats").innerHTML = [[f.dets.length, "boxes"], [nl, "in 3D"], [no, "objects"]].map(([a, b]) => `<div><div class="big3" style="font-size:28px">${a}</div><div class="mini">${b}</div></div>`).join("");
  const i0 = fi, X0 = X, im = frameImgs[fi] || (frameImgs[fi] = await loadImg(frameSrc(X, fi))); if (i0 !== fi || X0 !== X || !im) return;
  const W = vbase.width, H = vbase.height; if (!W) return; bctx.drawImage(im, 0, 0, W, H); renderOverlay(f, W, H); drawLens();
}
function hoverPipe(e) {
  if (!(stage === "ledger" || stage === "track") || !mouse || !X) { hideSG(); return; }
  const f = X.D.frames[fi], hit = pick(f, mouse[0], mouse[1]); if (!hit) { hideSG(); return; } showSG(sceneGraph(X, hit, f, f.t), e);
}

// ================================================================== COLLAPSE (re-identification)
const cv = $("collapse"), cx2 = cv.getContext("2d"), stepsEl = $("steps"), mg = $("merges");
let tiles = [], cstep = 0, hoverPile = null, piles = [], lastW = 0, autoStep = null;
listeners.push((X) => {
  const F = X.D.funnel; $("csub").innerHTML = `${F.detections.toLocaleString()} sightings → <b>${F.objects} objects</b> · drag the steps or hover a pile`;
  tiles = X.D.frames.flatMap((f) => f.dets.map((d) => ({ d: { ...d, t: f.t }, x: 0, y: 0, s: 0, a: 1, tx: 0, ty: 0, ts: 0, ta: 1 })));
  stepsEl.innerHTML = ""; [[F.detections, "boxes"], [F.lifted, "in 3D"], [F.clusters, "3D clusters"], [F.objects, "objects"]].forEach(([n, l], i) => {
    const b = document.createElement("button"); b.innerHTML = `<b>${n.toLocaleString()}</b>${l}`; b.onclick = () => setStep(i); stepsEl.appendChild(b); });
  mg.innerHTML = "";
  for (const o of X.D.objects.filter((o) => new Set(o.tags).size > 1)) {
    const el = document.createElement("div"); el.className = "merge";
    for (const d of (X.detsByOb.get(o.id) || []).slice(0, 3)) { const c = document.createElement("canvas"); c.width = c.height = 48; const [sx, sy] = tileXY(X, d.id); c.getContext("2d").drawImage(X.sprite, sx, sy, 48, 48, 0, 0, 48, 48); el.appendChild(c); }
    el.insertAdjacentHTML("beforeend", `<span>${[...new Set(o.tags)].join(" + ")} → <b style="color:#fff">one object</b></span>`);
    el.onclick = () => { setStep(3); setTimeout(() => (hoverPile = piles.find((p) => p.ob === o.id) || null), 900); }; mg.appendChild(el);
  }
  hoverPile = null; lastW = 0; setStep(+(Q.get("cstep") || 0)); sizeC(); if (Q.get("pile")) setTimeout(() => (hoverPile = piles.find((p) => p.ob === +Q.get("pile")) || null), 1200);
});
function layout() {
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !tiles.length) return;
  if (cstep <= 1) { const s = Math.max(6, Math.floor(Math.sqrt(((W - 20) * (H - 20)) / tiles.length))), cols = Math.floor((W - 20) / s);
    tiles.forEach((t, i) => { t.tx = 10 + (i % cols) * s; t.ty = 10 + Math.floor(i / cols) * s; t.ts = s - 1; t.ta = cstep === 1 && !t.d.world ? 0.08 : 1; }); piles = []; return; }
  const key = cstep === 2 ? (d) => (d.cl !== undefined ? "c" + d.cl : null) : (d) => (d.ob !== undefined ? "o" + d.ob : null), groups = new Map();
  for (const t of tiles) { const k = key(t.d); if (k === null) { t.ta = 0; continue; } if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const gs = [...groups.entries()].sort((a, b) => b[1].length - a[1].length), cell = Math.floor(Math.sqrt(((W - 20) * (H - 20)) / gs.length)), cols = Math.max(1, Math.floor((W - 20) / cell));
  piles = gs.map(([k, ts], i) => { const px = 10 + (i % cols) * cell + cell / 2, py = 10 + Math.floor(i / cols) * cell + cell / 2, s = Math.min(cell * 0.62, 90);
    ts.forEach((t, j) => { const o = Math.min(j, 6) * 2; t.tx = px - s / 2 + o; t.ty = py - s / 2 - o; t.ts = s; t.ta = 1; });
    const names = [...new Set(ts.map((t) => t.d.tag))]; return { ts, px, py, s, ob: ts[0].d.ob, names, merged: cstep === 3 && names.length > 1 }; });
}
function setStep(i) { cstep = i; [...stepsEl.children].forEach((b, j) => b.classList.toggle("on", j === i)); layout(); }
function sizeC() { const dpr = Math.min(devicePixelRatio, 2); cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; cx2.setTransform(dpr, 0, 0, dpr, 0, 0); layout();
  const snap = Math.abs(cv.clientWidth - lastW) > 40; lastW = cv.clientWidth; tiles.forEach((t) => { if (snap || !t.s) Object.assign(t, { x: t.tx, y: t.ty, s: t.ts, a: t.ta }); }); }
new ResizeObserver(() => tiles.length && sizeC()).observe(cv);
cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; hoverPile = piles.find((p) => Math.abs(p.px - x) < p.s * 0.7 && Math.abs(p.py - y) < p.s * 0.7) || null; });
cv.addEventListener("pointerleave", () => (hoverPile = null));
new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && cstep === 0 && !Q.get("cstep") && !autoStep) { let i = 0; autoStep = setInterval(() => { if (++i > 3) { clearInterval(autoStep); autoStep = null; return; } setStep(i); }, 2200); } }), { threshold: 0.5 }).observe(cv);
function frameC() {
  const W = cv.clientWidth, H = cv.clientHeight, T = X.D.sprite.tile; cx2.clearRect(0, 0, W, H);
  for (const t of tiles) { t.x += (t.tx - t.x) * 0.12; t.y += (t.ty - t.y) * 0.12; t.s += (t.ts - t.s) * 0.12; t.a += (t.ta - t.a) * 0.12; }
  for (const t of tiles) { if (t.a < 0.02) continue; const [sx, sy] = tileXY(X, t.d.id); cx2.globalAlpha = t.a; cx2.drawImage(X.sprite, sx, sy, T, T, t.x, t.y, t.s, t.s); }
  cx2.globalAlpha = 1;
  for (const p of piles) if (p.merged) { cx2.strokeStyle = "#e8703a"; cx2.lineWidth = 2; cx2.beginPath(); cx2.roundRect(p.px - p.s * 0.62, p.py - p.s * 0.66, p.s * 1.26, p.s * 1.26, 8); cx2.stroke(); }
  if (hoverPile) {
    const p = hoverPile, n = Math.min(p.ts.length, 24), R0 = Math.max(70, p.s * 1.2), s = 46; cx2.fillStyle = "rgba(6,7,8,.72)"; cx2.fillRect(0, 0, W, H);
    const cxp = Math.min(Math.max(p.px, R0 + s), W - R0 - s), cyp = Math.min(Math.max(p.py, R0 + s), H - R0 - s - 20);
    p.ts.slice(0, n).forEach((t, j) => { const a = -Math.PI / 2 + (2 * Math.PI * j) / n, x = cxp + R0 * Math.cos(a) - s / 2, y = cyp + R0 * Math.sin(a) - s / 2;
      const [sx, sy] = tileXY(X, t.d.id); cx2.drawImage(X.sprite, sx, sy, T, T, x, y, s, s); cx2.strokeStyle = col(p.ob ?? 0); cx2.lineWidth = 2; cx2.strokeRect(x, y, s, s); });
    cx2.fillStyle = "#fff"; cx2.font = "700 15px Inter, -apple-system, sans-serif"; cx2.textAlign = "center"; cx2.fillText(p.names.join(" + "), cxp, cyp - 4);
    cx2.fillStyle = "#a4aab4"; cx2.font = "12px Inter, sans-serif"; cx2.fillText(`${p.ts.length} sightings · ${fmt(Math.min(...p.ts.map((t) => t.d.t)))}–${fmt(Math.max(...p.ts.map((t) => t.d.t)))}`, cxp, cyp + 14); cx2.textAlign = "left";
  }
}

// ================================================================== ASK: replay of the answerer
const ask3d = new View3D($("askview"), false, false), askImg = document.createElement("canvas");
Object.assign(askImg.style, { position: "absolute", inset: 0, width: "100%", height: "100%", transition: "opacity .6s", pointerEvents: "none" });
$("askview").appendChild(askImg); let askTimer = null, askT = 0;
listeners.push((X) => runAsk(X)); $("replay").onclick = () => X && runAsk(X);
async function showFrame(X, t, box) {
  const im = await loadImg(frameSrc(X, nearestFrame(X, t))); if (!im) return; const r = $("askview").getBoundingClientRect(); askImg.width = r.width * 2; askImg.height = r.height * 2;
  const g = askImg.getContext("2d"), s = Math.min(askImg.width / im.width, askImg.height / im.height), w = im.width * s, h = im.height * s, ox = (askImg.width - w) / 2, oy = (askImg.height - h) / 2;
  g.fillStyle = "#000"; g.fillRect(0, 0, askImg.width, askImg.height); g.drawImage(im, ox, oy, w, h);
  if (box) { g.strokeStyle = "#e0a21b"; g.lineWidth = 6; g.shadowColor = "#e0a21b"; g.shadowBlur = 20; g.strokeRect(ox + box[0] * w, oy + box[1] * h, (box[2] - box[0]) * w, (box[3] - box[1]) * h); g.shadowBlur = 0; }
  askImg.style.opacity = 1;
}
function runAsk(X) {
  clearTimeout(askTimer); const T = X.task, steps = $("askSteps"), opts = $("askOpts"); steps.innerHTML = ""; opts.innerHTML = ""; if (!T) { $("askQ").textContent = ""; return; }
  ask3d.set(X); askT = T.t ?? X.D.duration; askImg.style.opacity = 0;
  $("askWho").textContent = `${T.answerer} · correct in ${T.consistency} runs`; $("askQ").textContent = T.question;
  $("askLbl").textContent = T.t !== undefined ? `asked at ${fmt(T.t)}` : "asked after the video";
  (T.options || []).forEach((o, i) => { const d = document.createElement("div"); d.className = "opt"; d.textContent = `${"ABCDE"[i]}. ${o}`; opts.appendChild(d); });
  const cap = (t) => ($("askLbl").textContent = t);
  const seq = [() => { if (T.t !== undefined) { showFrame(X, T.t, T.box); cap(`what you saw when asked (${fmt(T.t)})`); } else cap("the memory, after the whole video"); }];
  for (const s of T.steps) {
    const el = document.createElement("div"); el.className = "stepx";
    if (s.kind === "search") {
      const icon = { text: "⌕", time: "◷", position: "⌖" }[s.tool] || "⌕", ids = new Set(s.hits.flatMap((h) => h.obs));
      el.innerHTML = `<div class="dot" style="background:#3987e5">${icon}</div><div><span class="chip">search ${s.tool}: ${Array.isArray(s.query) ? s.query.map((v) => v.toFixed(1)).join(", ") : s.query}</span>
        <div class="moments">${s.hits.slice(0, 5).map((h) => `<div class="moment"><img src="${frameSrc(X, nearestFrame(X, h.t))}"><div><b>${fmt(h.t)}</b> · ${h.obs.length} objects</div></div>`).join("")}</div></div>`;
      const nm = s.hits.length;
      const said = `${T.question} ${T.options ? T.options[T.answer_idx] : ""}`.toLowerCase();
      const keys = new Set([...ids].filter((id) => { const o = X.objById.get(id); return o && [o.name, ...o.tags].some((n) => said.includes(n.toLowerCase())); }));
      seq.push(() => { askImg.style.opacity = 0; ask3d.highlight(ids, keys); cap(`lit: the objects in the ${nm} memory moments this search returned`);
        const ps = [...ids].map((id) => posAt(X.objById.get(id), askT)).filter(Boolean);
        if (ps.length) { const c = ps.reduce((a, p) => a.add(X.W2T(p)), new THREE.Vector3()).multiplyScalar(1 / ps.length); ask3d.focus(c, ask3d.rad * 0.9); } });
    } else { el.innerHTML = `<div class="dot" style="background:#22b58a">✦</div><div class="think">${s.text}</div>`; seq.push(() => {}); }
    steps.appendChild(el);
  }
  const fin = document.createElement("div"); fin.className = "stepx";
  if (T.preds) {
    fin.innerHTML = `<div class="dot" style="background:#e0a21b">★</div><div><div class="verdict">${Object.entries(T.err_m).map(([n, e]) => `<span class="vb ${n === "LEDGER" ? "us" : ""}">${n} ${e == null ? "–" : e.toFixed(2) + " m"}</span>`).join("")}</div>
      <div class="mini" style="margin-top:6px">distance from the true position</div></div>`;
    seq.push(() => { askImg.style.opacity = 0; ask3d.highlight(new Set([T.answer_ob ?? -1]), new Set([T.answer_ob])); ask3d.clearExtra(); ask3d.marker(T.gt, 0xe0a21b, "★ truth", 2.4); cap("★ true position · every method's answer, joined to it");
      const C = { LEDGER: 0x3987e5, ReMEmbR: 0xe8703a, OSNOM: 0x9085e9, DirectMe: 0xe66767, "no memory": 0x8a8984 };
      let k = 0; for (const [n, p] of Object.entries(T.preds)) if (p) { ask3d.marker(p, C[n] ?? 0xffffff, `${n} ${T.err_m[n].toFixed(2)} m`, n === "LEDGER" ? 1.6 : 0.7 + 0.35 * k++); ask3d.line(p, T.gt, C[n] ?? 0xffffff); }
      ask3d.focus(T.gt, ask3d.rad * 1.1); });
  } else {
    fin.innerHTML = `<div class="dot" style="background:#e0a21b">✓</div><div><div class="verdict"><span class="vb us">LEDGER ✓</span>${Object.entries(T.baselines).filter(([, v]) => v !== null)
      .map(([n, v]) => `<span class="vb ${v ? "ok" : "no"}">${n} ${v ? "✓" : "✗"}</span>`).join("")}</div><div class="mini" style="margin-top:6px">the same question, other methods</div></div>`;
    seq.push(() => { opts.children[T.answer_idx]?.classList.add("right"); cap("the answer, from the lit memory objects"); });
  }
  steps.appendChild(fin);
  let i = 0; const go = () => { if (i >= seq.length || X.task !== T) return; seq[i](); if (i > 0) steps.children[i - 1]?.classList.add("on"); i++; askTimer = setTimeout(go, i === 1 ? 1800 : 2400); };
  go();
}

// ================================================================== CHARTS
function barChart(id, rows, unit) {
  const el = $(id), svg = el.querySelector("svg"), tip = el.querySelector(".tip"), W = 360, rh = 34, H = rows.length * rh + 10, mx = Math.max(...rows.map((r) => r[1])) * 1.12;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = rows.map(([n, v, ours], i) => `<g data-i="${i}"><text x="0" y="${i * rh + 21}" fill="${ours ? "#fff" : "#a4aab4"}" font-size="12" font-weight="${ours ? 700 : 400}">${n}</text>
      <rect x="108" y="${i * rh + 8}" width="${((W - 150) * v) / mx}" height="18" rx="4" fill="${ours ? "#3987e5" : "#3a414c"}"/>
      <text x="${114 + ((W - 150) * v) / mx}" y="${i * rh + 21}" fill="${ours ? "#9cc3f5" : "#666d78"}" font-size="12">${v}${unit}</text></g>`).join("");
  svg.querySelectorAll("g").forEach((g) => { g.onmouseenter = () => { const [n, v] = rows[+g.dataset.i]; tip.textContent = `${n}: ${v}${unit}`; tip.style.opacity = 1; };
    g.onmousemove = (e) => { const r = el.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left + 12}px`; tip.style.top = `${e.clientY - r.top - 30}px`; }; g.onmouseleave = () => (tip.style.opacity = 0); });
}
function charts(R) {
barChart("c1", R.hdepic, "%"); barChart("c2", R.vq3d, " m");
(function lineChart() {
  const el = $("c3"), svg = el.querySelector("svg"), tip = el.querySelector(".tip"), W = 360, H = 230, L = 34, B = 196, T = 14, bins = R.length.bins, series = R.length.series;
  const ys = series.flatMap((s) => s.v), lo = Math.floor(Math.min(...ys) / 5) * 5, hi = Math.ceil(Math.max(...ys) / 5) * 5;
  const Xf = (i) => L + (i * (W - L - 16)) / (bins.length - 1), Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); let s = "";
  for (let v = lo; v <= hi; v += 5) s += `<line x1="${L}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1d2229"/><text x="${L - 6}" y="${Y(v) + 4}" fill="#666d78" font-size="10" text-anchor="end">${v}</text>`;
  bins.forEach((b, i) => (s += `<text x="${Xf(i)}" y="${B + 16}" fill="#666d78" font-size="10" text-anchor="middle">${b}</text>`));
  for (const se of series) { s += `<polyline points="${se.v.map((v, i) => `${Xf(i)},${Y(v)}`).join(" ")}" fill="none" stroke="${se.c}" stroke-width="2.4" ${se.dash ? 'stroke-dasharray="5 4"' : ""}/>`;
    s += se.v.map((v, i) => `<circle cx="${Xf(i)}" cy="${Y(v)}" r="3.5" fill="${se.c}" stroke="#111419" stroke-width="2"/>`).join("");
    s += `<text x="${Xf(bins.length - 1) - 2}" y="${Y(se.v[se.v.length - 1]) - 8}" fill="${se.c}" font-size="11" text-anchor="end">${se.n}</text>`; }
  s += `<line id="xh" y1="${T}" y2="${B}" stroke="#ffffff55" opacity="0"/><rect x="${L}" y="${T}" width="${W - L - 10}" height="${B - T}" fill="transparent" id="hit"/>`; svg.innerHTML = s;
  const hit = svg.querySelector("#hit"), xh = svg.querySelector("#xh");
  hit.onmousemove = (e) => { const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, i = Math.max(0, Math.min(bins.length - 1, Math.round(((x - L) / (W - L - 16)) * (bins.length - 1))));
    xh.setAttribute("x1", Xf(i)); xh.setAttribute("x2", Xf(i)); xh.setAttribute("opacity", 1); tip.innerHTML = `<b>${bins[i]}</b><br>` + series.map((se) => `<span style="color:${se.c}">●</span> ${se.n} ${se.v[i].toFixed(1)}%`).join("<br>");
    const er = el.getBoundingClientRect(); tip.style.left = `${Math.min(e.clientX - er.left + 14, er.width - 170)}px`; tip.style.top = `${e.clientY - er.top - 40}px`; tip.style.opacity = 1; };
  hit.onmouseleave = () => { tip.style.opacity = 0; xh.setAttribute("opacity", 0); };
})();
}

// ================================================================== main loop + start
let lastCount = -1, lastEv = null;
function loop() {
  if (X) {
    const t = tNow(), n = hero3d.update(t); hero3d.render(); if (n !== lastCount) { $("count").textContent = `${n} objects`; lastCount = n; }
    fill.style.width = knob.style.left = `${(100 * t) / X.D.duration}%`; $("time").textContent = `${fmt(t)} / ${fmt(X.D.duration)}`;
    const ev = eventAt(X, t); if (ev !== lastEv) { $("ticker").textContent = ev ? ev.text : ""; lastEv = ev; }
    ask3d.update(askT); ask3d.render(); frameC();
  }
  requestAnimationFrame(loop);
}
await select(Q.get("ds") || "hdepic"); loop();
resultsP.then((R) => { try { if (R) charts(R); } catch (e) { console.error(e); } });
