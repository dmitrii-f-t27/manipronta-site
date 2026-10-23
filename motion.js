/* motion.js — our own motion engine for one-file sites (2026-10-05, DP / clodex motion-kit).
   No dependencies. Lenis is optional: if window.Lenis exists (or you pass one to start()), it drives the scroll.
   One ticker for everything, springs and tweens, scroll progress with a position vocabulary,
   and declarative patterns wired by data-attributes (see ../patterns/README.md).

   import { M } from "./motion.js";  M.start({ preloader: "#pre" });
*/
const root = document.documentElement;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const range = (p, a, b) => clamp((p - a) / (b - a));           // 0..1 inside [a,b] of a parent progress
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* device tier, read once: drives particle counts, DPR caps, hover effects */
const coarse = matchMedia("(hover: none) and (pointer: coarse)").matches;
const tier = innerWidth < 768 || coarse ? "mobile" : innerWidth < 1180 ? "tablet" : "desktop";
const dprCap = { mobile: 1.5, tablet: 1.75, desktop: 2 }[tier];

/* easings */
const ease = {
  linear: t => t,
  outCubic: t => 1 - (1 - t) ** 3,
  outQuart: t => 1 - (1 - t) ** 4,
  outExpo: t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  smooth: t => t * t * (3 - 2 * t),
  smoother: t => t * t * t * (t * (t * 6 - 15) + 10),
};

/* ---------- the ticker: one requestAnimationFrame for the page ---------- */
const subs = new Set();
let rafId = 0, last = 0, lenis = null;
function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.064, (now - (last || now)) / 1000);
  last = now;
  if (lenis) lenis.raf(now);
  for (const s of subs) {
    if (s.gap && now - s.t < s.gap) continue;
    s.t = now;
    try { s.fn(dt, now); } catch (e) { console.error("[motion]", e); subs.delete(s); }
  }
  if (!subs.size && !lenis) { cancelAnimationFrame(rafId); rafId = 0; last = 0; }
}
function tick(fn, gap = 0) {
  const s = { fn, gap, t: 0 };
  subs.add(s);
  if (!rafId) rafId = requestAnimationFrame(frame);
  return () => subs.delete(s);
}

/* ---------- springs (tension/friction like react-spring, mass 1) and tweens ---------- */
const SPRING = { soft: [90, 26], base: [170, 26], snappy: [260, 30], wobbly: [180, 12], slow: [55, 22], ink: [400, 40] };
function spring(x0 = 0, cfg = "base", onUpdate) {
  const [k, c] = Array.isArray(cfg) ? cfg : SPRING[cfg] || SPRING.base;
  const s = { x: x0, v: 0, to: x0, stop: null, onUpdate };
  s.set = (to, now) => {
    s.to = to;
    if (now || reduced) { s.x = to; s.v = 0; onUpdate && onUpdate(s.x); return s; }
    if (!s.stop) s.stop = tick(dt => {
      for (let t = 0; t < dt; t += 0.001) {                 // 1 ms sub-steps: stable at any frame rate
        const a = -k * (s.x - s.to) - c * s.v;
        s.v += a * 0.001; s.x += s.v * 0.001;
      }
      if (Math.abs(s.v) < 1e-3 && Math.abs(s.x - s.to) < 1e-3) { s.x = s.to; s.v = 0; s.stop(); s.stop = null; }
      onUpdate && onUpdate(s.x);
    });
    return s;
  };
  return s;
}
function tween(dur, fn, { ease: e = ease.outCubic, delay = 0 } = {}) {
  return new Promise(res => {
    if (reduced || dur <= 0) { fn(1); return res(); }
    let t0 = null;
    const stop = tick((dt, now) => {
      if (t0 === null) t0 = now + delay;
      const t = clamp((now - t0) / dur);
      if (now >= t0) fn(e(t));
      if (t >= 1) { stop(); res(); }
    });
  });
}
/* lerp every number inside two strings of the same shape: "translate(0px, 10%) rotate(0deg)" */
const NUM = /-?\d*\.?\d+(?:e-?\d+)?/g;
function mix(a, b, t) {
  if (typeof a === "number") return lerp(a, b, t);
  const nb = String(b).match(NUM) || [];
  let i = 0;
  return String(a).replace(NUM, n => +lerp(+n, +(nb[i++] ?? n), t).toFixed(4));
}

