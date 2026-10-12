/*! Exploded runtime v0.1 · MIT
 *
 * Takes a live, rendered UI component and shows it as an isometric stack of
 * paint layers (elevation, surface, stroke, inner surfaces, content, focus ring)
 * that you can pull apart, turn and switch between states.
 *
 * The one rule: nothing is redrawn and no number is typed by hand.
 * Every layer is the real component, cloned with the browser's own computed
 * styles and with every paint that does not belong to that layer made
 * transparent. Every measurement is read from getComputedStyle / layout.
 *
 * Classic script (works from file://). Exposes window.Exploded.
 */
(function (global) {
  "use strict";

  // ───────────────────────────────────────────── constants

  const PSEUDO_RE = /:(focus-visible|focus-within|focus|hover|active)(?![\w-])/g;
  const PSEUDO_TEST = /:(focus-visible|focus-within|focus|hover|active)(?![\w-])/;
  const SKIP_PROP = /^(transition|animation|will-change|view-transition|cursor|pointer-events|user-select|-webkit-user-select|interactivity)/;
  const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "PICTURE", "OBJECT", "EMBED"]);
  const VOID = new Set(["IMG", "INPUT", "BR", "HR", "AREA", "BASE", "COL", "EMBED", "LINK", "META", "SOURCE", "TRACK", "WBR"]);
  const TEXT_CONTROL = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const SIDES = ["Top", "Right", "Bottom", "Left"];

  const PAINTS = ["drop", "fill", "inset", "stroke", "edge", "content", "ring"];
  const INHERITED = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "color", "textTransform"];
  const SETTLE_PROPS = ["transform", "translate", "scale", "rotate", "backgroundColor", "backgroundImage", "color", "boxShadow", "opacity", "filter", "outlineColor", "outlineWidth", "borderTopColor", "textShadow"];

  const PRESETS = {
    pressable: [
      { id: "rest", label: "Rest" },
      { id: "hover", label: "Hover", pseudo: ["hover"] },
      { id: "focus", label: "Focus", pseudo: ["focus", "focus-visible", "focus-within"] },
      { id: "pressed", label: "Pressed", pseudo: ["hover", "active"] },
      { id: "disabled", label: "Disabled", attrs: { disabled: "", "aria-disabled": "true" } },
    ],
    // For components whose hover and press come from their own pointer handlers (React state,
    // motion) rather than CSS: fires real pointer and mouse events, and forces the CSS states too.
    pointer: [
      { id: "rest", label: "Rest" },
      { id: "hover", label: "Hover", pseudo: ["hover"], apply: (root, t) => pointerHover(t) },
      { id: "focus", label: "Focus", pseudo: ["focus", "focus-visible", "focus-within"], apply: (root, t) => { t.focus({ preventScroll: true, focusVisible: true }); return () => t.blur(); } },
      { id: "pressed", label: "Pressed", pseudo: ["hover", "active"], apply: (root, t) => { const out = pointerHover(t); fire(t, ["pointerdown", "mousedown"], { buttons: 1 }); return () => { fire(t, ["pointerup", "mouseup"]); out(); }; } },
    ],
    field: [
      { id: "rest", label: "Rest" },
      { id: "hover", label: "Hover", pseudo: ["hover"] },
      { id: "focus", label: "Focus", pseudo: ["focus", "focus-visible", "focus-within"] },
      { id: "invalid", label: "Invalid", attrs: { "aria-invalid": "true" }, on: "input, textarea, select" },
      { id: "disabled", label: "Disabled", attrs: { disabled: "" }, on: "input, textarea, select" },
    ],
  };

  // ───────────────────────────────────────────── small utils

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const follow = (x, t, dt, tau, calm) => (calm ? t : x + (t - x) * (1 - Math.exp(-dt / tau)));
  const px = (v) => parseFloat(v) || 0;
  const r1 = (v) => Math.round(v * 10) / 10;
  const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : String(r1(v)));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function splitTop(s, sep = ",") {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function alphaOf(c) {
    if (!c) return 0;
    c = c.trim().toLowerCase();
    if (c === "transparent") return 0;
    const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)\s*$/);
    if (slash) return slash[2] ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    const rgba = c.match(/^rgba\(([^)]*)\)/);
    if (rgba) { const p = rgba[1].split(","); return p.length === 4 ? parseFloat(p[3]) : 1; }
    return 1;
  }

  function hexOf(c) {
    const m = c && c.match(/^rgba?\(([^)]*)\)/);
    if (!m) return c;
    const p = m[1].split(",").map((s) => parseFloat(s));
    const h = "#" + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();
    return p.length === 4 && p[3] < 1 ? `${h} · ${Math.round(p[3] * 100)}%` : h;
  }

  function parseShadows(v) {
    if (!v || v === "none") return [];
    return splitTop(v).map((raw) => {
      const inset = /\binset\b/.test(raw);
      const cm = raw.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b|transparent|currentcolor)/i);
      const color = cm ? cm[0] : "currentcolor";
      const nums = raw.replace(color, " ").replace(/\binset\b/, " ").trim().split(/\s+/).map(parseFloat).filter((n) => !isNaN(n));
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      const kind = inset ? "inset" : blur === 0 && x === 0 && y === 0 && spread > 0 ? "ring" : "drop";
      return { raw, inset, color, x, y, blur, spread, alpha: alphaOf(color), kind };
    }).filter((s) => s.alpha > 0 && !(s.x === 0 && s.y === 0 && s.blur === 0 && s.spread === 0));
  }

  // ───────────────────────────────────────────── forced pseudo states
  // Every rule that uses :hover / :focus / :active is copied once with the pseudo
  // swapped for an attribute, so a state can be applied without a real pointer.

  function forcePseudo() {
    const root = document.documentElement;
    if (root.hasAttribute("data-xp-forced")) return;
    root.setAttribute("data-xp-forced", "");
    // While a state is captured, nothing may be mid-transition.
    const own = document.createElement("style");
    own.setAttribute("data-xp-own", "");
    own.textContent = "[data-xp-capturing],[data-xp-capturing] *,[data-xp-capturing] *::before,[data-xp-capturing] *::after,[data-xp-capturing]::before,[data-xp-capturing]::after{transition:none!important;animation:none!important}";
    document.head.appendChild(own);
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (sheet.ownerNode && sheet.ownerNode.hasAttribute && sheet.ownerNode.hasAttribute("data-xp-own")) continue;
      walkRules(sheet, rules);
    }
  }

  function walkRules(owner, rules) {
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (r.type === 1) {
        if (r.cssRules && r.cssRules.length) walkRules(r, r.cssRules);
        const sel = r.selectorText;
        if (!sel || !PSEUDO_TEST.test(sel)) continue;
        const forced = sel.replace(PSEUDO_RE, (_, p) => `[data-xp-${p}]`);
        const body = r.style.cssText;
        if (!body) continue;
        try { owner.insertRule(`${forced}{${body}}`, i + 1); } catch (e) { /* unsupported selector */ }
      } else if (r.cssRules && typeof r.insertRule === "function") {
        walkRules(r, r.cssRules);
      }
    }
  }

  // ───────────────────────────────────────────── declared tokens
  // Which custom property did the author actually write for this value?

  let ruleCache = null;
  function allRules() {
    if (ruleCache) return ruleCache;
    const out = [];
    const walk = (rules) => {
      for (const r of Array.from(rules)) {
        if (r.type === 1) { out.push(r); if (r.cssRules && r.cssRules.length) walk(r.cssRules); }
        else if (r.type === 4) { if (!r.media || matchMedia(r.media.mediaText).matches) walk(r.cssRules); }
        else if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const s of Array.from(document.styleSheets)) { try { walk(s.cssRules); } catch (e) { /* cross-origin */ } }
    ruleCache = out;
    return out;
  }

  function specificity(sel) {
    const s = sel.replace(/:where\([^)]*\)/g, "").replace(/:(?:not|is|has)\(([^)]*)\)/g, " $1 ");
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const cls = (s.match(/\.(?:\\.|[\w-])+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    const els = (s.replace(/\[[^\]]*\]|\([^)]*\)|\.(?:\\.|[\w-])+/g, "").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    return ids * 1e6 + cls * 1e3 + els;
  }

  const FAMILY = {
    fill: ["background-color", "background"],
    stroke: ["border-color", "border", "border-top-color", "border-top"],
    radius: ["border-radius", "border-top-left-radius"],
    padding: ["padding", "padding-inline", "padding-block", "padding-left", "padding-top"],
    color: ["color"],
    font: ["font-size", "font"],
    gap: ["gap", "column-gap", "row-gap"],
    shadow: ["box-shadow"],
    outline: ["outline", "outline-color"],
  };

  function declared(el, family, pseudo) {
    const props = FAMILY[family];
    let best = null, bestSpec = -1;
    for (const rule of allRules()) {
      let val = "";
      for (const p of props) { val = rule.style.getPropertyValue(p); if (val) break; }
      if (!val) continue;
      for (const part of splitTop(rule.selectorText || "")) {
        let target = part;
        if (pseudo) {
          if (!part.includes("::" + pseudo) && !part.includes(":" + pseudo)) continue;
          target = part.replace("::" + pseudo, "").replace(":" + pseudo, "");
        } else if (/::?(before|after|placeholder|marker)/.test(part)) continue;
        let ok = false;
        try { ok = el.matches(target || "*"); } catch (e) { ok = false; }
        if (!ok) continue;
        const sp = specificity(part);
        if (sp >= bestSpec) { bestSpec = sp; best = val; }
      }
    }
    if (!pseudo && el.style) {
      for (const p of props) { const v = el.style.getPropertyValue(p); if (v) { best = v; break; } }
    }
    if (!best) return null;
    const vars = Array.from(best.matchAll(/var\((--[\w-]+)/g)).map((m) => m[1]);
    if (!vars.length) return null;
    const mult = best.match(/calc\(\s*var\(--[\w-]+\)\s*\*\s*([\d.]+)\s*\)/);
    return mult ? `${vars[0]} × ${mult[1]}` : Array.from(new Set(vars)).join(" ");
  }

  // ───────────────────────────────────────────── capture (the truth model)

  function ownText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }

  function textRect(el, base, k) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
    }
    if (x0 === Infinity) return null;
    return { x: (x0 - base.left) / k, y: (y0 - base.top) / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
  }

  // Layout position (ignores transforms), relative to the root's border box.
  function absOffset(el) {
    let x = 0, y = 0, n = el;
    while (n) {
      x += n.offsetLeft; y += n.offsetTop;
      const p = n.offsetParent;
      if (p) { x += p.clientLeft; y += p.clientTop; }
      n = p;
    }
    return [x, y];
  }
  function layoutBox(el, root) {
    if (!(el instanceof HTMLElement)) return null;
    if (el === root) return { x: 0, y: 0, w: el.offsetWidth, h: el.offsetHeight };
    const a = absOffset(el), b = absOffset(root);
    return { x: a[0] - b[0], y: a[1] - b[1], w: el.offsetWidth, h: el.offsetHeight };
  }

  function cssTextOf(cs) {
    let s = "";
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (SKIP_PROP.test(p)) continue;
      const v = cs.getPropertyValue(p);
      // Unset, text-fill-color resolves to the colour. Freeze it as currentcolor, not that value, so
      // ::placeholder (which inherits it) keeps its own colour; freezing still blocks muted ancestors.
      if (p === "-webkit-text-fill-color" && v === cs.color) { s += `${p}:currentcolor;`; continue; }
      if (v !== "") s += `${p}:${v};`;
    }
    return s + "transition:none;animation:none;pointer-events:none;";
  }

  function pseudoContent(c) {
    if (!c || c === "none" || c === "normal") return null;
    const m = c.match(/^"((?:[^"\\]|\\.)*)"$/);
    return m ? m[1].replace(/\\(.)/g, "$1") : "";
  }

  function classify(rec) {
    const cs = rec.style;
    const fill = alphaOf(cs.backgroundColor) > 0 || (cs.backgroundImage && cs.backgroundImage !== "none");
    const stroke = SIDES.some((s) => px(cs[`border${s}Width`]) > 0 && !/none|hidden/.test(cs[`border${s}Style`]) && alphaOf(cs[`border${s}Color`]) > 0);
    const shadows = parseShadows(cs.boxShadow);
    const outline = cs.outlineStyle !== "none" && px(cs.outlineWidth) > 0 && alphaOf(cs.outlineColor) > 0;
    const replaced = rec.replaced;
    const text = !replaced && (rec.pseudo ? !!rec.content : ownText(rec.el) || TEXT_CONTROL.has(rec.el.tagName));
    const visible = cs.visibility !== "hidden" && cs.display !== "none";
    return {
      fill: visible && fill,
      stroke: visible && stroke,
      inset: visible && shadows.some((s) => s.kind === "inset"),
      drop: visible && shadows.some((s) => s.kind === "drop"),
      ring: visible && (shadows.some((s) => s.kind === "ring") || outline),
      content: visible && (text || replaced),
      shadows,
      outline,
      replaced,
      text,
      visible,
    };
  }

  function fire(el, types, init = {}) {
    for (const type of types) {
      const E = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(type, { bubbles: !/enter|leave/.test(type), cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }));
    }
  }
  function pointerHover(el) {
    fire(el, ["pointerover", "pointerenter", "mouseover", "mouseenter"]);
    return () => fire(el, ["pointerout", "pointerleave", "mouseout", "mouseleave"], { relatedTarget: null });
  }

  // A state set by the component's own code (React state, a spring) lands frames later, and a
  // component that measures itself re-renders after it moves. Wait until nothing that paints
  // has changed for two frames, or the budget (opts.settle, ms) runs out.
  const nextFrame = () => new Promise((ok) => { const t = setTimeout(ok, 100); requestAnimationFrame(() => { clearTimeout(t); ok(); }); });
  function look(root) {
    const base = root.getBoundingClientRect();
    let s = "";
    for (const el of [root, ...root.querySelectorAll("*")].slice(0, 400)) {
      const cs = getComputedStyle(el), b = el.getBoundingClientRect();
      for (const p of SETTLE_PROPS) s += cs[p] + "|";
      s += `${b.left - base.left},${b.top - base.top},${b.width},${b.height};`;
    }
    return s;
  }
  async function settle(root, budget) {
    const end = performance.now() + (budget ?? 3000);
    let prev = "", still = 0;
    await nextFrame();
    while (performance.now() < end) {
      await nextFrame();
      const s = look(root);
      if (s === prev) { if (++still >= 2) return true; } else { still = 0; prev = s; }
    }
    return false;
  }

  // Canvas pixels don't survive cloneNode, so each canvas is copied once per state. A WebGL
  // buffer is only readable between the page drawing it and the frame being shown, so the copy
  // runs right after the page's own next frame callback: requestAnimationFrame is wrapped for
  // that one frame. A canvas with no render loop is copied after a short wait.
  function afterPageFrame() {
    return new Promise((ok) => {
      const orig = window.requestAnimationFrame;
      let done = false;
      const finish = () => { if (done) return; done = true; window.requestAnimationFrame = orig; ok(); };
      window.requestAnimationFrame = (cb) => orig.call(window, (t) => { try { cb(t); } finally { finish(); } });
      setTimeout(finish, 300);
    });
  }
  function isBlank(c) {
    const t = document.createElement("canvas");
    t.width = t.height = 24;
    const x = t.getContext("2d");
    x.drawImage(c, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }
  async function canvasShots(root) {
    const list = [root, ...root.querySelectorAll("canvas")].filter((c) => c.tagName === "CANVAS");
    const out = new Map();
    for (let attempt = 0; attempt < 4 && list.length; attempt++) {
      await afterPageFrame();
      for (const c of list) {
        const copy = document.createElement("canvas");
        copy.width = c.width; copy.height = c.height;
        try { copy.getContext("2d").drawImage(c, 0, 0); } catch (e) { /* lost context or tainted */ }
        out.set(c, copy);
      }
      if (list.every((c) => !isBlank(out.get(c)))) break;
    }
    return out;
  }
  // A canvas that draws on its own (a render loop) never settles: compare two small samples.
  async function canvasStill(root) {
    const a = await canvasShots(root);
    if (!a.size) return true;
    await new Promise((ok) => setTimeout(ok, 150));
    const b = await canvasShots(root);
    const sig = (m) => Array.from(m.values()).map((c) => {
      const t = document.createElement("canvas");
      t.width = t.height = 24;
      const x = t.getContext("2d");
      x.drawImage(c, 0, 0, 24, 24);
      return x.getImageData(0, 0, 24, 24).data.join(",");
    }).join("|");
    return sig(a) === sig(b);
  }
  function paintCanvases(clone, cap) {
    for (const c of [clone, ...clone.querySelectorAll("canvas")]) {
      if (c.tagName !== "CANVAS") continue;
      const rec = cap.recs.find((r) => r.id === c.getAttribute("data-xp-id"));
      if (rec && rec.pixels) c.getContext("2d").drawImage(rec.pixels, 0, 0);
    }
  }

  // A spread-only shadow that is already there at rest is an edge (an outline drawn with a
  // shadow) and goes with the strokes. One that only appears in a state is a focus ring.
  function markEdges(caps) {
    const atRest = new Map();
    for (const r of caps[0].recs) if (r.paint) atRest.set(r.id, new Set(r.paint.shadows.filter((x) => x.kind === "ring").map((x) => x.spread)));
    for (const cap of caps) for (const r of cap.recs) {
      if (!r.paint) continue;
      const rest = atRest.get(r.id);
      for (const x of r.paint.shadows) if (x.kind === "ring" && rest && rest.has(x.spread)) x.kind = "edge";
      r.paint.ring = r.paint.visible && (r.paint.shadows.some((x) => x.kind === "ring") || r.paint.outline);
      r.paint.edge = r.paint.visible && r.paint.shadows.some((x) => x.kind === "edge");
    }
  }

  // A part's own offset, so a press that only moves something still reads in the summary.
  function moveOf(r) {
    const t = r.style.transform || "";
    const m = /^matrix\(([^)]+)\)/.exec(t);
    if (m) { const v = m[1].split(",").map(parseFloat); return Math.abs(v[4]) >= 0.5 || Math.abs(v[5]) >= 0.5 ? ` shifted ${fmt(v[4])}, ${fmt(v[5])}` : ""; }
    const m3 = /^matrix3d\(([^)]+)\)/.exec(t);
    if (m3) { const z = parseFloat(m3[1].split(",")[14]); return Math.abs(z) >= 0.5 ? ` z ${fmt(z)}` : ""; }
    return "";
  }

  function applyState(root, target, state) {
    const undo = [];
    const set = (el, name, value) => {
      const had = el.hasAttribute(name), prev = el.getAttribute(name);
      el.setAttribute(name, value);
      undo.push(() => (had ? el.setAttribute(name, prev) : el.removeAttribute(name)));
    };
    for (const p of state.pseudo || []) {
      const chain = [];
      if (p === "focus" || p === "focus-visible") chain.push(target);
      else for (let n = target; n; n = n === root ? null : n.parentElement) chain.push(n);
      for (const el of chain) set(el, `data-xp-${p}`, "");
    }
    for (const [k, v] of Object.entries(state.attrs || {})) {
      const el = state.on ? root.querySelector(state.on) || target : target;
      if (k === "disabled" && !("disabled" in el)) continue;
      set(el, k, v);
    }
    if (state.apply) { const u = state.apply(root, target); if (typeof u === "function") undo.push(u); }
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  }

  async function capture(root, target, state, opts) {
    root.setAttribute("data-xp-capturing", "");
    const undo = applyState(root, target, state);
    const settled = (await settle(root, opts.settle)) && (await canvasStill(root));
    const shots = await canvasShots(root);
    const base = root.getBoundingClientRect();
    // Only a transformed root changes scale; offsetWidth rounds, so never divide by it otherwise.
    const k = getComputedStyle(root).transform === "none" ? 1 : base.width / (root.offsetWidth || base.width) || 1;
    const els = [root, ...root.querySelectorAll("*")];
    const recs = [];
    const idOf = new Map();
    els.forEach((el, i) => idOf.set(el, String(i)));
    for (const el of els) {
      if (el.closest("[data-xp-ignore]")) continue;
      const id = idOf.get(el);
      const inSvg = el instanceof SVGElement && !(el instanceof SVGSVGElement);
      const cs = getComputedStyle(el);
      const br = el.getBoundingClientRect();
      const rec = {
        id, el, pseudo: null, parent: el === root ? null : idOf.get(el.parentElement),
        inSvg,
        replaced: el instanceof SVGSVGElement || REPLACED.has(el.tagName) || (el.tagName === "INPUT" && /checkbox|radio|range|color|file/.test(el.type) && cs.appearance !== "none"),
        css: cssTextOf(cs),
        style: snapshotStyle(cs),
        rect: { x: (br.left - base.left) / k, y: (br.top - base.top) / k, w: br.width / k, h: br.height / k },
        box: layoutBox(el, root),
        pixels: shots.get(el),
      };
      rec.paint = inSvg ? null : classify(rec);
      if (rec.paint && rec.paint.text) rec.textRect = rec.pseudo ? null : textRect(el, base, k);
      if (!inSvg) rec.tokens = tokensOf(el, rec, null, opts);
      recs.push(rec);
      if (!inSvg && !VOID.has(el.tagName) && !(el instanceof SVGElement)) {
        for (const which of ["before", "after"]) {
          const pcs = getComputedStyle(el, "::" + which);
          const content = pseudoContent(pcs.content);
          if (content === null || pcs.display === "none") continue;
          const prec = {
            id: `${id}:${which}`, el, pseudo: which, parent: id, content, inSvg: false, replaced: false,
            css: cssTextOf(pcs), style: snapshotStyle(pcs), rect: null, box: null,
          };
          prec.paint = classify(prec);
          prec.tokens = tokensOf(el, prec, which, opts);
          recs.push(prec);
        }
      }
    }
    // Gaps between children of flex/grid containers.
    for (const rec of recs) {
      if (rec.pseudo || rec.inSvg) continue;
      const cs = rec.style;
      if (!/flex|grid/.test(cs.display)) continue;
      const gap = px(cs.columnGap) || px(cs.rowGap);
      if (!gap) continue;
      // Flex items include anonymous text runs ("Deploy" between an icon and a chip).
      const kids = [];
      for (const n of rec.el.childNodes) {
        if (n.nodeType === 1) {
          const c = recs.find((x) => x.el === n && !x.pseudo);
          if (c && c.rect && c.rect.w > 0 && c.style.position !== "absolute" && c.style.display !== "none") kids.push(c);
        } else if (n.nodeType === 3 && n.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width > 0) kids.push({ rect: { x: (r.left - base.left) / k, y: (r.top - base.top) / k, w: r.width / k, h: r.height / k } });
        }
      }
      if (kids.length < 2) continue;
      const row = /flex/.test(cs.display) ? !/column/.test(cs.flexDirection) : true;
      rec.gaps = [];
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1].rect, b = kids[i].rect;
        if (row && b.x > a.x + a.w - 0.5) rec.gaps.push({ axis: "x", x: a.x + a.w, y: Math.min(a.y, b.y), w: b.x - (a.x + a.w), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });
        else if (!row && b.y > a.y + a.h - 0.5) rec.gaps.push({ axis: "y", x: Math.min(a.x, b.x), y: a.y + a.h, w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: b.y - (a.y + a.h) });
      }
      rec.gapValue = row ? px(cs.columnGap) : px(cs.rowGap);
      rec.gapToken = rec.tokens && rec.tokens.gap;
    }
    // The frozen clone: the component as it is in this state, every computed
    // value written inline so it renders the same anywhere in the document.
    const frozen = root.cloneNode(true);
    const cloneEls = [frozen, ...frozen.querySelectorAll("*")];
    const byId = new Map(recs.filter((r) => !r.pseudo).map((r) => [r.id, r]));
    cloneEls.forEach((c, i) => {
      const rec = byId.get(String(i));
      if (!rec) return;
      const src = els[i];
      for (const a of Array.from(c.attributes)) if (a.name.startsWith("data-xp-")) c.removeAttribute(a.name);
      c.removeAttribute("id");
      c.setAttribute("data-xp-id", rec.id);
      c.setAttribute("style", rec.css);
      c.setAttribute("tabindex", "-1");
      if (src.tagName === "INPUT" || src.tagName === "TEXTAREA") { c.value = src.value; if ("checked" in src) c.checked = src.checked; }
      for (const p of recs) {
        if (p.parent !== rec.id || !p.pseudo) continue;
        const span = document.createElement("span");
        span.setAttribute("data-xp-id", p.id);
        span.setAttribute("style", p.css);
        span.textContent = p.content;
        if (p.pseudo === "before") c.insertBefore(span, c.firstChild); else c.appendChild(span);
      }
    });
    frozen.style.setProperty("position", "relative", "important");
    for (const prop of ["inset", "top", "left", "right", "bottom", "margin", "translate", "float"]) frozen.style.removeProperty(prop);
    frozen.style.setProperty("margin", "0", "important");
    frozen.setAttribute("aria-hidden", "true");
    frozen.setAttribute("inert", "");
    const size = { w: root.offsetWidth, h: root.offsetHeight };
    undo();
    await settle(root, opts.settle);
    root.removeAttribute("data-xp-capturing");
    return { state, recs, frozen, settled, ...size };
  }

  function snapshotStyle(cs) {
    const keys = ["display", "position", "visibility", "backgroundColor", "backgroundImage", "boxShadow", "outlineStyle", "outlineWidth", "outlineColor", "outlineOffset",
      "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "color", "fontSize", "lineHeight", "fontWeight",
      "fontFamily", "letterSpacing", "columnGap", "rowGap", "flexDirection", "opacity", "transform", "appearance", "backdropFilter"];
    const o = {};
    for (const k of keys) o[k] = cs[k];
    for (const s of SIDES) { o[`border${s}Width`] = cs[`border${s}Width`]; o[`border${s}Style`] = cs[`border${s}Style`]; o[`border${s}Color`] = cs[`border${s}Color`]; }
    return o;
  }

  function tokensOf(el, rec, pseudo, opts) {
    if (opts && opts.tokens === false) return {};
    const out = {};
    for (const fam of Object.keys(FAMILY)) { const t = declared(el, fam, pseudo); if (t) out[fam] = t; }
    return out;
  }

  // ───────────────────────────────────────────── layers

  function planLayers(captures, opts) {
    // Union across states so the stack never changes shape: a plate that is
    // empty at rest (the focus ring) is still there, waiting.
    const surfaceIds = new Set();
    const parentOf = new Map();
    const anyRec = new Map();
    for (const cap of captures) for (const r of cap.recs) {
      parentOf.set(r.id, r.parent);
      if (!anyRec.has(r.id)) anyRec.set(r.id, r);
      if (r.paint && (r.paint.fill || r.paint.stroke || r.paint.inset)) surfaceIds.add(r.id);
    }
    const depthOf = (id) => { let d = 0; for (let n = id; n != null; n = parentOf.get(n)) if (surfaceIds.has(n)) d++; return d; };
    const split = opts.splitStroke || "root";
    const parts = opts.parts || {};
    const partOf = (rec) => {
      if (rec.pseudo) return null;
      for (const [sel, name] of Object.entries(parts)) { try { if (rec.el.matches(sel)) return name; } catch (e) { /* */ } }
      return null;
    };
    // A named part at the top level gets its own sheet; deeper ones share their depth's sheet.
    const plateOf = (rec, paint) => {
      const d = Math.max(1, depthOf(rec.id));
      if (paint === "fill" || paint === "inset") { const name = d === 1 && partOf(rec); return name ? `surface:1:${name}` : `surface:${d}`; }
      if (paint === "stroke" || paint === "edge") return split === "all" || (split === "root" && d === 1) ? `stroke:${d}` : `surface:${d}`;
      if (paint === "drop") return "elevation";
      if (paint === "ring") return "ring";
      if (paint === "content") return "content";
      return null;
    };
    const used = new Map();
    for (const cap of captures) for (const r of cap.recs) {
      if (!r.paint) continue;
      for (const p of PAINTS) {
        if (!r.paint[p]) continue;
        const key = plateOf(r, p);
        if (!used.has(key)) used.set(key, new Set());
        used.get(key).add(r.id);
      }
    }
    const rank = (key) => {
      const [kind, d] = key.split(":");
      if (kind === "elevation") return 0;
      if (kind === "surface") return Number(d) * 10 + Math.min(...Array.from(used.get(key), (id) => parseInt(id, 10))) / 1e6;
      if (kind === "stroke") return Number(d) * 10 + 5;
      if (kind === "content") return 1e4;
      return 1e5;
    };
    const keys = Array.from(used.keys()).sort((a, b) => rank(a) - rank(b));
    const nameOf = (key) => {
      const [kind, d, ...named0] = key.split(":");
      if (named0.length) return named0.join(":");
      const ids = Array.from(used.get(key));
      if (kind === "elevation") return "Elevation";
      if (kind === "content") return "Content";
      if (kind === "ring") return "Focus ring";
      if (kind === "stroke") return Number(d) === 1 ? "Stroke" : `Stroke ${d}`;
      if (Number(d) === 1) return "Surface";
      const named = ids.map((id) => partOf(anyRec.get(id)));
      const uniq = Array.from(new Set(named.filter(Boolean)));
      if (uniq.length && named.every(Boolean)) return uniq.join(" + ");
      return ids.length === 1 ? describe(anyRec.get(ids[0])) : `Inner surfaces · ${ids.length}`;
    };
    return { keys: keys.map((key) => ({ key, name: nameOf(key), ids: used.get(key) })), plateOf };
  }

  function describe(rec) {
    if (rec.pseudo) return `::${rec.pseudo}`;
    const el = rec.el;
    const label = el.getAttribute("data-xp-name") || el.getAttribute("aria-label");
    if (label) return label;
    const cls = Array.from(el.classList).find((c) => /^[a-z][a-z0-9-_]*$/i.test(c) && c.length < 24);
    return cls ? cls.replace(/[-_]/g, " ").replace(/^\w/, (m) => m.toUpperCase()) : el.tagName.toLowerCase();
  }

  function paintLayer(frozen, cap, plan, key) {
    const clone = frozen.cloneNode(true);
    const byId = new Map(cap.recs.map((r) => [r.id, r]));
    for (const c of [clone, ...clone.querySelectorAll("[data-xp-id]")]) {
      const rec = byId.get(c.getAttribute("data-xp-id"));
      if (!rec || !rec.paint) continue;
      const P = rec.paint, st = c.style;
      const imp = (p, v) => st.setProperty(p, v, "important");
      if (!(P.fill && plan.plateOf(rec, "fill") === key)) { imp("background-color", "transparent"); imp("background-image", "none"); imp("backdrop-filter", "none"); }
      if (!(P.stroke && plan.plateOf(rec, "stroke") === key)) imp("border-color", "transparent");
      const keep = P.shadows.filter((s) => plan.plateOf(rec, s.kind) === key).map((s) => s.raw);
      imp("box-shadow", keep.length ? keep.join(", ") : "none");
      if (!(P.outline && plan.plateOf(rec, "ring") === key)) imp("outline-color", "transparent");
      if (!(P.content && plan.plateOf(rec, "content") === key)) {
        for (const p of ["color", "-webkit-text-fill-color", "text-decoration-color", "caret-color", "-webkit-text-stroke-color", "text-emphasis-color"]) imp(p, "transparent");
        imp("text-shadow", "none");
        if (P.replaced) imp("opacity", "0");
        c.classList && c.classList.add("xp-mute-ph");
      }
    }
    return clone;
  }

  // ───────────────────────────────────────────── measurements drawn on plates

  function redlines(cap, plan, key, opts) {
    // u is one screen pixel in model units, so labels and hairlines keep their
    // size on screen whatever the component's scale.
    const u = opts.u || 1;
    const FS = 8.5 * u, CW = FS * 0.6, LH = FS * 1.1;
    const recs = cap.recs.filter((r) => r.paint && !r.pseudo && r.rect);
    const out = [];
    const placed = [];
    const fits = (x, y, w, h) => {
      for (const b of placed) if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return false;
      placed.push({ x, y, w, h });
      return true;
    };
    const T = (x, y, s, anchor = "middle", force) => {
      const w = String(s).length * CW + 2 * u;
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      if (!fits(x0, y - FS, w, LH) && !force) return false;
      out.push(`<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}">${esc(s)}</text>`);
      return true;
    };
    const box = (b, cls) => out.push(`<rect class="${cls}" x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(Math.max(0, b.w))}" height="${r1(Math.max(0, b.h))}"/>`);
    const path = (d, cls = "xp-dim") => out.push(`<path class="${cls}" d="${d}"/>`);
    const tick = 3 * u;
    const dimX = (x0, x1, y, label) => {
      path(`M${r1(x0)} ${r1(y)}H${r1(x1)}M${r1(x0)} ${r1(y - tick)}v${r1(tick * 2)}M${r1(x1)} ${r1(y - tick)}v${r1(tick * 2)}`);
      if (label) T((x0 + x1) / 2, y + FS + 2 * u, label, "middle", true);
    };
    const [kind] = key.split(":");
    const ids = plan.keys.find((k) => k.key === key).ids;
    const owners = recs.filter((r) => ids.has(r.id));
    const tok = !!opts.showTokens;
    const mid = FS * 0.35;
    // Printed glyphs are obstacles: a label never sits on the text it measures.
    if (kind === "content") for (const r of owners) { if (r.textRect) placed.push(r.textRect); else if (r.paint.replaced) placed.push(r.rect); }

    if (kind === "surface") {
      const main = owners.filter((r) => r.paint.fill || r.paint.stroke || r.paint.inset).sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 4);
      main.forEach((r, ri) => {
        const s = r.style, b = r.rect;
        const pt = px(s.paddingTop), pr = px(s.paddingRight), pb = px(s.paddingBottom), pl = px(s.paddingLeft);
        const bl = px(s.borderLeftWidth), btw = px(s.borderTopWidth), brw = px(s.borderRightWidth), bbw = px(s.borderBottomWidth);
        const ix = b.x + bl, iy = b.y + btw, iw = b.w - bl - brw, ih = b.h - btw - bbw;
        path(`M${r1(b.x)} ${r1(b.y)}h${r1(b.w)}v${r1(b.h)}h${r1(-b.w)}z`, "xp-dim xp-soft");
        if (pt) box({ x: ix, y: iy, w: iw, h: pt }, "xp-pad");
        if (pb) box({ x: ix, y: iy + ih - pb, w: iw, h: pb }, "xp-pad");
        if (pl) box({ x: ix, y: iy + pt, w: pl, h: ih - pt - pb }, "xp-pad");
        if (pr) box({ x: ix + iw - pr, y: iy + pt, w: pr, h: ih - pt - pb }, "xp-pad");
        const padTok = tok && r.tokens && r.tokens.padding;
        if (ri === 0 && padTok) T(ix + iw / 2, iy + ih / 2 + mid, `pad ${padTok}`);
        else {
          if (pl >= 4) T(ix + pl / 2, iy + ih / 2 + mid, fmt(pl));
          if (pr >= 4 && Math.abs(pr - pl) > 0.01) T(ix + iw - pr / 2, iy + ih / 2 + mid, fmt(pr));
          else if (pr >= 4 && ri === 0) T(ix + iw - pr / 2, iy + ih / 2 + mid, fmt(pr));
          if (pt >= 4) T(ix + iw / 2, iy + pt / 2 + mid, fmt(pt));
          if (pb >= 4 && Math.abs(pb - pt) > 0.01) T(ix + iw / 2, iy + ih - pb / 2 + mid, fmt(pb));
        }
        const rad = Math.min(px(s.borderTopLeftRadius), b.w / 2, b.h / 2);
        if (rad >= 2) {
          path(`M${r1(b.x)} ${r1(b.y + rad)}A${r1(rad)} ${r1(rad)} 0 0 1 ${r1(b.x + rad)} ${r1(b.y)}`);
          const radTxt = tok && r.tokens && r.tokens.radius ? r.tokens.radius : `r ${fmt(px(s.borderTopLeftRadius))}`;
          T(b.x + rad + 2 * u, b.y - 3 * u, radTxt, "start");
        }
        // The size label reads the layout box, the same numbers as the readout, so it never drifts by a subpixel between states.
        if (ri === 0) { const sz = r.box || b; dimX(b.x, b.x + b.w, b.y + b.h + 8 * u, `${fmt(sz.w)} × ${fmt(sz.h)}`); }
      });
    } else if (kind === "stroke") {
      for (const r of owners.filter((o) => o.paint.stroke).slice(0, 3)) {
        const b = r.rect, w = px(r.style.borderTopWidth) || px(r.style.borderLeftWidth);
        path(`M${r1(b.x)} ${r1(b.y)}h${r1(b.w)}v${r1(b.h)}h${r1(-b.w)}z`, "xp-dim xp-soft");
        T(b.x + b.w / 2, b.y - 4 * u, tok && r.tokens && r.tokens.stroke ? r.tokens.stroke : `${fmt(w)}px · ${hexOf(r.style.borderTopColor)}`);
      }
    } else if (kind === "content") {
      for (const r of recs) {
        if (!r.gaps) continue;
        for (const g of r.gaps) {
          box(g, "xp-gap");
          // A gap wider than the declared gap carries a margin too: say both, e.g. "8 + 2".
          const span = g.axis === "x" ? g.w : g.h, extra = span - r.gapValue;
          const base = tok && r.gapToken ? r.gapToken : fmt(r.gapValue);
          const label = Math.abs(extra) > 0.5 ? `${base} + ${fmt(extra)}` : base;
          if (g.axis === "x") T(g.x + g.w / 2, g.y - 3 * u, label); else T(g.x + g.w + 3 * u, g.y + g.h / 2 + mid, label, "start");
        }
      }
      for (const r of owners) {
        if (r.textRect) {
          const t = r.textRect, s = r.style;
          const fs = px(s.fontSize), lh = s.lineHeight === "normal" ? fs * 1.2 : px(s.lineHeight);
          path(`M${r1(t.x)} ${r1(t.y + t.h)}H${r1(t.x + t.w)}`, "xp-dim xp-soft");
          const label = tok && r.tokens && r.tokens.font ? r.tokens.font : `${fmt(fs)}/${fmt(lh)} ${s.fontWeight}`;
          T(t.x + t.w + 3 * u, t.y + t.h / 2 + mid, label, "start") || T(t.x, t.y - 2 * u, label, "start");
        } else if (r.paint.replaced) {
          const b = r.rect;
          box(b, "xp-icon");
          T(b.x + b.w / 2, b.y - 3 * u, `${fmt(b.w)}×${fmt(b.h)}`);
        }
      }
    } else if (kind === "elevation") {
      const r = owners.find((o) => o.paint.drop);
      if (r) {
        const b = r.rect;
        path(`M${r1(b.x)} ${r1(b.y)}h${r1(b.w)}v${r1(b.h)}h${r1(-b.w)}z`, "xp-dim xp-soft");
        r.paint.shadows.filter((s) => s.kind === "drop").slice(0, 3).forEach((s, i) =>
          T(b.x + b.w + 6 * u, b.y + b.h - i * LH * 1.2, `${fmt(s.x)} ${fmt(s.y)} ${fmt(s.blur)} ${fmt(s.spread)} · ${Math.round(s.alpha * 100)}%`, "start", true));
        if (tok && r.tokens && r.tokens.shadow) T(b.x + b.w + 6 * u, b.y + b.h - 3 * LH * 1.2, r.tokens.shadow, "start", true);
      }
    } else if (kind === "ring") {
      for (const r of owners) {
        const rings = r.paint.shadows.filter((s) => s.kind === "ring");
        const b = r.rect;
        if (rings.length) {
          const outer = rings[rings.length - 1];
          T(b.x + b.w / 2, b.y - outer.spread - 4 * u, rings.map((s) => fmt(s.spread)).join(" + ") + "px ring");
        } else if (r.paint.outline) {
          T(b.x + b.w / 2, b.y - px(r.style.outlineOffset) - px(r.style.outlineWidth) - 4 * u, `${fmt(px(r.style.outlineWidth))}px · offset ${fmt(px(r.style.outlineOffset))}`);
        }
      }
    }
    return out.join("");
  }

  function summary(cap, plan, key, tok) {
    const [kind] = key.split(":");
    const ids = plan.keys.find((k) => k.key === key).ids;
    const owners = cap.recs.filter((r) => ids.has(r.id) && r.paint);
    const t = (r, fam, v) => (tok && r.tokens && r.tokens[fam]) || v;
    if (kind === "elevation") {
      const drops = owners.flatMap((r) => r.paint.shadows.filter((s) => s.kind === "drop"));
      return drops.length ? `${drops.length} shadow${drops.length > 1 ? "s" : ""} · ${drops.map((s) => `y${fmt(s.y)} b${fmt(s.blur)}`).join(", ")}` : "no shadow";
    }
    if (kind === "surface") {
      const filled = owners.filter((o) => o.paint.fill || o.paint.stroke || o.paint.inset);
      const r = filled[0];
      if (!r) return "empty";
      const s = r.style;
      // Every part's fill (and offset), not just the first part's.
      const fillOf = (o) => {
        const base = alphaOf(o.style.backgroundColor) > 0 ? hexOf(o.style.backgroundColor) : "";
        return t(o, "fill", o.style.backgroundImage !== "none" ? (base ? `${base} + gradient` : "gradient") : base || "none") + moveOf(o);
      };
      const fills = Array.from(new Set(filled.map(fillOf)));
      const fill = fills.slice(0, 3).join(", ") + (fills.length > 3 ? ` +${fills.length - 3}` : "");
      const pad = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(px);
      const padTxt = pad[0] === pad[2] && pad[1] === pad[3] ? (pad[0] === pad[1] ? fmt(pad[0]) : `${fmt(pad[0])} ${fmt(pad[1])}`) : pad.map(fmt).join(" ");
      return `${fill} · ${t(r, "radius", "r " + fmt(px(s.borderTopLeftRadius)))} · pad ${t(r, "padding", padTxt)}${owners.length > 1 ? ` · ${owners.length} parts` : ""}`;
    }
    if (kind === "stroke") {
      const r = owners.find((o) => o.paint.stroke);
      if (r) return `${fmt(px(r.style.borderTopWidth))}px · ${t(r, "stroke", hexOf(r.style.borderTopColor))}`;
      const e = owners.find((o) => o.paint.edge);
      if (!e) return "no stroke";
      const x = e.paint.shadows.find((y) => y.kind === "edge");
      const n = owners.filter((o) => o.paint.edge).length;
      return `${fmt(x.spread)}px edge · ${t(e, "shadow", hexOf(x.color))}${n > 1 ? ` · ${n} parts` : ""}`;
    }
    if (kind === "content") {
      const texts = owners.filter((r) => r.paint.text && r.paint.content);
      const icons = owners.filter((r) => r.paint.replaced && r.paint.content);
      const first = texts[0];
      const font = first ? `${fmt(px(first.style.fontSize))}/${first.style.lineHeight === "normal" ? "n" : fmt(px(first.style.lineHeight))} ${first.style.fontWeight} · ${t(first, "color", hexOf(first.style.color))}` : "";
      return [font, texts.length > 1 ? `${texts.length} text runs` : "", icons.length ? `${icons.length} icon${icons.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") || "empty";
    }
    if (kind === "ring") {
      const r = owners.find((o) => o.paint.ring);
      if (!r) return "none in this state";
      const rings = r.paint.shadows.filter((s) => s.kind === "ring");
      if (rings.length) return `${rings.map((s) => fmt(s.spread)).join(" / ")}px · ${t(r, "shadow", hexOf(rings[rings.length - 1].color))}`;
      return `outline ${fmt(px(r.style.outlineWidth))}px · offset ${fmt(px(r.style.outlineOffset))} · ${t(r, "outline", hexOf(r.style.outlineColor))}`;
    }
    return "";
  }

  // ───────────────────────────────────────────── legibility of a layer on its sheet
  // A layer of white text on white glass reads as nothing. When a layer's paint
  // would vanish on the sheet, the sheet takes the colour that paint really sits
  // on in the component (its nearest filled ancestor), so it reads as it ships.

  function rgbaOf(c) {
    const m = c && c.match(/^rgba?\(([^)]*)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p.length === 4 ? p[3] : 1];
  }
  function over(top, base) {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + base[i] * (1 - a)).concat(1);
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

  function plateOwners(cap, plan, key) {
    const out = [];
    for (const r of cap.recs) {
      if (!r.paint) continue;
      for (const p of PAINTS) if (r.paint[p] && plan.plateOf(r, p) === key) out.push([r, p]);
    }
    return out;
  }

  function backingsFor(cap, plan, key, sheetBase) {
    // One backing per surface that light paint sits on, shaped like that surface.
    const byId = new Map(cap.recs.map((r) => [r.id, r]));
    const filled = (n) => { const c = rgbaOf(n.style.backgroundColor); return (c && c[3] > 0.5) || (n.style.backgroundImage && n.style.backgroundImage !== "none"); };
    const surfaceFrom = (rec, includeSelf) => {
      for (let n = includeSelf ? rec : byId.get(rec.parent); n; n = byId.get(n.parent)) if (!n.pseudo && n.rect && filled(n)) return n;
      return null;
    };
    const out = new Map();
    for (const [r, p] of plateOwners(cap, plan, key)) {
      let color = null;
      if (p === "content" && r.paint.text) color = r.style.color;
      else if (p === "fill") color = r.style.backgroundColor;
      else if (p === "stroke") color = r.style.borderTopColor;
      const rgba = rgbaOf(color);
      if (!rgba || rgba[3] === 0) continue;
      if (contrast(over(rgba, sheetBase), sheetBase) >= 1.6) continue;
      const under = surfaceFrom(r, p === "content");
      if (!under || out.has(under.id)) continue;
      const s = under.style;
      out.set(under.id, { x: under.rect.x, y: under.rect.y, w: under.rect.w, h: under.rect.h, radius: `${s.borderTopLeftRadius} ${s.borderTopRightRadius} ${s.borderBottomRightRadius || s.borderTopRightRadius} ${s.borderBottomLeftRadius || s.borderTopLeftRadius}`, color: s.backgroundColor, image: s.backgroundImage });
    }
    return Array.from(out.values());
  }

  // ───────────────────────────────────────────── the figure

  async function mount(host, opts) {
    forcePseudo();
    const target = opts.target;
    const stateTarget = opts.stateTarget ? target.querySelector(opts.stateTarget) || target : target;
    const states = typeof opts.states === "string" ? PRESETS[opts.states] : opts.states || PRESETS.pressable;
    const theme = opts.theme || "light";
    const still = matchMedia("(prefers-reduced-motion: reduce)");

    host.classList.add("xp");
    host.setAttribute("data-theme", theme);
    host.innerHTML = `
      <div class="xp-card" tabindex="0" role="group">
        <div class="xp-corner xp-tl">Fig. ${esc(opts.fig || 1)}</div>
        <div class="xp-corner xp-tr">${esc(opts.title || "Component")}</div>
        <div class="xp-viewport"><div class="xp-origin"><div class="xp-scene"></div></div></div>
        <div class="xp-corner xp-bl xp-hint">Hover to take apart · drag to turn</div>
        <div class="xp-corner xp-br xp-readout" aria-live="polite"></div>
      </div>
      <div class="xp-margin">
        <div class="xp-keys xp-states"></div>
        <ol class="xp-layers"></ol>
        <div class="xp-keys xp-modes">
          <button type="button" data-k="e"><kbd>E</kbd>apart</button>
          <button type="button" data-k="t"><kbd>T</kbd><span class="xp-tokmode">tokens</span></button>
        </div>
        <div class="xp-live"><span class="xp-live-label">Live</span><div class="xp-specimen"></div></div>
      </div>`;
    const card = host.querySelector(".xp-card");
    const viewport = host.querySelector(".xp-viewport");
    const scene = host.querySelector(".xp-scene");
    const origin = host.querySelector(".xp-origin");
    const readout = host.querySelector(".xp-readout");
    const specimen = host.querySelector(".xp-specimen");
    if (opts.specimenWidth) specimen.style.width = opts.specimenWidth + "px";
    const home = { parent: target.parentNode, next: target.nextSibling };
    // The specimen inherits what it inherited where it was placed (font, colour), not the figure's.
    if (home.parent && home.parent.nodeType === 1) { const pcs = getComputedStyle(home.parent); for (const p of INHERITED) specimen.style[p] = pcs[p]; }
    specimen.appendChild(target);
    await settle(target, opts.settle);

    // 1. Truth: capture every state, one after another, each once it has settled.
    const caps = [];
    for (const s of states) caps.push(await capture(target, stateTarget, s, opts));
    markEdges(caps);
    const plan = planLayers(caps, opts);
    const W = Math.max(...caps.map((c) => c.w)), H = Math.max(...caps.map((c) => c.h));
    const N = plan.keys.length;

    // 2. Build plates: one per layer, each holding one painted clone per state.
    const plates = plan.keys.map((layer, i) => {
      const el = document.createElement("div");
      el.className = "xp-plate";
      el.dataset.key = layer.key;
      el.innerHTML = `<div class="xp-sheet"><i></i><i></i><i></i><i></i></div><div class="xp-zoom"><div class="xp-backing"></div><div class="xp-paints"></div><svg class="xp-lines" overflow="visible"></svg></div>`;
      const paints = el.querySelector(".xp-paints");
      const layers = caps.map((cap, si) => {
        const wrap = document.createElement("div");
        wrap.className = "xp-paint";
        wrap.dataset.state = si;
        const painted = paintLayer(cap.frozen, cap, plan, layer.key);
        paintCanvases(painted, cap);
        wrap.appendChild(painted);
        paints.appendChild(wrap);
        return wrap;
      });
      scene.appendChild(el);
      return { el, layer, i, layers, z: 0, o: 1, lineO: 0, svg: el.querySelector(".xp-lines"), sheet: el.querySelector(".xp-sheet"), zoom: el.querySelector(".xp-zoom"), backing: el.querySelector(".xp-backing") };
    });
    // Closed, the figure shows the component in one piece, so it matches the real thing exactly
    // (a disabled state's group opacity, blend modes); it hands over to the sheets as they open.
    const whole = document.createElement("div");
    whole.className = "xp-plate xp-whole";
    whole.innerHTML = `<div class="xp-zoom"><div class="xp-paints"></div></div>`;
    const wholeZoom = whole.querySelector(".xp-zoom");
    const wholeLayers = caps.map((cap, si) => {
      const wrap = document.createElement("div");
      wrap.className = "xp-paint";
      wrap.dataset.state = si;
      const c = cap.frozen.cloneNode(true);
      paintCanvases(c, cap);
      wrap.appendChild(c);
      whole.querySelector(".xp-paints").appendChild(wrap);
      return wrap;
    });
    scene.appendChild(whole);
    const mat = document.createElement("div");
    mat.className = "xp-plate xp-mat";
    mat.innerHTML = `<div class="xp-zoom"><svg class="xp-lines xp-ruler" overflow="visible"></svg></div>`;
    scene.insertBefore(mat, scene.firstChild);
    const guides = [0, 1, 2, 3].map(() => { const g = document.createElement("div"); g.className = "xp-guide"; scene.appendChild(g); return g; });

    // Margin: states and layers.
    const stateBox = host.querySelector(".xp-states");
    stateBox.innerHTML = states.map((s, i) => `<button type="button" data-s="${i}"><kbd>${i + 1}</kbd>${esc(s.label)}</button>`).join("");
    const list = host.querySelector(".xp-layers");
    list.innerHTML = plates.slice().reverse().map((p) => `<li data-i="${p.i}"><span class="xp-sw" data-kind="${p.layer.key.split(":")[0]}"></span>${esc(p.layer.name)}</li>`).join("");

    // 3. State of the figure.
    const S = {
      state: 0, apart: 0, apartT: 0, active: -1, az: opts.azimuth ?? -38, azT: opts.azimuth ?? -38, tilt: opts.tilt ?? 56, tiltT: opts.tilt ?? 56,
      tokens: false, touring: !still.matches && opts.tour !== false, clock: 0, idle: 0, hovering: false, changedAt: 0, now: 0,
      scale: 1, gap: 40,
    };

    function fit() {
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      const t = (S.tiltT * Math.PI) / 180, a = (S.azT * Math.PI) / 180;
      const fw = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a));
      const fh = (Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a))) * Math.cos(t);
      const stackBudget = vh * (opts.stack ?? 0.42);
      S.gap = N > 1 ? Math.min(opts.maxGap ?? 84, stackBudget / Math.sin(t) / (N - 1)) : 0;
      const stackH = S.gap * (N - 1) * Math.sin(t);
      S.scale = Math.min(opts.maxScale ?? 5, (vw * 0.78) / fw, (vh * 0.86 - stackH) / Math.max(fh, 1));
      const s = S.scale, m = 12 / s;
      for (const p of plates) {
        p.el.style.width = W * s + "px"; p.el.style.height = H * s + "px";
        p.el.style.left = (-W * s) / 2 + "px"; p.el.style.top = (-H * s) / 2 + "px";
        p.zoom.style.zoom = s;
        p.zoom.style.width = W + "px"; p.zoom.style.height = H + "px";
        p.svg.setAttribute("width", W); p.svg.setAttribute("height", H);
        p.svg.style.setProperty("--xp-fs", `${r1((8.5 / s) * 100) / 100}px`);
        p.svg.style.setProperty("--xp-hair", `${r1((0.9 / s) * 100) / 100}px`);
        p.svg.style.setProperty("--xp-dash", `${r1((2.5 / s) * 100) / 100}px`);
        p.sheet.style.inset = `${-m * s}px`;
      }
      whole.style.width = W * s + "px"; whole.style.height = H * s + "px";
      whole.style.left = (-W * s) / 2 + "px"; whole.style.top = (-H * s) / 2 + "px";
      wholeZoom.style.zoom = s; wholeZoom.style.width = W + "px"; wholeZoom.style.height = H + "px";
      const mm = Math.max(18, 34 / s);
      mat.style.width = (W + mm * 2) * s + "px"; mat.style.height = (H + mm * 2) * s + "px";
      mat.style.left = (-(W + mm * 2) * s) / 2 + "px"; mat.style.top = (-(H + mm * 2) * s) / 2 + "px";
      const mz = mat.querySelector(".xp-zoom"); mz.style.zoom = s; mz.style.width = W + mm * 2 + "px"; mz.style.height = H + mm * 2 + "px";
      mat.querySelector("svg").setAttribute("width", W + mm * 2); mat.querySelector("svg").setAttribute("height", H + mm * 2);
      drawRuler(mm);
      drawLines();
    }

    function drawRuler(mm) {
      // Rulers along the two near edges of the mat, ticks every 4 px and a major
      // every 16, read from the measured size. Sizes are kept constant on screen.
      const svg = mat.querySelector("svg");
      const u = 1 / S.scale;
      const step = W > 480 || H > 480 ? 8 : 4, major = step * 4;
      let d = "", dMaj = "", txt = "";
      const ox = mm, oy = mm, y0 = oy - 6 * u - 4, x0 = ox - 6 * u - 4;
      for (let x = 0; x <= W + 0.01; x += step) (x % major === 0 ? (dMaj += `M${r1(ox + x)} ${r1(y0)}v${r1(-6 * u)}`) : (d += `M${r1(ox + x)} ${r1(y0)}v${r1(-3 * u)}`));
      for (let y = 0; y <= H + 0.01; y += step) (y % major === 0 ? (dMaj += `M${r1(x0)} ${r1(oy + y)}h${r1(-6 * u)}`) : (d += `M${r1(x0)} ${r1(oy + y)}h${r1(-3 * u)}`));
      d += `M${ox} ${r1(y0)}H${r1(ox + W)}M${r1(x0)} ${oy}V${r1(oy + H)}`;
      const ty = y0 - 9 * u, tx = x0 - 9 * u;
      txt += `<text x="${r1(ox + W)}" y="${r1(ty)}" text-anchor="end">${fmt(W)}</text><text x="${ox}" y="${r1(ty)}" text-anchor="start">0</text>`;
      txt += `<text x="${r1(tx)}" y="${r1(oy + H)}" text-anchor="end">${fmt(H)}</text>`;
      svg.style.setProperty("--xp-fs", `${r1(8 * u * 100) / 100}px`);
      svg.style.setProperty("--xp-hair", `${r1(0.9 * u * 100) / 100}px`);
      svg.innerHTML = `<rect class="xp-matrect" x="0" y="0" width="${W + mm * 2}" height="${H + mm * 2}" rx="${r1(8 * u)}"/><path class="xp-tick" d="${d}"/><path class="xp-tick xp-major" d="${dMaj}"/>${txt}`;
    }

    function drawLines() {
      const cap = caps[S.state];
      for (const p of plates) p.svg.innerHTML = redlines(cap, plan, p.layer.key, { showTokens: S.tokens, u: 1 / S.scale }) + cornerDots(p);
    }
    function cornerDots() {
      const m = 12 / S.scale;
      return [[-m, -m], [W + m, -m], [W + m, H + m], [-m, H + m]].map(([x, y]) => `<circle class="xp-cdot" cx="${r1(x)}" cy="${r1(y)}" r="${r1(1.4 / S.scale * 1.6)}"/>`).join("");
    }

    const sheetBase = theme === "dark" ? [20, 20, 22, 1] : [253, 253, 252, 1];
    const looks = caps.map((cap) => plates.map((p) => ({
      empty: plateOwners(cap, plan, p.layer.key).length === 0,
      backings: backingsFor(cap, plan, p.layer.key, sheetBase),
    })));

    function setState(i, user) {
      if (i < 0 || i >= caps.length) return;
      S.state = i;
      for (const p of plates) {
        p.layers.forEach((l, si) => l.classList.toggle("is-on", si === i));
        wholeLayers.forEach((l, si) => l.classList.toggle("is-on", si === i));
        const look = looks[i][p.i];
        p.el.classList.toggle("is-empty", look.empty);
        // Each backing is the surface that light paint sits on, in its own shape and colour.
        p.backing.innerHTML = look.backings.map((b) => `<i style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border-radius:${b.radius};background-color:${b.color};background-image:${b.image}"></i>`).join("");
        p.el.classList.toggle("is-backed", look.backings.length > 0);
      }
      stateBox.querySelectorAll("button").forEach((b, bi) => b.classList.toggle("is-on", bi === i));
      drawLines();
      say();
      if (user) interact();
    }
    function setActive(i) {
      S.active = i;
      list.querySelectorAll("li").forEach((li) => li.classList.toggle("is-on", Number(li.dataset.i) === i));
      say();
    }
    function say() {
      const st = states[S.state].label;
      if (S.active < 0) {
        readout.textContent = `${st} · ${fmt(W)} × ${fmt(H)} · ${N} layers${S.apartT ? "" : " · together"}`;
      } else {
        const p = plates[S.active];
        readout.textContent = `${st} · ${p.layer.name} · ${summary(caps[S.state], plan, p.layer.key, S.tokens)}`;
      }
      card.setAttribute("aria-label", `${opts.title || "Component"}, exploded into ${N} layers. State ${st}. ${readout.textContent}. Keys: 1 to ${caps.length} switch state, E takes apart, arrows select a layer, T shows tokens.`);
    }

    function interact() { S.touring = false; S.idle = 0; kick(); }

    // 4. Motion: one loop, calm, time-based.
    let frame = 0, last = 0, visible = false;
    const TOUR = buildTour();
    function buildTour() {
      const steps = [];
      steps.push({ d: 1.4, apart: 0, active: -1, state: 0 });
      steps.push({ d: 1.6, apart: 1, active: -1, state: 0 });
      for (let i = N - 1; i >= 0; i--) steps.push({ d: 1.5, apart: 1, active: i, state: 0 });
      const ringIdx = plates.findIndex((p) => p.layer.key === "ring");
      for (let s = 1; s < caps.length; s++) steps.push({ d: 1.7, apart: 1, active: ringIdx >= 0 && /focus/.test(states[s].id) ? ringIdx : -1, state: s });
      steps.push({ d: 1.2, apart: 1, active: -1, state: 0 });
      return steps;
    }
    const tourLength = TOUR.reduce((a, s) => a + s.d, 0);
    let tourStep = -1;
    function tour(dt) {
      S.clock = (S.clock + dt) % tourLength;
      let t = S.clock, idx = 0;
      while (idx < TOUR.length - 1 && t > TOUR[idx].d) { t -= TOUR[idx].d; idx++; }
      if (idx !== tourStep) {
        tourStep = idx;
        const s = TOUR[idx];
        if (s.apart !== S.apartT) setApart(s.apart);
        if (s.state !== S.state) setState(s.state);
        if (s.active !== S.active) setActive(s.active);
      }
    }
    function setApart(v) { S.apartT = v; S.changedAt = S.now; host.querySelector('[data-k="e"]').classList.toggle("is-on", !!v); say(); kick(); }

    function tick(now) {
      S.now = now / 1000;
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      const calm = still.matches;
      if (S.touring) tour(dt);
      else if (opts.tour !== false && !S.hovering && !calm && (S.idle += dt) > 4.2) { S.touring = true; S.clock = 0; tourStep = -1; }
      S.az = follow(S.az, S.azT, dt, 0.22, calm);
      S.tilt = follow(S.tilt, S.tiltT, dt, 0.22, calm);
      const since = S.now - S.changedAt;
      let moving = Math.abs(S.az - S.azT) > 0.01 || Math.abs(S.tilt - S.tiltT) > 0.01;
      for (const p of plates) {
        const order = S.apartT ? p.i : N - 1 - p.i;
        const go = calm || since > order * 0.045;
        const zt = go ? S.apartT : p.z;
        p.z = Math.abs(p.z - zt) < 1e-3 ? zt : follow(p.z, zt, dt, 0.2, calm);
        const ot = S.active < 0 || S.active === p.i ? 1 : 0.26;
        p.o = Math.abs(p.o - ot) < 1e-3 ? ot : follow(p.o, ot, dt, 0.14, calm);
        const lt = S.active === p.i && p.z > 0.6 ? 1 : 0;
        p.lineO = Math.abs(p.lineO - lt) < 1e-3 ? lt : follow(p.lineO, lt, dt, 0.14, calm);
        if (p.z !== zt || p.o !== ot || p.lineO !== lt || !go) moving = true;
      }
      draw();
      frame = visible && (moving || S.touring || (opts.tour !== false && !S.hovering && S.idle < 4.3)) ? requestAnimationFrame(tick) : 0;
      if (!frame) last = 0;
    }
    function kick() { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } }

    function draw() {
      scene.style.transform = `rotateX(${r1(S.tilt)}deg) rotateZ(${r1(S.az)}deg)`;
      let top = 0;
      const open = Math.min(1, Math.max(0, ...plates.map((p) => p.z)) * 5);
      whole.style.opacity = r1((1 - open) * 100) / 100;
      for (const p of plates) {
        const z = p.i * (0.6 + S.gap * p.z);
        top = Math.max(top, z);
        p.el.style.transform = `translateZ(${r1(z)}px)`;
        p.el.style.opacity = r1(p.o * open * 100) / 100;
        p.svg.style.opacity = r1(p.lineO * 100) / 100;
        const sheetA = Math.min(1, p.z);
        p.sheet.style.opacity = r1(sheetA * 100) / 100;
        p.el.classList.toggle("is-active", S.active === p.i);
      }
      mat.style.transform = `translateZ(-1px)`;
      origin.style.transform = `translateY(${r1((top * Math.sin((S.tilt * Math.PI) / 180)) / 2)}px)`;
      // Guides stand on the bottom sheet's corner dots and end on the top one's.
      const s = S.scale, m = 12;
      const corners = [[-W * s / 2 - m, -H * s / 2 - m], [W * s / 2 + m, -H * s / 2 - m], [W * s / 2 + m, H * s / 2 + m], [-W * s / 2 - m, H * s / 2 + m]];
      const zb = plates[0] ? plates[0].i * (0.6 + S.gap * plates[0].z) : 0;
      guides.forEach((g, gi) => {
        const [x, y] = corners[gi];
        g.style.height = r1(Math.max(0, top - zb)) + "px";
        g.style.transform = `translate3d(${r1(x)}px, ${r1(y)}px, ${r1(zb)}px) rotateX(90deg)`;
        g.style.opacity = r1(Math.min(1, plates[plates.length - 1].z) * 100) / 100;
      });
    }

    // 5. Input.
    card.addEventListener("pointerenter", () => { S.hovering = true; S.touring = false; if (!S.apartT) setApart(1); kick(); });
    card.addEventListener("pointerleave", () => { S.hovering = false; S.idle = 0; dragging = null; kick(); });
    let dragging = null;
    card.addEventListener("pointerdown", (e) => { dragging = { x: e.clientX, y: e.clientY, az: S.azT, tilt: S.tiltT }; card.setPointerCapture(e.pointerId); interact(); });
    card.addEventListener("pointerup", (e) => { dragging = null; try { card.releasePointerCapture(e.pointerId); } catch (_) { /* */ } });
    card.addEventListener("pointercancel", () => { dragging = null; });
    card.addEventListener("pointermove", (e) => {
      if (dragging) {
        S.azT = clamp(dragging.az + (e.clientX - dragging.x) * 0.35, -88, 0);
        S.tiltT = clamp(dragging.tilt - (e.clientY - dragging.y) * 0.25, 20, 72);
        interact();
        return;
      }
      const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList && n.classList.contains("xp-sheet"));
      const plate = hit ? plates.find((p) => p.sheet === hit) : null;
      const i = plate && S.apartT ? plate.i : -1;
      if (i !== S.active) { setActive(i); interact(); }
    });
    card.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (/^[1-9]$/.test(k)) setState(Number(k) - 1, true);
      else if (k === "e") { setApart(S.apartT ? 0 : 1); interact(); }
      else if (k === "t") toggleTokens();
      else if (k === "arrowup") { setActive(S.active < 0 ? 0 : Math.min(N - 1, S.active + 1)); if (!S.apartT) setApart(1); interact(); }
      else if (k === "arrowdown") { setActive(S.active <= 0 ? -1 : S.active - 1); interact(); }
      else if (k === "arrowleft") { S.azT = clamp(S.azT - 8, -88, 0); interact(); }
      else if (k === "arrowright") { S.azT = clamp(S.azT + 8, -88, 0); interact(); }
      else if (k === "escape") { setActive(-1); setApart(0); interact(); }
      else return;
      e.preventDefault();
    });
    stateBox.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setState(Number(b.dataset.s), true); });
    list.addEventListener("pointerover", (e) => { const li = e.target.closest("li"); if (li) { if (!S.apartT) setApart(1); setActive(Number(li.dataset.i)); interact(); } });
    list.addEventListener("pointerleave", () => { setActive(-1); });
    host.querySelector('[data-k="e"]').addEventListener("click", () => { setApart(S.apartT ? 0 : 1); interact(); });
    host.querySelector('[data-k="t"]').addEventListener("click", toggleTokens);
    function toggleTokens() {
      S.tokens = !S.tokens;
      host.querySelector('[data-k="t"]').classList.toggle("is-on", S.tokens);
      drawLines(); say(); interact();
    }
    // The live specimen drives the figure: hover, press or focus the real thing.
    const live = (id) => { const i = states.findIndex((s) => s.id === id); if (i >= 0) setState(i, true); };
    stateTarget.addEventListener("pointerenter", () => live("hover"));
    stateTarget.addEventListener("pointerleave", () => live("rest"));
    stateTarget.addEventListener("pointerdown", () => live("pressed"));
    stateTarget.addEventListener("pointerup", () => live("hover"));
    // Only keyboard focus is the Focus state; a mouse press also focuses a button, and that's Pressed.
    stateTarget.addEventListener("focus", () => { if (stateTarget.matches(":focus-visible")) live("focus"); });
    stateTarget.addEventListener("blur", () => live("rest"));

    const io = new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) kick(); }, { rootMargin: "120px 0px" });
    io.observe(card);
    const ro = new ResizeObserver(() => { fit(); draw(); });
    ro.observe(viewport);

    fit();
    setState(0);
    setActive(-1);
    if (still.matches) { setApart(1); S.touring = false; }
    draw();

    const api = {
      host, plan, caps, plates, states,
      setState: (i) => setState(i, true),
      setActive: (i) => { setActive(i); interact(); },
      apart: (v = true) => { setApart(v ? 1 : 0); interact(); },
      turn: (az, tilt) => { if (az != null) S.azT = az; if (tilt != null) S.tiltT = tilt; interact(); },
      tokens: (v = true) => { if (S.tokens !== v) toggleTokens(); },
      audit: () => audit(target, caps, plan, plates),
      // Put the live component in state i and let it settle; resolves to an async undo. For audits.
      pose: async (i) => {
        const undo = applyState(target, stateTarget, states[i]);
        const settled = (await settle(target, opts.settle)) && (await canvasStill(target));
        const back = async () => { undo(); await settle(target, opts.settle); };
        back.settled = settled;
        return back;
      },
      // State i's layers stacked flat at zoom 1: what the closed figure paints, for pixel checks.
      // The root's own opacity fades the component as a group, so it applies once to the whole stack.
      composite: (i) => {
        const box = document.createElement("div");
        box.style.position = "relative";
        box.style.opacity = caps[i].recs[0].style.opacity;
        for (const p of plates) {
          const w = document.createElement("div");
          w.style.cssText = "position:absolute;left:0;top:0;width:100%";
          const c = paintLayer(caps[i].frozen, caps[i], plan, p.layer.key);
          paintCanvases(c, caps[i]);
          c.style.setProperty("opacity", "1", "important");
          w.appendChild(c);
          box.appendChild(w);
        }
        return box;
      },
      // Put the specimen back where it came from and stop everything (React unmount).
      destroy: () => {
        io.disconnect(); ro.disconnect();
        if (frame) cancelAnimationFrame(frame);
        frame = 0; visible = false;
        if (home.parent) home.parent.insertBefore(target, home.next && home.next.parentNode === home.parent ? home.next : null);
        host.innerHTML = ""; host.classList.remove("xp"); delete host.exploded;
      },
      model: () => caps.map((c) => ({ state: c.state.id, w: c.w, h: c.h, settled: c.settled, layers: plan.keys.map((k) => ({ key: k.key, name: k.name, summary: summary(c, plan, k.key, false) })) })),
    };
    host.exploded = api;
    return api;
  }

  // ───────────────────────────────────────────── audit
  // Proves two things for every state: every paint is claimed by exactly one
  // layer, and every layer's clone lays out exactly like the real component.

  function audit(target, caps, plan, plates) {
    const problems = [];
    let checked = 0;
    // Measure at zoom 1 so the comparison is exact, then restore.
    const zooms = plates.map((p) => p.zoom.style.zoom);
    plates.forEach((p) => (p.zoom.style.zoom = 1));
    caps.forEach((cap, si) => {
      for (const rec of cap.recs) {
        if (!rec.paint) continue;
        for (const p of PAINTS) {
          if (!rec.paint[p]) continue;
          const key = plan.plateOf(rec, p);
          const owners = plan.keys.filter((k) => k.key === key);
          checked++;
          if (owners.length !== 1) problems.push(`${cap.state.id}: ${p} of #${rec.id} claimed by ${owners.length} layers`);
        }
      }
      for (const plate of plates) {
        const clone = plate.layers[si].firstElementChild;
        for (const rec of cap.recs) {
          if (rec.pseudo || !rec.box) continue;
          const c = rec.id === "0" ? clone : clone.querySelector(`[data-xp-id="${rec.id}"]`);
          if (!c) { problems.push(`${cap.state.id}/${plate.layer.name}: #${rec.id} missing`); continue; }
          const b = layoutBox(c, clone);
          checked++;
          if (!b) continue;
          const d = Math.max(Math.abs(b.x - rec.box.x), Math.abs(b.y - rec.box.y), Math.abs(b.w - rec.box.w), Math.abs(b.h - rec.box.h));
          if (d > 0.5) problems.push(`${cap.state.id}/${plate.layer.name}: #${rec.id} <${rec.el.tagName.toLowerCase()}> off by ${r1(d)}px`);
        }
      }
    });
    plates.forEach((p, i) => (p.zoom.style.zoom = zooms[i]));
    const result = { ok: problems.length === 0, checked, problems };
    console[result.ok ? "log" : "warn"](`[exploded] audit ${result.ok ? "passed" : "FAILED"} · ${checked} checks · ${problems.length} problems`, problems.slice(0, 20));
    return result;
  }

  global.Exploded = { mount, presets: PRESETS, forcePseudo, parseShadows };
})(typeof window !== "undefined" ? window : globalThis);
