'use strict';

/*
 * Intuitive Graph Navigation
 * Copyright (c) 2026 Gregory Jackson. MIT License.
 *
 * Adds a "Click mode" to Obsidian's graph view:
 *   - Clicking a node opens the note (beside the graph) and keeps the node
 *     highlighted until Escape is pressed or another node is clicked.
 *   - Opening a note any other way (file explorer, a link, quick switcher)
 *     selects that note's node, as if it had been clicked.
 *   - Hovering a node shows its label as if it were clicked, without
 *     changing the selection.
 *   - Lines from the highlighted node take the colour of the node at the
 *     other end; grouped nodes keep their group colour when highlighted.
 *   - The open note's ring is black (light mode) or white (dark mode).
 *   - Global graph tabs are kept pinned.
 *
 * Obsidian has no public API for the graph renderer, so this hooks into
 * internals (view.renderer, renderer.highlightNode, renderer.onNodeClick,
 * node.render, node.circle, link display objects). Every hook is guarded,
 * and the original behaviour is restored on unload.
 */

const { Plugin, PluginSettingTab, Setting, Notice, setIcon, Keymap, TFile } = require('obsidian');

const DEFAULT_SETTINGS = {
  mode: 'click',                  // 'click' | 'hover'
  pinGraph: true,                 // keep global graph tabs pinned
  followActiveFile: true,         // opening a note selects its node
  hoverWhenNothingSelected: true, // in click mode, hover still highlights while nothing is selected
  openInOtherPane: true,          // open notes outside the graph's tab group so the graph stays visible
  centerOnSelect: true,           // pan the graph so a newly selected node moves to the centre
  hoverLabelStyle: 'graph',       // 'graph' = the graph's own node label, 'tooltip' = a box by the cursor
  colorLinks: true,               // highlighted node's lines take the colour of the node at the other end
  styleSelected: true,            // open-note ring: black (light) or white (dark)
  groupColorFirst: true,          // grouped nodes keep their group colour when open or highlighted
};

// Properties of a PIXI text object that Obsidian uses to fade labels out.
const TEXT_VISIBILITY = { alpha: 1, visible: true, renderable: true };

const GRAPH_TYPES = ['graph', 'localgraph'];
const LINE_FADE_MS = 300; // how long a deselected line takes to blend from its node colour back to default
const PAN_MS = 550; // how long the camera takes to glide to a selected node

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// Blend two 0xRRGGBB colours; t = 0 gives a, t = 1 gives b.
function mixColor(a, b, t) {
  if (typeof a !== 'number' || typeof b !== 'number') return b;
  const ch = (c, shift) => (c >> shift) & 0xff;
  const mix = (shift) => Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * t) & 0xff;
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

module.exports = class IntuitiveGraphNavigationPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    delete this.settings.openOnDoubleClick; // removed in 1.1
    this.selectedId = null;
    this.hooks = new Map(); // renderer -> hook state
    // Tracked per plugin instance (not as flags on Obsidian's objects) so that
    // disabling and re-enabling the plugin always starts clean.
    this.wrappedFns = new WeakSet();
    this.circleBindings = new Map(); // circle -> { over, out }
    this.tintHooks = new Map(); // link display object -> { link, renderer, protoSet, own, intended }
    this.fadingTints = new Set(); // line objects blending back to their default colour
    this.fadeFrame = 0;
    this.circleTints = new Map(); // circle -> { node, renderer, protoSet, own, intended }
    this.hoverId = null;
    this.hoverRenderer = null;
    this.forcedText = null; // { node, text, renderer, restore[] } while a graph label is held visible
    this.highlightOverride = null; // node treated as highlighted while Obsidian positions its label
    this.warned = false;
    this.mouse = { x: 0, y: 0 };
    this.signals = { setter: 0, onNodeHover: 0, circle: 0 }; // for the diagnostic command

    this.labelEl = document.body.createDiv({ cls: 'gcs-node-label' });
    // Inline essentials so the label still works if styles.css is missing.
    Object.assign(this.labelEl.style, { position: 'fixed', zIndex: '1000', pointerEvents: 'none' });
    this.labelEl.hide();

    this.addSettingTab(new IntuitiveGraphNavigationSettingTab(this.app, this));

    this.ribbonEl = this.addRibbonIcon('mouse-pointer-click', 'Graph: Click mode', () => this.toggleMode());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.addEventListener('click', () => this.toggleMode());
    this.refreshIndicators();

    this.addCommand({ id: 'toggle-mode', name: 'Toggle hover / click mode', callback: () => this.toggleMode() });
    this.addCommand({ id: 'clear-selection', name: 'Clear graph selection', callback: () => this.setSelected(null) });
    this.addCommand({ id: 'copy-diagnostics', name: 'Copy diagnostics (for troubleshooting)', callback: () => this.copyDiagnostics() });

    this.app.workspace.onLayoutReady(() => { this.syncMarkerClass(); this.scan(); });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scan()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scan()));
    this.registerEvent(this.app.workspace.on('css-change', () => this.updateSelectedStyle()));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file && this.settings.mode === 'click' && this.settings.followActiveFile) this.setSelected(file.path);
    }));

    // Capture phase so the graph canvas can't swallow the event before we see it.
    const track = (evt) => {
      this.mouse = { x: evt.clientX, y: evt.clientY };
      if (this.labelEl.isShown()) this.positionLabel();
    };
    this.registerDomEvent(document, 'pointermove', track, { capture: true });
    this.registerDomEvent(document, 'mousemove', track, { capture: true });

    this.registerDomEvent(document, 'keydown', (evt) => {
      if (evt.key !== 'Escape' || !this.selectedId || this.settings.mode !== 'click') return;
      if (document.querySelector('.modal-container, .menu, .suggestion-container, .prompt')) return;
      this.setSelected(null);
    });

    // Renderers and their nodes are created or replaced over time (deferred
    // tabs, graph refreshes), so re-check regularly. This is cheap.
    this.registerInterval(window.setInterval(() => this.scan(), 700));
  }

  onunload() {
    this.unloading = true;
    this.stopPans();
    this.syncMarkerClass();
    this.releaseText();
    if (this.labelEl) this.labelEl.remove();
    for (const [renderer, hook] of this.hooks) this.unhook(renderer, hook);
    this.hooks.clear();
    for (const [circle, b] of this.circleBindings) this.detachCircle(circle, b);
    this.circleBindings.clear();
    if (this.fadeFrame) window.cancelAnimationFrame(this.fadeFrame);
    this.fadingTints.clear();
    for (const [circle, h] of this.circleTints) this.unhookCircleTint(circle, h);
    this.circleTints.clear();
    for (const [obj, h] of this.tintHooks) this.unhookTint(obj, h);
    this.tintHooks.clear();

  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshIndicators();
    this.scan();
    this.redrawAll();
  }

  // ------------------------------------------------------------------ mode

  modeLabel() {
    return this.settings.mode === 'click' ? 'Graph: Click mode' : 'Graph: Hover mode';
  }

  toggleMode() {
    this.settings.mode = this.settings.mode === 'click' ? 'hover' : 'click';
    if (this.settings.mode === 'hover') this.selectedId = null;
    else if (this.settings.followActiveFile) {
      const file = this.app.workspace.getActiveFile();
      if (file) this.selectedId = file.path;
    }
    this.refreshIndicators();
    this.redrawAll();
    this.saveSettings();
    new Notice(this.modeLabel());
  }

  refreshIndicators() {
    const click = this.settings.mode === 'click';
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, click ? 'mouse-pointer-click' : 'mouse-pointer');
      this.ribbonEl.setAttribute('aria-label', `${this.modeLabel()} (click to switch)`);
    }
    if (this.statusEl) this.statusEl.setText(this.modeLabel());
    this.updateLabel();
  }

  setSelected(id) {
    const changed = id !== this.selectedId;
    this.selectedId = id;
    if (id === null) for (const hook of this.hooks.values()) hook.store = null;
    this.refreshIndicators();
    this.redrawAll();
    if (id && changed && this.settings.mode === 'click' && this.settings.centerOnSelect) this.centerOn(id);
  }

  // ------------------------------------------------------------------ camera
  //
  // The graph draws a node at screen position node.x * scale + pan, so the
  // pan that puts a node in the middle of the view is size / 2 - node * scale.
  // The camera glides there over PAN_MS, following the node if it is still
  // moving as the graph settles.

  centerOn(id) {
    for (const renderer of this.hooks.keys()) {
      const node = this.lookupNode(renderer, id);
      if (!node || typeof renderer.panX !== 'number' || typeof renderer.scale !== 'number') continue;
      this.startPan(renderer, node);
    }
  }

  panTarget(renderer, node) {
    const w = renderer.width;
    const h = renderer.height;
    if (typeof w !== 'number' || typeof h !== 'number' || !w || !h) return null;
    return { x: w / 2 - node.x * renderer.scale, y: h / 2 - node.y * renderer.scale };
  }

  setPan(renderer, x, y) {
    if (typeof renderer.setPan === 'function') renderer.setPan(x, y);
    else { renderer.panX = x; renderer.panY = y; }
    // Stop any leftover drag momentum fighting the glide.
    if (typeof renderer.panvX === 'number') renderer.panvX = 0;
    if (typeof renderer.panvY === 'number') renderer.panvY = 0;
    if (typeof renderer.changed === 'function') renderer.changed();
  }

  startPan(renderer, node) {
    if (!this.pans) this.pans = new Map();
    const prev = this.pans.get(renderer);
    if (prev) window.cancelAnimationFrame(prev.frame);
    const from = { x: renderer.panX, y: renderer.panY };
    const start = now();
    const pan = { frame: 0 };
    this.pans.set(renderer, pan);
    const tick = () => {
      const target = this.panTarget(renderer, node);
      if (!target || !Number.isFinite(node.x) || !Number.isFinite(node.y)) { this.pans.delete(renderer); return; }
      const p = Math.min(1, (now() - start) / PAN_MS);
      const e = 1 - Math.pow(1 - p, 3); // ease out
      try {
        this.setPan(renderer, from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e);
      } catch (err) { this.pans.delete(renderer); return; }
      if (p < 1) pan.frame = window.requestAnimationFrame(tick);
      else this.pans.delete(renderer);
    };
    pan.frame = window.requestAnimationFrame(tick);
  }

  stopPans() {
    if (!this.pans) return;
    for (const pan of this.pans.values()) window.cancelAnimationFrame(pan.frame);
    this.pans.clear();
  }

  redrawAll() {
    if (this.circleTints) this.refreshCircleTints();
    this.updateSelectedStyle();
    this.refreshLinkTints();
    for (const renderer of this.hooks.keys()) {
      try { if (typeof renderer.changed === 'function') renderer.changed(); } catch (e) { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ hover label

  // The label follows each node circle's own pointerover/pointerout events.
  // Obsidian's hover callbacks can't be used for this: while a node is held
  // selected, Obsidian sends an "unhover" straight after every hover.
  setHover(renderer, id, source) {
    if (source) this.signals[source]++;
    this.hoverId = id || null;
    this.hoverRenderer = id ? renderer : null;
    this.updateSelectedStyle();
    this.updateLabel();
  }

  updateLabel() {
    if (!this.labelEl) return;
    const hideAll = () => { this.labelEl.hide(); this.releaseText(); };
    const id = this.hoverId;
    if (this.settings.mode !== 'click' || !id) return hideAll();
    const renderer = this.hoverRenderer;
    const selected = renderer ? this.lookupNode(renderer, this.selectedId) : null;
    // Obsidian already labels the highlighted node, so only add a label where it wouldn't.
    if (selected && id === selected.id) return hideAll();
    if (!selected && this.settings.hoverWhenNothingSelected) return hideAll();
    const node = renderer ? this.lookupNode(renderer, id) : null;

    if (this.settings.hoverLabelStyle === 'graph' && node && this.holdText(renderer, node)) {
      this.labelEl.hide();
      return;
    }
    // Fallback: a tooltip by the cursor.
    this.releaseText();
    this.labelEl.setText(this.displayName(node, id));
    this.labelEl.show();
    this.positionLabel();
  }

  // Keep the node's own graph label visible. Obsidian rewrites the label's
  // alpha/visibility every frame, so each of those properties is intercepted:
  // Obsidian's writes are remembered (and restored afterwards) while the real
  // value stays "shown".
  holdText(renderer, node) {
    const text = node.text;
    if (!text || typeof text !== 'object') return false;
    if (this.forcedText && this.forcedText.text === text) return true;
    this.releaseText();

    const restore = [];
    try {
      for (const [key, shown] of Object.entries(TEXT_VISIBILITY)) {
        if (!(key in text)) continue;
        const own = Object.getOwnPropertyDescriptor(text, key);
        let proto = null;
        for (let p = Object.getPrototypeOf(text); p && !proto; p = Object.getPrototypeOf(p)) {
          proto = Object.getOwnPropertyDescriptor(p, key) || null;
        }
        const protoSet = proto && typeof proto.set === 'function' ? proto.set : null;
        const entry = { key, own, protoSet, stored: text[key] };
        if (protoSet) protoSet.call(text, shown); // accessor-based PIXI: update its internal state
        Object.defineProperty(text, key, {
          configurable: true,
          enumerable: own ? own.enumerable : true,
          get() { return shown; },
          set(v) { entry.stored = v; if (protoSet) protoSet.call(text, shown); },
        });
        restore.push(entry);
      }
    } catch (e) {
      this.forcedText = { node, text, renderer, restore };
      this.releaseText();
      return false;
    }
    if (!restore.length) return false;
    this.lastSizes = this.sizeSnapshot(renderer, text); // before resizing, for diagnostics
    const releaseScale = this.holdScale(renderer, text);
    const releaseRender = this.holdRender(renderer, node);
    this.forcedText = { node, text, renderer, restore, releaseScale, releaseRender };
    if (typeof renderer.changed === 'function') renderer.changed();
    return true;
  }

  // Make the hovered label the same size as the selected (clicked) node's label.
  // Obsidian enlarges the highlighted node's label by scaling its text, so the
  // hovered label's scale is pinned to the selected label's current scale. Like
  // the visibility hold, Obsidian's own writes are remembered and restored later.
  holdScale(renderer, text) {
    const sp = text.scale;
    if (!sp || typeof sp !== 'object') return null;
    const plugin = this;
    const find = (k) => {
      for (let p = Object.getPrototypeOf(sp); p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, k);
        if (d) return d;
      }
      return null;
    };
    const keys = ['x', 'y', 'set', 'copyFrom'];
    const own = {};
    for (const k of keys) own[k] = Object.getOwnPropertyDescriptor(sp, k) || null;
    const protoX = find('x');
    const protoY = find('y');
    const protoSet = own.set && typeof own.set.value === 'function' ? own.set.value : (find('set') || {}).value;
    const stored = { x: sp.x, y: sp.y };

    const target = () => {
      const sel = plugin.lookupNode(renderer, plugin.selectedId);
      const st = sel && sel.text && sel.text !== text && sel.text.scale;
      return st && typeof st.x === 'number' ? { x: st.x, y: st.y } : null;
    };
    const write = (v) => {
      // Write through to PIXI's real storage so its transform updates.
      if (typeof protoSet === 'function') protoSet.call(sp, v.x, v.y);
      else {
        if (protoX && protoX.set) protoX.set.call(sp, v.x);
        if (protoY && protoY.set) protoY.set.call(sp, v.y);
      }
    };
    const apply = () => write(target() || stored);

    try {
      Object.defineProperty(sp, 'x', { configurable: true, enumerable: true,
        get() { const t = target(); return t ? t.x : stored.x; },
        set(v) { stored.x = v; apply(); } });
      Object.defineProperty(sp, 'y', { configurable: true, enumerable: true,
        get() { const t = target(); return t ? t.y : stored.y; },
        set(v) { stored.y = v; apply(); } });
      Object.defineProperty(sp, 'set', { configurable: true, writable: true,
        value(x, y) { stored.x = x; stored.y = y === undefined ? x : y; apply(); return sp; } });
      Object.defineProperty(sp, 'copyFrom', { configurable: true, writable: true,
        value(p) { if (p) { stored.x = p.x; stored.y = p.y; } apply(); return sp; } });
      apply();
    } catch (e) {
      for (const k of keys) { try { delete sp[k]; if (own[k]) Object.defineProperty(sp, k, own[k]); } catch (e2) { /* ignore */ } }
      return null;
    }

    return () => {
      for (const k of keys) {
        try {
          delete sp[k];
          if (own[k] && 'value' in own[k] && (k === 'x' || k === 'y')) Object.defineProperty(sp, k, Object.assign({}, own[k], { value: stored[k] }));
          else if (own[k]) Object.defineProperty(sp, k, own[k]);
        } catch (e) { /* ignore */ }
      }
      try { write(stored); } catch (e) { /* ignore */ }
    };
  }

  // Obsidian places each label with node.moveText(), and places the highlighted
  // node's label differently. While hovered, the node's moveText runs as if the
  // node were the highlighted one, so its label lands where it would if clicked.
  // Obsidian positions, sizes and shows a label while drawing its node
  // (node.render), but only for labels it considers visible; the highlighted
  // node's label always qualifies. While hovered, the node is drawn as if it
  // were the highlighted node, so Obsidian keeps its label placed exactly as
  // when clicked, every frame, as the graph moves or zooms.
  holdRender(renderer, node) {
    const orig = node.render;
    if (typeof orig !== 'function') return null;
    const hadOwn = Object.prototype.hasOwnProperty.call(node, 'render');
    const plugin = this;
    node.render = function () {
      const prev = plugin.highlightOverride;
      plugin.highlightOverride = node;
      try { return orig.apply(this, arguments); } finally { plugin.highlightOverride = prev; }
    };
    const flagText = () => { if (typeof node.moveText === 'boolean') node.moveText = true; };
    flagText();
    try { if (typeof renderer.changed === 'function') renderer.changed(); } catch (e) { /* ignore */ }
    return () => {
      if (hadOwn) node.render = orig;
      else delete node.render;
      flagText();
    };
  }

  // ------------------------------------------------------------------ line colours
  //
  // Obsidian colours each connection line by setting `tint` on the line's
  // display objects (and redoes it when the highlight changes). Each tint is
  // intercepted: lines touching the highlighted node get the colour of the
  // node at their other end; everything else gets Obsidian's own colour.

  tintTargets(link) {
    const out = [];
    if (!link || typeof link !== 'object') return out;
    for (const key of Object.keys(link)) {
      if (key === 'source' || key === 'target' || key === 'renderer') continue;
      const v = link[key];
      if (v && typeof v === 'object' && 'tint' in v) out.push(v);
    }
    return out;
  }

  endNode(renderer, end) {
    if (!end) return null;
    if (typeof end === 'string') return this.lookupNode(renderer, end);
    return end;
  }

  nodeColor(node) {
    if (this.settings.groupColorFirst) {
      const h = node && node.circle && this.circleTints && this.circleTints.get(node.circle);
      const own = h ? this.ownColor(h) : this.groupColor(node);
      if (own != null) return own;
    }
    let c = null;
    try { if (typeof node.getFillColor === 'function') c = node.getFillColor(); } catch (e) { c = null; }
    if (c == null) c = node.color;
    if (typeof c === 'number') return c;
    if (c && typeof c.rgb === 'number') return c.rgb;
    return null;
  }

  linkColor(renderer, link) {
    if (!this.settings.colorLinks) return null;
    let hl = null;
    try { hl = typeof renderer.getHighlightNode === 'function' ? renderer.getHighlightNode() : renderer.highlightNode; } catch (e) { hl = null; }
    if (!hl) return null;
    const a = this.endNode(renderer, link.source);
    const b = this.endNode(renderer, link.target);
    const other = a === hl ? b : (b === hl ? a : null);
    return other ? this.nodeColor(other) : null;
  }

  hookLinks(renderer) {
    if (!Array.isArray(renderer.links)) return;
    const plugin = this;
    for (const link of renderer.links) {
      for (const obj of this.tintTargets(link)) {
        if (this.tintHooks.has(obj)) continue;
        let proto = null;
        for (let p = Object.getPrototypeOf(obj); p && !proto; p = Object.getPrototypeOf(p)) {
          const d = Object.getOwnPropertyDescriptor(p, 'tint');
          if (d && typeof d.set === 'function') proto = d;
        }
        const own = Object.getOwnPropertyDescriptor(obj, 'tint') || null;
        const h = { link, renderer, protoSet: proto ? proto.set : null, own, intended: obj.tint, real: obj.tint };
        try {
          Object.defineProperty(obj, 'tint', {
            configurable: true,
            enumerable: true,
            // Obsidian reads back what it wrote, so its own change detection keeps working.
            get() { return h.protoSet ? h.intended : h.real; },
            set(v) { h.intended = v; plugin.applyTint(obj, h); },
          });
        } catch (e) { continue; }
        this.tintHooks.set(obj, h);
      }
    }
  }

  applyTint(obj, h) {
    const color = this.linkColor(h.renderer, h.link);
    let value;
    if (color != null) {
      // Highlighted: the other end's colour.
      h.fade = null;
      h.colored = true;
      value = color;
    } else if (h.colored) {
      // Just stopped being highlighted: start from the colour it had and blend
      // into Obsidian's colour while Obsidian fades the line.
      if (!h.fade) h.fade = { from: h.real, start: now() };
      const p = Math.min(1, (now() - h.fade.start) / LINE_FADE_MS);
      value = mixColor(h.fade.from, h.intended, 1 - Math.pow(1 - p, 3));
      if (p >= 1) {
        h.fade = null;
        h.colored = false;
        value = h.intended;
        this.fadingTints.delete(obj);
      } else {
        this.fadingTints.add(obj);
        this.startFadeLoop();
      }
    } else {
      value = h.intended;
    }
    h.real = value;
    if (h.protoSet) h.protoSet.call(obj, value);
  }

  // Keeps fading lines updating every frame (and asks Obsidian to keep
  // redrawing) until they've all reached their default colour.
  startFadeLoop() {
    if (this.fadeFrame) return;
    const tick = () => {
      this.fadeFrame = 0;
      const renderers = new Set();
      for (const obj of [...this.fadingTints]) {
        const h = this.tintHooks.get(obj);
        if (!h) { this.fadingTints.delete(obj); continue; }
        try { this.applyTint(obj, h); } catch (e) { this.fadingTints.delete(obj); }
        renderers.add(h.renderer);
      }
      for (const r of renderers) { try { if (typeof r.changed === 'function') r.changed(); } catch (e) { /* ignore */ } }
      if (this.fadingTints.size && !this.fadeFrame) this.fadeFrame = window.requestAnimationFrame(tick);
    };
    this.fadeFrame = window.requestAnimationFrame(tick);
  }

  // Re-apply after the setting changes or the highlight changes without Obsidian rewriting tints.
  refreshLinkTints() {
    for (const [obj, h] of this.tintHooks) { try { this.applyTint(obj, h); } catch (e) { /* ignore */ } }
  }

  unhookTint(obj, h) {
    try {
      delete obj.tint;
      if (h.own && 'value' in h.own) Object.defineProperty(obj, 'tint', Object.assign({}, h.own, { value: h.intended }));
      else if (h.own) Object.defineProperty(obj, 'tint', h.own);
      else if (h.protoSet) h.protoSet.call(obj, h.intended);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ group colour first
  //
  // Obsidian replaces a node's group colour with the accent colour when it's
  // the open note ("focused") or the highlighted node. Each circle's tint is
  // intercepted, and those special colours are swapped back for the node's
  // group colour. Nodes without a group keep Obsidian's colours.

  specialFills(renderer) {
    const out = new Set();
    const cs = renderer && renderer.colors;
    if (!cs) return out;
    for (const k of Object.keys(cs)) {
      if (/^fill/i.test(k) && /focus|highlight/i.test(k) && cs[k] && typeof cs[k].rgb === 'number') out.add(cs[k].rgb);
    }
    return out;
  }

  // The node's colour-group colour, or null if it isn't in a group.
  groupColor(node) {
    const c = node && node.color;
    const rgb = typeof c === 'number' ? c : (c && typeof c.rgb === 'number' ? c.rgb : null);
    if (rgb == null) return null;
    const renderer = node.renderer || this.hoverRenderer;
    if (renderer && this.specialFills(renderer).has(rgb)) return null; // not a group colour
    return rgb;
  }

  hookCircleTints(renderer) {
    if (!Array.isArray(renderer.nodes)) return;
    const plugin = this;
    for (const node of renderer.nodes) {
      const circle = node && node.circle;
      if (!circle || this.circleTints.has(circle)) continue;
      let proto = null;
      for (let p = Object.getPrototypeOf(circle); p && !proto; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, 'tint');
        if (d && typeof d.set === 'function') proto = d;
      }
      if (!proto) continue;
      const h = { node, renderer, protoSet: proto.set, own: Object.getOwnPropertyDescriptor(circle, 'tint') || null, intended: circle.tint };
      try {
        Object.defineProperty(circle, 'tint', {
          configurable: true,
          enumerable: true,
          get() { return h.intended; }, // Obsidian reads back its own value
          set(v) { h.intended = v; plugin.applyCircleTint(circle, h); },
        });
      } catch (e) { continue; }
      this.circleTints.set(circle, h);
      this.applyCircleTint(circle, h);
    }
  }

  // Is Obsidian drawing this node in a special (accent) colour right now?
  // True for the highlighted node (this includes a hovered node being drawn
  // as highlighted) and for the open note's node.
  isSpecialNode(renderer, node) {
    let hl = null;
    try { hl = typeof renderer.getHighlightNode === 'function' ? renderer.getHighlightNode() : renderer.highlightNode; } catch (e) { hl = null; }
    if (hl === node) return true;
    const active = this.app.workspace.getActiveFile && this.app.workspace.getActiveFile();
    return !!(active && node && active.path === node.id);
  }

  hasHighlight(renderer) {
    try { return !!(typeof renderer.getHighlightNode === 'function' ? renderer.getHighlightNode() : renderer.highlightNode); } catch (e) { return false; }
  }

  // The node's own colour: what Obsidian last drew it as while it wasn't
  // highlighted or open (its group colour, or the default node colour).
  ownColor(h) {
    let c = h.cleanNormal != null ? h.cleanNormal : h.normal;
    if (c == null) c = this.groupColor(h.node);
    if (c == null) return null;
    const def = h.renderer && h.renderer.colors && h.renderer.colors.fill;
    if (def && typeof def.rgb === 'number' && def.rgb === c) return null; // not in a group
    return c;
  }

  applyCircleTint(circle, h) {
    const v = h.intended;
    let value = v;
    if (this.isSpecialNode(h.renderer, h.node)) {
      if (this.settings.groupColorFirst) {
        const own = this.ownColor(h);
        if (own != null) value = own;
        // Remember the colour to hold while Obsidian fades the node back
        // from the accent colour after it stops being highlighted/open.
        h.settleTo = own;
      }
      h.settle = null;
    } else if (h.settleTo != null && this.settings.groupColorFirst) {
      // Obsidian is fading this node from the accent colour back to normal.
      // Hold the node's own colour, and don't learn the in-between shades.
      if (!h.settle) h.settle = { last: null, start: now() };
      const done = v === h.settleTo || v === h.settle.last || now() - h.settle.start > 3000;
      h.settle.last = v;
      value = h.settleTo;
      if (done) {
        h.settleTo = null;
        h.settle = null;
        value = v;
        h.normal = v;
        if (!this.hasHighlight(h.renderer)) h.cleanNormal = v;
      }
    } else {
      h.settleTo = null;
      h.normal = v;
      if (!this.hasHighlight(h.renderer)) h.cleanNormal = v;
    }
    h.protoSet.call(circle, value);
  }

  refreshCircleTints() {
    for (const [circle, h] of this.circleTints) { try { this.applyCircleTint(circle, h); } catch (e) { /* ignore */ } }
  }

  unhookCircleTint(circle, h) {
    try {
      delete circle.tint;
      if (h.own && 'value' in h.own) Object.defineProperty(circle, 'tint', Object.assign({}, h.own, { value: h.intended }));
      else if (h.own) Object.defineProperty(circle, 'tint', h.own);
      else h.protoSet.call(circle, h.intended);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ selected node style
  //
  // Obsidian's own ring around the open note's node is recoloured through
  // styles.css (via a body class): black in light mode, white in dark mode.

  // styles.css recolours Obsidian's open-note ring only while this class is on <body>.
  syncMarkerClass() {
    const on = !!this.settings.styleSelected && !this.unloading;
    const body = document.body;
    if (!body || !body.classList) return;
    if (body.classList.contains('gcs-bw-nodes') === on) return;
    body.classList.toggle('gcs-bw-nodes', on);
    // Ask Obsidian to re-read its graph colours from CSS.
    try { this.app.workspace.trigger('css-change'); } catch (e) { /* ignore */ }
  }

  updateSelectedStyle() {
    this.syncMarkerClass();
  }

  sizeSnapshot(renderer, text) {
    const sel = this.lookupNode(renderer, this.selectedId);
    const info = (t) => {
      if (!t) return 'none';
      const st = t.style || {};
      return `scale=${t.scale ? `${t.scale.x}x${t.scale.y}` : '?'} fontSize=${st.fontSize} height=${t.height}`;
    };
    const pos = (n) => (n && n.text ? ` pos=${round(n.text.x - n.x)},${round(n.text.y - n.y)} anchor=${n.text.anchor ? `${n.text.anchor.x},${n.text.anchor.y}` : '?'} size=${typeof n.getSize === 'function' ? round(n.getSize()) : '?'}` : '');
    const round = (v) => Math.round(v * 100) / 100;
    const hov = this.hoverRenderer && this.lookupNode(renderer, this.hoverId);
    return `hovered[${info(text)}${pos(hov)}] selected[${info(sel && sel.text)}${pos(sel)}] zoom=${renderer.scale}`;
  }

  releaseText() {
    const f = this.forcedText;
    if (!f) return;
    this.forcedText = null;
    if (f.releaseScale) f.releaseScale();
    if (f.releaseRender) f.releaseRender();
    for (const { key, own, protoSet, stored } of f.restore) {
      try {
        delete f.text[key];
        if (own && 'value' in own) Object.defineProperty(f.text, key, Object.assign({}, own, { value: stored }));
        else if (own) Object.defineProperty(f.text, key, own);
        else if (protoSet) protoSet.call(f.text, stored);
      } catch (e) { /* ignore */ }
    }
    try { if (typeof f.renderer.changed === 'function') f.renderer.changed(); } catch (e) { /* ignore */ }
  }

  displayName(node, id) {
    try {
      if (node && typeof node.getDisplayText === 'function') {
        const t = node.getDisplayText();
        if (t) return t;
      }
    } catch (e) { /* fall through */ }
    return String(id).split('/').pop().replace(/\.md$/, '');
  }

  positionLabel() {
    this.labelEl.style.left = `${this.mouse.x + 14}px`;
    this.labelEl.style.top = `${this.mouse.y + 14}px`;
  }

  // ------------------------------------------------------------------ hooking

  scan() {
    const live = new Set();
    for (const type of GRAPH_TYPES) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (type === 'graph' && this.settings.pinGraph) {
          try { if (!leaf.getViewState().pinned) leaf.setPinned(true); } catch (e) { /* ignore */ }
        }
        const renderer = leaf.view && leaf.view.renderer;
        if (!renderer) continue;
        live.add(renderer);
        let hook = this.hooks.get(renderer);
        if (!hook) hook = this.hook(renderer, leaf);
        if (!hook) continue;
        hook.leaf = leaf;
        // Obsidian may reassign callbacks; re-wrap if so.
        this.wrapCallback(renderer, hook, 'onNodeClick', (orig, self, args) => this.handleNodeClick(renderer, hook, orig, self, args));
        this.wrapCallback(renderer, hook, 'onNodeHover', (orig, self, args) => {
          this.signals.onNodeHover++;
          return orig && orig.apply(self, args);
        });
        this.wrapCallback(renderer, hook, 'onNodeUnhover', (orig, self, args) => {
          hook.store = null;
          return orig && orig.apply(self, args);
        });
        this.attachCircleListeners(renderer);
        this.hookLinks(renderer);
        this.hookCircleTints(renderer);
      }
    }
    for (const renderer of [...this.hooks.keys()]) if (!live.has(renderer)) this.hooks.delete(renderer);

    // Release colour hooks for circles that no longer exist.
    const liveCircleSet = new Set();
    for (const renderer of live) {
      if (Array.isArray(renderer.nodes)) for (const n of renderer.nodes) if (n && n.circle) liveCircleSet.add(n.circle);
    }
    for (const [circle, h] of this.circleTints) {
      if (!liveCircleSet.has(circle)) { this.unhookCircleTint(circle, h); this.circleTints.delete(circle); }
    }

    // Release line hooks for links that no longer exist.
    const liveLinkObjs = new Set();
    for (const renderer of live) {
      if (Array.isArray(renderer.links)) for (const l of renderer.links) for (const o of this.tintTargets(l)) liveLinkObjs.add(o);
    }
    for (const [obj, h] of this.tintHooks) {
      if (!liveLinkObjs.has(obj)) { this.unhookTint(obj, h); this.tintHooks.delete(obj); }
    }

    // Drop listeners for circles that no longer belong to any open graph.
    const liveCircles = new Set();
    for (const renderer of live) {
      if (Array.isArray(renderer.nodes)) for (const n of renderer.nodes) if (n && n.circle) liveCircles.add(n.circle);
    }
    for (const [circle, b] of this.circleBindings) {
      if (!liveCircles.has(circle)) { this.detachCircle(circle, b); this.circleBindings.delete(circle); }
    }
  }

  hook(renderer, leaf) {
    if (!('highlightNode' in renderer) && typeof renderer.getHighlightNode !== 'function') {
      if (!this.warned) {
        this.warned = true;
        new Notice('Intuitive Graph Navigation: this Obsidian version\'s graph view isn\'t supported.');
      }
      return null;
    }
    const plugin = this;
    const hook = {
      leaf,
      store: renderer.highlightNode || null,
      hadOwnHighlight: Object.prototype.hasOwnProperty.call(renderer, 'highlightNode'),
      originals: {},
      origGet: null,
      hadOwnGet: Object.prototype.hasOwnProperty.call(renderer, 'getHighlightNode'),
    };

    // Obsidian writes the hovered node to highlightNode; reads return the selection instead.
    Object.defineProperty(renderer, 'highlightNode', {
      configurable: true,
      enumerable: true,
      get() { return plugin.effectiveHighlight(renderer, hook.store); },
      set(value) {
        if (value === hook.store) return;
        hook.store = value;
        plugin.signals.setter++;
      },
    });

    if (typeof renderer.getHighlightNode === 'function') {
      hook.origGet = renderer.getHighlightNode;
      renderer.getHighlightNode = function () {
        return plugin.effectiveHighlight(renderer, hook.origGet.apply(this, arguments));
      };
    }

    const container = leaf.view && leaf.view.containerEl;
    if (container) {
      this.registerDomEvent(container, 'mouseleave', () => { hook.store = null; this.setHover(renderer, null); });
    }

    this.hooks.set(renderer, hook);
    if (typeof renderer.changed === 'function') renderer.changed();
    return hook;
  }

  wrapCallback(renderer, hook, name, impl) {
    const current = renderer[name];
    if (typeof current === 'function' && this.wrappedFns.has(current)) return;
    if (typeof current !== 'function' && name !== 'onNodeHover' && name !== 'onNodeUnhover') return;
    hook.originals[name] = typeof current === 'function' ? current : null;
    const wrapped = function () { return impl(hook.originals[name], this, Array.from(arguments)); };
    this.wrappedFns.add(wrapped);
    renderer[name] = wrapped;
  }

  // PIXI hit-testing on each node's circle, as a fallback hover signal.
  attachCircleListeners(renderer) {
    const nodes = renderer.nodes;
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const circle = node && node.circle;
      if (!circle || this.circleBindings.has(circle) || typeof circle.on !== 'function') continue;
      const over = () => this.setHover(renderer, node.id, 'circle');
      const out = () => { if (this.hoverId === node.id) this.setHover(renderer, null); };
      circle.on('pointerover', over);
      circle.on('pointerout', out);
      this.circleBindings.set(circle, { over, out });
    }
  }

  detachCircle(circle, b) {
    try {
      if (typeof circle.off === 'function') {
        circle.off('pointerover', b.over);
        circle.off('pointerout', b.out);
      }
    } catch (e) { /* ignore */ }
  }

  unhook(renderer, hook) {
    try {
      delete renderer.highlightNode;
      if (hook.hadOwnHighlight) renderer.highlightNode = hook.store;
      if (hook.origGet) {
        if (hook.hadOwnGet) renderer.getHighlightNode = hook.origGet;
        else delete renderer.getHighlightNode;
      }
      for (const [name, orig] of Object.entries(hook.originals)) {
        if (orig) renderer[name] = orig;
        else delete renderer[name];
      }
      if (typeof renderer.changed === 'function') renderer.changed();
    } catch (e) {
      console.error('Intuitive Graph Navigation: failed to restore graph renderer', e);
    }
  }

  lookupNode(renderer, id) {
    if (!id) return null;
    if (renderer.nodeLookup && renderer.nodeLookup[id]) return renderer.nodeLookup[id];
    const nodes = renderer.nodes;
    if (Array.isArray(nodes)) return nodes.find((n) => n && n.id === id) || null;
    return null;
  }

  effectiveHighlight(renderer, hovered) {
    if (this.highlightOverride) return this.highlightOverride;
    if (this.settings.mode !== 'click') return hovered || null;
    const selected = this.lookupNode(renderer, this.selectedId);
    if (selected) return selected;
    return this.settings.hoverWhenNothingSelected ? (hovered || null) : null;
  }

  // ------------------------------------------------------------------ clicks

  handleNodeClick(renderer, hook, orig, self, args) {
    const [evt, id] = args;
    const callOriginal = () => orig && orig.apply(self, args);

    if (this.settings.mode !== 'click') return callOriginal();

    this.setSelected(id);
    if (evt && Keymap.isModEvent(evt)) return callOriginal(); // Ctrl/Cmd-click: normal new tab / split
    if (this.settings.openInOtherPane && this.openOutsideGraph(hook.leaf, id)) return;
    return callOriginal();
  }

  openOutsideGraph(graphLeaf, path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const ws = this.app.workspace;
    const isGraph = (leaf) => leaf && leaf.view && GRAPH_TYPES.includes(leaf.view.getViewType());
    const usable = (leaf) => leaf && !isGraph(leaf) && (!graphLeaf || leaf.parent !== graphLeaf.parent);

    let target = null;
    const recent = ws.getMostRecentLeaf && ws.getMostRecentLeaf();
    if (usable(recent)) target = recent;
    if (!target) ws.iterateRootLeaves((leaf) => { if (!target && usable(leaf)) target = leaf; });
    if (!target) {
      if (!graphLeaf || graphLeaf.getRoot() !== ws.rootSplit) return false; // local graph in a sidebar
      target = ws.createLeafBySplit(graphLeaf, 'vertical');
    }
    target.openFile(file);
    return true;
  }

  // ------------------------------------------------------------------ diagnostics

  copyDiagnostics() {
    const lines = [`Obsidian ${window.electron ? 'desktop' : ''} | apiVersion ${require('obsidian').apiVersion || '?'}`,
      `mode=${this.settings.mode} selected=${this.selectedId} hovered=${this.hoverId}`,
      `hover signals seen: ${JSON.stringify(this.signals)}`];
    for (const [renderer, hook] of this.hooks) {
      const node = Array.isArray(renderer.nodes) ? renderer.nodes[0] : null;
      const keys = (o) => {
        const out = new Set();
        let p = o;
        for (let i = 0; p && i < 3; i++, p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((k) => out.add(k));
        return [...out].sort().join(',');
      };
      lines.push(`view=${hook.leaf && hook.leaf.view.getViewType()} nodes=${Array.isArray(renderer.nodes) ? renderer.nodes.length : typeof renderer.nodes}`);
      lines.push(`renderer keys: ${keys(renderer)}`);
      if (node) {
        lines.push(`node keys: ${keys(node)}`);
        const link = Array.isArray(renderer.links) ? renderer.links[0] : null;
        if (link) {
          const ks = (o) => Object.keys(o).map((k) => `${k}:${o[k] && typeof o[k] === 'object' ? ('tint' in o[k] ? 'tinted' : 'obj') : typeof o[k]}`).join(',');
          lines.push(`link: ${ks(link)} | hooked line objects=${this.tintHooks.size}`);
        } else lines.push('link: none');
        try { lines.push(`node fill: ${JSON.stringify(node.getFillColor && node.getFillColor())} color=${JSON.stringify(node.color)}`); } catch (e) { lines.push('node fill: error'); }
        lines.push(`circle: ${node.circle ? `on=${typeof node.circle.on} eventMode=${node.circle.eventMode} interactive=${node.circle.interactive} type=${node.circle.constructor && node.circle.constructor.name} lineStyle=${typeof node.circle.lineStyle} tint=${node.circle.tint}` : 'none'}`);
        try {
          const cs = renderer.colors || {};
          lines.push(`colors: ${Object.keys(cs).map((k) => `${k}=${cs[k] && typeof cs[k].rgb === 'number' ? '#' + cs[k].rgb.toString(16).padStart(6, '0') : JSON.stringify(cs[k])}`).join(' ')}`);
        } catch (e) { lines.push('colors: error'); }
        const selNode = this.lookupNode(renderer, this.selectedId);
        lines.push(`camera: pan=${renderer.panX},${renderer.panY} size=${renderer.width}x${renderer.height} scale=${renderer.scale} dpr=${window.devicePixelRatio} view=${hook.leaf && hook.leaf.view.containerEl ? `${hook.leaf.view.containerEl.clientWidth}x${hook.leaf.view.containerEl.clientHeight}` : '?'} setPan=${typeof renderer.setPan} node=${selNode ? `${Math.round(selNode.x)},${Math.round(selNode.y)}` : '-'}`);
        const sh = selNode && selNode.circle && this.circleTints.get(selNode.circle);
        const hex = (v) => (typeof v === 'number' ? '#' + v.toString(16).padStart(6, '0') : String(v));
        lines.push(`colour hooks=${this.circleTints.size} selected: ${sh ? `intended=${hex(sh.intended)} normal=${hex(sh.normal)} cleanNormal=${hex(sh.cleanNormal)} own=${hex(this.ownColor(sh))} special=${this.isSpecialNode(renderer, selNode)}` : 'not hooked'} nodeColor=${selNode ? JSON.stringify(selNode.color) : '-'}`);
        if (selNode && selNode.circle) {
          const c = selNode.circle;
          const kids = Array.isArray(c.children) ? c.children.map((k) => `${k.constructor && k.constructor.name} tint=${hex(k.tint)}`).join(', ') : 'n/a';
          lines.push(`selected circle: tint=${hex(c.tint)} children=[${kids}] parent=${c.parent && c.parent.constructor && c.parent.constructor.name} siblings=${c.parent && c.parent.children ? c.parent.children.length : '?'}`);
        }
        const t = node.text;
        if (t) {
          let d = null;
          for (let p = t; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, 'alpha');
          lines.push(`text: alpha=${t.alpha} (${d ? ('get' in d ? 'accessor' : 'field') : 'missing'}) visible=${t.visible} parent=${!!t.parent}`);
        } else lines.push('text: none');
        lines.push(`label held: ${this.forcedText ? this.forcedText.node.id : 'none'}`);
        lines.push(`last hover sizes: ${this.lastSizes || 'none yet'}`);
        lines.push(`moveText: ${typeof node.moveText} ${typeof node.moveText === 'function' ? '' : String(node.moveText)}`);
        if (typeof node.render === 'function') lines.push(`render params=${node.render.length}: ${String(Object.getPrototypeOf(node).render || node.render).slice(0, 1500)}`);
      }
    }
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(
      () => new Notice('Intuitive Graph Navigation: diagnostics copied to clipboard'),
      () => { console.log(text); new Notice('Intuitive Graph Navigation: diagnostics written to the developer console'); });
  }
};

class IntuitiveGraphNavigationSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Mode')
      .setDesc('Hover mode is Obsidian\'s normal behaviour. Click mode opens the note and keeps its node highlighted until you press Escape or click another node; hovering shows node names.')
      .addDropdown((d) => d
        .addOption('click', 'Click mode')
        .addOption('hover', 'Hover mode')
        .setValue(s.mode)
        .onChange(async (v) => { s.mode = v; if (v === 'hover') this.plugin.selectedId = null; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Keep graph tabs pinned')
      .setDesc('Pins every global graph tab so opening notes never replaces it.')
      .addToggle((t) => t.setValue(s.pinGraph).onChange(async (v) => { s.pinGraph = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Select the open note')
      .setDesc('Opening a note from the file explorer, a link or the quick switcher selects its node, as if you had clicked it.')
      .addToggle((t) => t.setValue(s.followActiveFile).onChange(async (v) => { s.followActiveFile = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Hover highlight when nothing is selected')
      .setDesc('In Click mode, hovering still highlights connections while no node is selected.')
      .addToggle((t) => t.setValue(s.hoverWhenNothingSelected).onChange(async (v) => { s.hoverWhenNothingSelected = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Hover name style')
      .setDesc('In Click mode, how a hovered node\'s name is shown: as the graph\'s own label under the node, or as a tooltip by the cursor.')
      .addDropdown((d) => d
        .addOption('graph', 'Graph label')
        .addOption('tooltip', 'Tooltip')
        .setValue(s.hoverLabelStyle)
        .onChange(async (v) => { s.hoverLabelStyle = v; this.plugin.updateLabel(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Black and white open-note ring')
      .setDesc('Obsidian\'s ring around the open note\'s node is black in light mode and white in dark mode, instead of the accent colour.')
      .addToggle((t) => t.setValue(s.styleSelected).onChange(async (v) => { s.styleSelected = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Group colour first')
      .setDesc('Nodes in a colour group keep their group colour when they are the open note or highlighted, instead of switching to the accent colour.')
      .addToggle((t) => t.setValue(s.groupColorFirst).onChange(async (v) => { s.groupColorFirst = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Colour connections by node')
      .setDesc('Lines from the highlighted node take the colour of the node at the other end. Other lines keep the default colour.')
      .addToggle((t) => t.setValue(s.colorLinks).onChange(async (v) => { s.colorLinks = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Centre on selected node')
      .setDesc('In Click mode, the graph glides so the selected node moves to the centre of the view.')
      .addToggle((t) => t.setValue(s.centerOnSelect).onChange(async (v) => { s.centerOnSelect = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Open notes beside the graph')
      .setDesc('Clicked notes open in another pane (splitting the graph tab if needed) so the graph stays visible.')
      .addToggle((t) => t.setValue(s.openInOtherPane).onChange(async (v) => { s.openInOtherPane = v; await this.plugin.saveSettings(); }));
  }
}