/* ---------- scroll progress ---------- */
/* edge spec "top bottom" = the element's top meets the viewport's bottom. Element and viewport edges:
   top | center | bottom | NN% (of the element / of the viewport). */
function edge(spec, rect, vh) {
  const [e, v] = spec.trim().split(/\s+/);
  const at = (w, size, base) => w === "top" ? base : w === "center" ? base + size / 2 : w === "bottom" ? base + size : base + size * parseFloat(w) / 100;
  return at(e, rect.height, rect.top) - at(v || "top", vh, 0);
}
function progress(el, start = "top bottom", end = "bottom top") {
  const r = el.getBoundingClientRect(), vh = innerHeight;
  const a = edge(start, r, vh), b = edge(end, r, vh);
  return b === a ? 0 : clamp(a / (a - b));
}
/* scrub(el, cb, opts) calls cb(p) with 0..1 while el is near the screen. smooth: 0 = bound to scroll,
   0.05..0.2 = lags behind (cinematic). Only calls when the value changes. */
function scrub(el, cb, { start = "top bottom", end = "bottom top", smooth = 0, gate = el } = {}) {
  let on = false, cur = null, stop = null;
  const run = () => {
    const target = progress(el, start, end);
    const next = smooth && cur !== null && !reduced ? lerp(cur, target, smooth) : target;
    if (cur === null || Math.abs(next - cur) > 1e-4) { cur = Math.abs(next - target) < 1e-4 ? target : next; cb(cur); }
  };
  const io = new IntersectionObserver(([en]) => {
    on = en.isIntersecting;
    if (on && !stop) stop = tick(run);
    if (!on && stop) { run(); stop(); stop = null; }
  }, { rootMargin: "25% 0px 25% 0px" });
  io.observe(gate);
  run();
  return () => { io.disconnect(); stop && stop(); };
}

/* ---------- split text: lines / words / chars, accessible ---------- */
function split(el, mode = "words") {
  if (el.dataset.splitDone) return [...el.querySelectorAll(".m-u")];
  const text = el.textContent.replace(/\s+/g, " ").trim();
  const mk = (cls, t) => { const s = document.createElement("span"); s.className = cls; s.setAttribute("aria-hidden", "true"); if (t != null) s.textContent = t; return s; };
  const units = [];
  /* words keep their inline wrapper (<em>, <strong>, <span class>) so styled words stay styled */
  const build = (node, out) => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const parts = n.nodeValue.split(/(\s+)/);
        parts.forEach(w => {
          if (!w) return;
          if (/^\s+$/.test(w)) { out.appendChild(document.createTextNode(" ")); return; }
          const wrap = mk("m-w");
          if (mode === "chars") [...w].forEach(ch => { const c = mk("m-u m-c", ch); wrap.appendChild(c); units.push(c); });
          else { const u = mk("m-u", w); wrap.appendChild(u); units.push(u); }
          out.appendChild(wrap);
        });
      } else if (n.nodeType === 1) { const c = n.cloneNode(false); out.appendChild(c); build(n, c); }
    });
  };
  const frag = document.createElement("div");
  build(el, frag);
  el.setAttribute("aria-label", text);
  el.replaceChildren(...frag.childNodes);
  if (mode === "lines") {                                    // group the words by their measured line
    const ws = [...el.querySelectorAll(".m-w")], lines = [];
    let top = null;
    ws.forEach(w => { const t = w.getBoundingClientRect().top; if (top === null || Math.abs(t - top) > 2) { lines.push([]); top = t; } lines[lines.length - 1].push(w); });
    units.length = 0;
    const out = lines.map(ln => {
      const line = mk("m-line"), inner = mk("m-u m-li");
      ln.forEach((w, i) => {
        let node = w.cloneNode(true);
        for (let p = w.parentElement; p && p !== el; p = p.parentElement) { const c = p.cloneNode(false); c.appendChild(node); node = c; }
        if (i) inner.appendChild(document.createTextNode(" "));
        inner.appendChild(node);
      });
      line.appendChild(inner); units.push(inner); return line;
    });
    el.replaceChildren(...out);
  }
  el.dataset.splitDone = mode;
  return units;
}

/* ---------- reveal recipes: from-state → CSS transition to the rest state ---------- */
const RECIPE = {
  up:    "translate3d(0,110%,0)",          // clipped line rise (needs .m-line / overflow)
  rise:  "translate3d(0,24px,0)",
  left:  "translate3d(-48px,0,0)",
  right: "translate3d(48px,0,0)",
  scale: "scale(.92)",
  fade:  "none",
};
function reveal(el, units, { from = "rise", stagger = 40, delay = 0, dur = 900, blur = false, easing = "cubic-bezier(.16,1,.3,1)" } = {}) {
  units = units && units.length ? units : [el];
  units.forEach((u, i) => {
    u.style.transition = reduced ? "none" : `transform ${dur}ms ${easing} ${delay + i * stagger}ms, opacity ${dur * 0.8}ms ${easing} ${delay + i * stagger}ms, filter ${dur}ms ${easing} ${delay + i * stagger}ms`;
    u.style.transform = RECIPE[from] || from;
    u.style.opacity = from === "up" ? "1" : "0";
    if (blur) u.style.filter = "blur(10px)";
  });
  return () => units.forEach(u => { u.style.transform = "none"; u.style.opacity = "1"; u.style.filter = "none"; });
}

/* ---------- page-ready store (preloader hand-off) ---------- */
let readyFlag = false;
const waiters = [];
const ready = () => readyFlag ? Promise.resolve() : new Promise(r => waiters.push(r));
function setReady() {
  if (readyFlag) return;
  readyFlag = true; root.classList.add("m-ready");
  waiters.splice(0).forEach(r => r());
  dispatchEvent(new Event("motion:ready"));
}

/* ---------- declarative patterns ---------- */
const P = {};
const num = (v, d) => (v === undefined || v === "" || isNaN(+v) ? d : +v);

/* data-reveal="up|rise|left|right|scale|fade" [data-split="lines|words|chars"] [data-stagger] [data-delay] [data-dur] [data-blur] [data-on="ready|view"] */
P.reveal = el => {
  const d = el.dataset, units = d.split ? split(el, d.split) : null;
  const from = d.reveal || (d.split === "lines" ? "up" : "rise");
  const go = reveal(el, units, { from, stagger: num(d.stagger, d.split === "chars" ? 22 : d.split === "lines" ? 90 : 40), delay: num(d.delay, 0), dur: num(d.dur, 900), blur: "blur" in d });
  const play = () => requestAnimationFrame(() => requestAnimationFrame(go));
  if (d.on === "ready") return ready().then(play);
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); ready().then(play); } }, { rootMargin: d.margin || "0px 0px -15% 0px" });
  io.observe(el);
};

/* data-scroll: writes --p (0..1) on the element while it crosses the screen, for CSS-driven effects.
   data-start / data-end take the edge vocabulary; data-smooth lags behind (0.08 = cinematic). */
P.scroll = el => {
  const d = el.dataset;
  scrub(el, p => el.style.setProperty("--p", p.toFixed(4)), { start: d.start || "top bottom", end: d.end || "bottom top", smooth: num(d.smooth, 0) });
};

/* data-pin="400" : a sticky stage that lasts 400vh. Children read --p (0..1 through the pin). */
P.pin = el => {
  const h = num(el.dataset.pin, 300);
  el.style.height = h + "vh";
  el.classList.add("m-pin");
  const stage = el.querySelector(":scope > .m-stage") || el.firstElementChild;
  scrub(el, p => { el.style.setProperty("--p", p.toFixed(4)); el.dispatchEvent(new CustomEvent("pin", { detail: p })); },
    { start: "top top", end: "bottom bottom", smooth: num(el.dataset.smooth, 0) });
};

/* data-parallax="0.15": the element drifts against the scroll by ±15% of its height (inner layer scrubs) */
P.parallax = el => {
  const k = num(el.dataset.parallax, 0.12);
  if (reduced) return;
  scrub(el, p => { el.style.transform = `translate3d(0,${((p - 0.5) * -2 * k * 100).toFixed(3)}%,0)`; }, { gate: el.parentElement || el });
};

/* data-words-light: words light up one by one as the block crosses the screen (manifesto pattern) */
P.wordsLight = el => {
  const units = split(el, "words");
  units.forEach(u => (u.style.opacity = 0.16));
  scrub(el, p => { const n = p * units.length * 1.15; units.forEach((u, i) => (u.style.opacity = 0.16 + 0.84 * clamp(n - i))); },
    { start: el.dataset.start || "top 80%", end: el.dataset.end || "bottom 45%" });
};

/* data-count="1250" [data-dur] [data-prefix] [data-suffix] [data-decimals]: counts up when seen */
P.count = el => {
  const d = el.dataset, to = +d.count, dec = num(d.decimals, 0), loc = d.locale || "pt-BR";
  const fmt = v => (d.prefix || "") + v.toLocaleString(loc, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + (d.suffix || "");
  el.textContent = fmt(0);
  const io = new IntersectionObserver(([en]) => { if (!en.isIntersecting) return; io.disconnect(); ready().then(() => tween(num(d.dur, 1600), t => (el.textContent = fmt(to * t)), { ease: ease.outExpo })); }, { rootMargin: "0px 0px -10% 0px" });
  io.observe(el);
};

/* data-rule: a hairline that draws itself (scaleX 0→1) when seen. data-rule="y" for vertical */
P.rule = el => {
  const y = el.dataset.rule === "y";
  el.style.transformOrigin = y ? "center top" : "left center";
  el.style.transform = y ? "scaleY(0)" : "scaleX(0)";
  el.style.transition = reduced ? "none" : `transform 1.1s cubic-bezier(.16,1,.3,1) ${num(el.dataset.delay, 0)}ms`;
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); ready().then(() => (el.style.transform = "none")); } });
  io.observe(el);
};

/* data-marquee="60" (px/s) [data-dir="-1"]: endless band; speeds up with scroll velocity */
P.marquee = el => {
  const track = el.firstElementChild; if (!track) return;
  track.innerHTML += track.innerHTML;                        // two copies → seamless loop
  let x = 0, lastY = scrollY, boost = 0;
  const v = num(el.dataset.marquee, 60), dir = num(el.dataset.dir, -1);
  if (reduced) return;
  tick(dt => {
    const dy = scrollY - lastY; lastY = scrollY;
    boost = lerp(boost, Math.min(12, Math.abs(dy) * 0.6), 0.08);
    const w = track.scrollWidth / 2;
    x = (x + dir * v * (1 + boost) * dt) % w;
    track.style.transform = `translate3d(${x > 0 ? x - w : x}px,0,0)`;
  });
};

/* data-hscroll inside a data-pin: the track slides sideways through the pin */
P.hscroll = el => {
  const pin = el.closest("[data-pin]"); if (!pin) return;
  const move = p => { const max = el.scrollWidth - el.parentElement.clientWidth; el.style.transform = `translate3d(${(-max * p).toFixed(1)}px,0,0)`; };
  pin.addEventListener("pin", e => move(e.detail));
};

/* data-tilt="10": the card leans toward the pointer (desktop only) */
P.tilt = el => {
  if (tier === "mobile" || reduced) return;
  const deg = num(el.dataset.tilt, 10);
  const rx = spring(0, "soft"), ry = spring(0, "soft");
  const apply = () => (el.style.transform = `perspective(900px) rotateX(${rx.x.toFixed(2)}deg) rotateY(${ry.x.toFixed(2)}deg)`);
  rx.onUpdate = ry.onUpdate = apply;
  el.addEventListener("pointermove", e => { const r = el.getBoundingClientRect(); ry.set(((e.clientX - r.left) / r.width - 0.5) * 2 * deg); rx.set(-((e.clientY - r.top) / r.height - 0.5) * 2 * deg); });
  el.addEventListener("pointerleave", () => { rx.set(0); ry.set(0); });
};

/* data-magnetic="0.35": a button pulled toward the pointer (desktop only) */
P.magnetic = el => {
  if (tier === "mobile" || reduced) return;
  const k = num(el.dataset.magnetic, 0.35), sx = spring(0, "snappy"), sy = spring(0, "snappy");
  sx.onUpdate = sy.onUpdate = () => (el.style.transform = `translate3d(${sx.x.toFixed(2)}px,${sy.x.toFixed(2)}px,0)`);
  el.addEventListener("pointermove", e => { const r = el.getBoundingClientRect(); sx.set((e.clientX - r.left - r.width / 2) * k); sy.set((e.clientY - r.top - r.height / 2) * k); });
  el.addEventListener("pointerleave", () => { sx.set(0); sy.set(0); });
};

/* data-video-scrub on a <video> inside a data-pin: the film follows the scroll (iOS-safe).
   data-range="0 0.86" = which part of the pin plays the film; afterwards it holds the last frame.
   Encode all-intra (tools/encode-scrub.sh) or seeking shows blocks. */
P.videoScrub = v => {
  const pin = v.closest("[data-pin]"); if (!pin) return;
  const [a, b] = (v.dataset.range || "0 1").split(/\s+/).map(Number);
  let target = 0, cur = 0, lastSeek = 0, still = 0;
  v.muted = true; v.playsInline = true; v.preload = "auto";
  const prime = () => { const pr = v.play(); if (pr) pr.then(() => v.pause()).catch(() => {}); };   // iOS paints frames only after play()
  v.addEventListener("loadedmetadata", prime, { once: true });
  addEventListener("touchstart", prime, { once: true, passive: true });
  pin.addEventListener("pin", e => { target = range(e.detail, a, b); });
  tick((dt, now) => {
    if (!v.duration) return;
    const prev = cur;
    cur = lerp(cur, target, reduced ? 1 : 0.12);
    if (Math.abs(cur - target) < 1e-4) cur = target;
    const t = cur * (v.duration - 0.05);
    still = Math.abs(cur - prev) < 1e-5 ? still + dt : 0;
    if (!v.paused) v.pause();
    // seek when moving (not while the previous seek paints), and re-seek every 350 ms when idle (iOS shows stale frames)
    if ((!v.seeking && Math.abs(v.currentTime - t) > 0.02 && now - lastSeek > 30) || (still > 0.35 && now - lastSeek > 350)) { v.currentTime = t; lastSeek = now; }
  });
};

/* <canvas data-sequence="frames/f_%04d.webp" data-frames="120"> inside a data-pin: image-sequence scrub
   (heavier to download than one video, but frame-perfect on every browser). */
P.sequence = c => {
  const pin = c.closest("[data-pin]"); if (!pin) return;
  const n = num(c.dataset.frames, 60), tpl = c.dataset.sequence, imgs = new Array(n), ctx = c.getContext("2d");
  const src = i => tpl.replace(/%0(\d)d/, (m, w) => String(i + 1).padStart(+w, "0"));
  let want = 0, drawn = -1;
  const load = i => { if (imgs[i]) return imgs[i]; const im = new Image(); im.decoding = "async"; im.src = src(i); imgs[i] = im; return im; };
  const size = () => { const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, dprCap); c.width = r.width * dpr; c.height = r.height * dpr; drawn = -1; };
  const cover = im => { const s = Math.max(c.width / im.naturalWidth, c.height / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s; ctx.drawImage(im, (c.width - w) / 2, (c.height - h) / 2, w, h); };
  size(); addEventListener("resize", size);
  for (let i = 0; i < n; i += Math.max(1, Math.round(n / 12))) load(i);       // key frames first, the rest lazily
  setTimeout(() => { for (let i = 0; i < n; i++) load(i); }, 600);
  pin.addEventListener("pin", e => (want = Math.round(clamp(e.detail) * (n - 1))));
  tick(() => {
    if (want === drawn) return;
    let i = want; while (i >= 0 && !(imgs[i] && imgs[i].complete && imgs[i].naturalWidth)) i--;   // nearest loaded frame below
    if (i < 0) { load(want); return; }
    cover(imgs[i]); drawn = i === want ? want : -1; if (i !== want) load(want);
  });
};

/* data-cursor-image on a list: hovering a row with data-img shows that image following the pointer (desktop) */
P.cursorImage = list => {
  if (tier === "mobile") return;
  const box = document.createElement("div"); box.className = "m-cursor-img"; const im = document.createElement("img"); box.appendChild(im); document.body.appendChild(box);
  const sx = spring(0, "soft"), sy = spring(0, "soft"), so = spring(0, "snappy");
  const apply = () => { box.style.transform = `translate3d(${sx.x}px,${sy.x}px,0) translate(-50%,-50%) scale(${0.8 + 0.2 * so.x})`; box.style.opacity = so.x; };
  sx.onUpdate = sy.onUpdate = so.onUpdate = apply;
  list.addEventListener("pointermove", e => { sx.set(e.clientX); sy.set(e.clientY); });
  list.querySelectorAll("[data-img]").forEach(row => {
    row.addEventListener("pointerenter", e => { im.src = row.dataset.img; if (!so.x) { sx.set(e.clientX, true); sy.set(e.clientY, true); } so.set(1); });
    row.addEventListener("pointerleave", () => so.set(0));
  });
};

/* ---------- preloader: waits for fonts + listed media, shows 0→100, then lifts ---------- */
async function preloader(el, { min = 900, media = [] } = {}) {
  if (!el || reduced) { el && el.remove(); setReady(); return; }
  const out = el.querySelector("[data-pre-count]"), bar = el.querySelector("[data-pre-bar]");
  let shown = 0, real = 0;
  const jobs = [document.fonts ? document.fonts.ready : Promise.resolve(), ...media.map(u => new Promise(r => {
    const isV = /\.(mp4|webm|mov)(\?|$)/i.test(u), m = isV ? document.createElement("video") : new Image();
    const done = () => r(); if (isV) { m.preload = "auto"; m.muted = true; m.oncanplaythrough = done; m.onerror = done; } else { m.onload = m.onerror = done; }
    m.src = u; setTimeout(done, 8000);
  }))];
  let fin = 0; jobs.forEach(j => j.then(() => (real = ++fin / jobs.length)));
  const t0 = performance.now();
  await new Promise(res => {
    const stop = tick(() => {
      const timeCap = clamp((performance.now() - t0) / min);
      shown = lerp(shown, Math.min(real, timeCap), 0.12);
      if (real >= 1 && timeCap >= 1 && shown > 0.995) shown = 1;
      if (out) out.textContent = String(Math.round(shown * 100)).padStart(3, "0");
      if (bar) bar.style.transform = `scaleX(${shown})`;
      if (shown === 1) { stop(); res(); }
    });
  });
  el.classList.add("m-pre-out");
  setTimeout(setReady, 250);
  setTimeout(() => el.remove(), 1400);
}

/* ---------- start ---------- */
const ATTR = { reveal: "[data-reveal],[data-split]", scroll: "[data-scroll]", pin: "[data-pin]", parallax: "[data-parallax]", wordsLight: "[data-words-light]",
  count: "[data-count]", rule: "[data-rule]", marquee: "[data-marquee]", hscroll: "[data-hscroll]", tilt: "[data-tilt]", magnetic: "[data-magnetic]",
  videoScrub: "video[data-video-scrub]", sequence: "canvas[data-sequence]", cursorImage: "[data-cursor-image]" };
function init(scope = document) {
  for (const k in ATTR) scope.querySelectorAll(ATTR[k]).forEach(el => { const key = "m" + k; if (el[key]) return; el[key] = 1; P[k](el); });
}
async function start({ preloader: pre = null, media = [], min, smooth = true, lenis: L = null } = {}) {
  root.classList.add("m-js");
  if (reduced) root.classList.add("m-reduced");
  root.dataset.tier = tier;
  const Lenis = L || window.Lenis;
  if (smooth && Lenis && !reduced && tier !== "mobile") { lenis = typeof Lenis === "function" ? new Lenis({ lerp: 0.1, smoothWheel: true }) : Lenis; if (!rafId) rafId = requestAnimationFrame(frame); }
  await (document.fonts ? document.fonts.ready : null);
  init();
  const el = typeof pre === "string" ? document.querySelector(pre) : pre;
  if (el) preloader(el, { min, media }); else setReady();
}

export const M = { start, init, ready, tick, spring, tween, ease, mix, clamp, lerp, range, progress, scrub, split, reveal, patterns: P, tier, reduced, get lenis() { return lenis; } };
window.M = M;
