'use strict';

/*
 * Intuitive Graph Navigation
 * Copyright (c) 2026 Gregory Jackson. MIT License.
 *
 * Adds a "Click mode" to Obsidian's graph view:
 *   - Clicking a node selects it, opens its note beside the graph and glides
 *     the camera to it; the highlight stays until Escape or another click.
 *   - Ctrl/Cmd-click selects several nodes: only they, the nodes they all
 *     share and the connections between them stay lit.
 *   - Graph nodes, files in the file explorer and links in notes all follow
 *     the same selection rules; the notes pane holds exactly the selection.
 *   - Notes open in Reading view; click in to edit, Escape to return.
 *   - Hovering a node shows its label as if it were clicked.
 *   - Lines from the highlighted node take the colour of the node at the
 *     other end; grouped nodes keep their group colour when highlighted.
 *   - The open note's ring is black (light mode) or white (dark mode).
 *   - The camera keeps the graph steady when the notes pane opens or closes.
 *
 * Obsidian has no public API for the graph renderer, so this hooks into
 * internals (view.renderer, renderer.highlightNode, renderer.onNodeClick,
 * renderer.onResize, node.render, node.circle, link display objects), and
 * wraps workspace.getLeaf and workspace.trigger. Every hook is guarded, and
 * the original behaviour is restored on unload.
 */

const { Plugin, PluginSettingTab, Setting, Notice, setIcon, Keymap, TFile } = require('obsidian');

const DEFAULT_SETTINGS = {
  mode: 'click',                  // 'click' | 'hover'
  pinGraph: true,                 // keep global graph tabs pinned
  followActiveFile: true,         // opening a note selects its node
  hoverWhenNothingSelected: true, // in click mode, hover still highlights while nothing is selected
  openInOtherPane: true,          // open notes outside the graph's tab group so the graph stays visible
  tabsFollowSelection: true,      // Click mode: the notes pane's tabs are exactly the selected notes
  previewOnHover: false,          // allow Obsidian's note preview (Ctrl-hover) from graph nodes and the file explorer
  openInReadingView: true,        // notes opened beside the graph start in Reading view
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
  // A small startup log is kept in the plugin's data file (when Obsidian
  // started the plugin, how far it got, any errors), so diagnostics taken in a
  // later session can show what happened in an earlier startup.
  async onload() {
    try {
      await this.loadInner();
      this.logStage('loaded');
    } catch (e) {
      this.noteError('startup', e);
    }
  }

  logStage(stage) {
    if (!this.startupLog) return;
    this.startupLog.stages.push(`${stage}@${Date.now() - this.startupLog.t0}ms`);
    this.persistLog();
  }

  persistLog() {
    if (!this.settings) return;
    try {
      const data = Object.assign({}, this.settings, { _startupLog: { previous: this.previousStartupLog || null, current: this.startupLog } });
      Promise.resolve(this.saveData(data)).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  async loadInner() {
    this.loadErrors = [];
    let saved = null;
    try { saved = await this.loadData(); } catch (e) { this.noteError('loadData', e); }
    this.previousStartupLog = saved && saved._startupLog ? saved._startupLog.current : null;
    this.startupLog = { started: new Date().toISOString(), t0: Date.now(), obsidianStarting: !this.app.workspace.layoutReady, stages: ['start'], errors: [] };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    delete this.settings._startupLog;
    delete this.settings.openOnDoubleClick; // removed in 1.1
    this.persistLog();
    this.selectedId = null;
    this.selection = []; // selected node ids; the first is the primary (Obsidian's highlight)
    this.lastLayout = new Map(); // renderer -> size, pan and screen position as of the last frame
    this.editingLeaves = new WeakMap(); // notes-pane leaf -> path the user clicked into to edit
    this.multiCache = new WeakMap(); // renderer -> cached lit sets for a multi-selection
    this.protoRestores = [];
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

    this.safely('ring colour', () => this.syncMarkerClass()); // as early as possible, before the graph is set up
    this.app.workspace.onLayoutReady(() => {
      this.logStage('layout-ready');
      this.safely('scan', () => this.scan());
      this.safely('ring colour', () => this.syncMarkerClass(true));
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scan()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scan()));
    this.registerEvent(this.app.workspace.on('css-change', () => this.updateSelectedStyle()));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      this.applyReadingView(file);
      if (!file || this.settings.mode !== 'click' || !this.settings.followActiveFile) return;
      const g = this.lastGetLeaf;
      const modOpen = !!(g && (g.mode === 'tab' || g.mode === true) && now() - g.time < 1500);
      this.lastGetLeaf = null;
      if (modOpen) {
        // Ctrl/Cmd-click outside the graph (e.g. the file explorer): add to / remove from the selection.
        const added = this.toggleInSelection(file.path);
        if (this.tabsManaged()) this.syncTabs(null, added ? file.path : null);
        return;
      }
      if (this.selection.includes(file.path)) return; // already selected (e.g. switching between its tabs)
      this.setSelected(file.path);
      if (this.tabsManaged()) this.syncTabs(null, null);
    }));

    this.safely('workspace routing', () => this.patchWorkspace());

    // Capture phase so the graph canvas can't swallow the event before we see it.
    const track = (evt) => {
      this.mouse = { x: evt.clientX, y: evt.clientY };
      if (this.labelEl.isShown()) this.positionLabel();
    };
    this.registerDomEvent(document, 'pointermove', track, { capture: true });
    this.registerDomEvent(document, 'pointerdown', () => { this.pointerHeld = true; }, { capture: true });
    this.registerDomEvent(document, 'pointerup', () => { this.pointerHeld = false; }, { capture: true });
    this.registerDomEvent(document, 'pointercancel', () => { this.pointerHeld = false; }, { capture: true });
    this.registerDomEvent(document, 'mousemove', track, { capture: true });

    this.registerDomEvent(document, 'keydown', (evt) => {
      if (evt.key !== 'Escape') return;
      if (document.querySelector('.modal-container, .menu, .suggestion-container, .prompt')) return;
      const t = evt.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) {
        // Typing in a note beside the graph: Escape returns it to Reading view.
        if (this.settings.openInReadingView) {
          const leaf = this.leafContaining(t);
          if (leaf && this.inNotesPane(leaf) && leaf.view && typeof leaf.view.getMode === 'function' && leaf.view.getMode() === 'source') {
            this.editingLeaves.delete(leaf);
            this.setLeafMode(leaf, 'preview');
          }
        }
        return;
      }
      if (!this.selection.length || this.settings.mode !== 'click') return;
      this.clearSelection();
    });

    // Click mode: clicks on files in the file explorer and links in notes follow
    // the same selection rules as graph nodes.
    this.registerDomEvent(document, 'click', (evt) => this.onNoteClick(evt), { capture: true });

    // Clicking into a note shown in Reading view beside the graph switches it to editing.
    this.registerDomEvent(document, 'click', (evt) => {
      if (!this.settings.openInReadingView) return;
      const t = evt.target;
      if (!t || typeof t.closest !== 'function' || !t.closest('.markdown-reading-view')) return;
      if (t.closest('a, .internal-link, .external-link, .tag, input, button, .internal-embed, .task-list-item-checkbox, .collapse-indicator, .heading-collapse-indicator')) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) return; // selecting text, not clicking in
      const leaf = this.leafContaining(t);
      if (!leaf || !this.inNotesPane(leaf) || !leaf.view || typeof leaf.view.getMode !== 'function' || leaf.view.getMode() !== 'preview') return;
      this.editingLeaves.set(leaf, this.leafPath(leaf));
      this.setLeafMode(leaf, 'source').then(() => { try { if (leaf.view.editor) leaf.view.editor.focus(); } catch (e) { /* ignore */ } });
    });

    // 2/3. Closing a selected note's tab deselects that node.
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      window.clearTimeout(this.closedTimer);
      this.closedTimer = window.setTimeout(() => this.checkClosedTabs(), 120);
    }));

    // Renderers and their nodes are created or replaced over time (deferred
    // tabs, graph refreshes), so re-check regularly. This is cheap.
    this.registerInterval(window.setInterval(() => this.scan(), 700));
  }

  noteError(where, e) {
    this.loadErrors = this.loadErrors || [];
    const msg = `${where}: ${e && e.message ? e.message : e}`;
    this.loadErrors.push(msg);
    if (this.startupLog) { this.startupLog.errors.push(msg); this.persistLog(); }
    console.error(`Intuitive Graph Navigation (${where}):`, e);
  }

  safely(where, fn) {
    try { return fn(); } catch (e) { this.noteError(where, e); return undefined; }
  }

  onunload() {
    this.unloading = true;
    for (const restore of (this.wsRestores || [])) { try { restore(); } catch (e) { /* ignore */ } }
    this.wsRestores = [];
    this.stopPans();
    for (const restore of this.protoRestores) { try { restore(); } catch (e) { /* ignore */ } }
    this.protoRestores = [];
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
    await this.saveData(Object.assign({}, this.settings, { _startupLog: { previous: this.previousStartupLog || null, current: this.startupLog || null } }));
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
    this.selection = this.selectedId ? [this.selectedId] : [];
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
    if (!id) this.stopPans(); // nothing to glide to: the graph should stay where it is
    const changed = id !== this.selectedId || this.selection.length > 1;
    this.selectedId = id;
    this.selection = id ? [id] : [];
    if (id === null) for (const hook of this.hooks.values()) hook.store = null;
    this.refreshIndicators();
    this.redrawAll();
    if (id && changed && this.settings.mode === 'click' && this.settings.centerOnSelect) this.centerOn([id]);
  }

  // Clear the selection the way Escape does: deselect everything, close the
  // selected notes' tabs, and make the graph the active panel again (so Obsidian
  // stops treating a closed note as the open one, e.g. after a click in the file
  // explorer made the explorer the active panel).
  clearSelection() {
    const managed = this.tabsManaged();
    const graphLeaf = this.graphLeafForTabs(null);
    this.setSelected(null);
    if (managed) this.syncTabs(null, null);
    // Always switch: a panel in the sidebar (like the file explorer) can be the
    // active one without the main area noticing. Repeated just after the click
    // has finished, in case the clicked panel takes focus back.
    const ws = this.app.workspace;
    if (!graphLeaf || !graphLeaf.view) return;
    const activate = () => { try { ws.setActiveLeaf(graphLeaf, { focus: true }); } catch (e) { /* ignore */ } };
    activate();
    window.setTimeout(activate, 0);
  }

  // Ctrl/Cmd-click in Click mode: add the node to the selection, or remove it
  // if it's already selected. Returns true if the node was added.
  toggleInSelection(id) {
    if (!this.selection.length) { this.setSelected(id); return true; }
    const i = this.selection.indexOf(id);
    const added = i < 0;
    if (added) this.selection.push(id);
    else this.selection.splice(i, 1);
    this.selectedId = this.selection[0] || null;
    if (!this.selectedId) { this.stopPans(); for (const hook of this.hooks.values()) hook.store = null; }
    this.refreshIndicators();
    this.redrawAll();
    if (this.selection.length && this.settings.centerOnSelect) this.centerOn(this.selection);
    return added;
  }

  // ------------------------------------------------------------------ camera
  //
  // The graph draws a node at screen position node.x * scale + pan, so the
  // pan that puts a node in the middle of the view is size / 2 - node * scale.
  // The camera glides there over PAN_MS, following the node if it is still
  // moving as the graph settles.

  // Glide to the centre of the given nodes (one node, or a multi-selection).
  // Starts on the next frame. If the click has just opened the notes pane, it
  // first waits until the pane has appeared and the graph has finished
  // resizing (the graph stays still on screen meanwhile), then glides.
  centerOn(ids) {
    this.lastCenter = { ids: ids.slice(), time: now() };
    if (this.centerWait) window.cancelAnimationFrame(this.centerWait);
    let frames = 0;
    const go = () => {
      this.centerWait = 0;
      // Apply any resize correction still pending, so the glide starts from
      // where the node was on screen before the notes pane opened.
      for (const renderer of this.hooks.keys()) this.checkResize(renderer);
      for (const renderer of this.hooks.keys()) {
        const nodes = ids.map((id) => this.lookupNode(renderer, id)).filter(Boolean);
        if (!nodes.length || typeof renderer.panX !== 'number' || typeof renderer.scale !== 'number') continue;
        this.startPan(renderer, nodes);
      }
    };
    const wait = () => {
      if (this.graphResizing() && frames++ < 45) { this.centerWait = window.requestAnimationFrame(wait); return; }
      go();
    };
    this.centerWait = window.requestAnimationFrame(wait);
  }

  // True while a graph's on-screen size has changed but the graph itself
  // hasn't caught up yet (e.g. the notes pane is opening).
  // A resize is under way when the graph's on-screen width has changed but the
  // graph's own size hasn't changed since.
  graphResizing() {
    for (const renderer of this.hooks.keys()) {
      if (!Number.isFinite(renderer.width)) continue;
      const rect = this.viewRect(renderer);
      if (!rect.width) continue;
      const last = this.lastLayout.get(renderer);
      if (last && Number.isFinite(last.pairWidth)) {
        if (renderer.width === last.w && Math.abs(rect.width - last.pairWidth) > 1) return true;
      } else if (Math.abs(renderer.width / rect.k - rect.width) > 1) {
        return true;
      }
    }
    return false;
  }

  panTarget(renderer, nodes) {
    const w = renderer.width;
    const h = renderer.height;
    if (typeof w !== 'number' || typeof h !== 'number' || !w || !h) return null;
    let x = 0;
    let y = 0;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return null;
      x += n.x;
      y += n.y;
    }
    x /= nodes.length;
    y /= nodes.length;
    return { x: w / 2 - x * renderer.scale, y: h / 2 - y * renderer.scale };
  }

  setPan(renderer, x, y) {
    if (typeof renderer.setPan === 'function') renderer.setPan(x, y);
    else { renderer.panX = x; renderer.panY = y; }
    // Stop any leftover drag momentum fighting the glide.
    if (typeof renderer.panvX === 'number') renderer.panvX = 0;
    if (typeof renderer.panvY === 'number') renderer.panvY = 0;
    if (typeof renderer.changed === 'function') renderer.changed();
  }

  // ------------------------------------------------------------------ screen geometry
  //
  // Renderer units are screen pixels times a fixed factor k (1, or the device
  // pixel ratio). A graph point p is drawn at screen position
  //   rect.left + (p * scale + pan) / k.

  unitFactor(renderer, rect) {
    const dpr = window.devicePixelRatio || 1;
    if (!rect.width || !renderer.width) return 1;
    const ratio = renderer.width / rect.width;
    return Math.abs(ratio - dpr) < Math.abs(ratio - 1) ? dpr : 1;
  }

  viewRect(renderer) {
    const el = renderer.interactiveEl || renderer.containerEl;
    let r = { left: 0, top: 0, width: 0, height: 0 };
    try { if (el && el.getBoundingClientRect) r = el.getBoundingClientRect(); } catch (e) { /* ignore */ }
    const rect = { left: r.left || 0, top: r.top || 0, width: r.width || 0, height: r.height || 0 };
    rect.k = this.unitFactor(renderer, rect);
    return rect;
  }

  toScreen(renderer, p, rect) {
    return { x: rect.left + (p.x * renderer.scale + renderer.panX) / rect.k, y: rect.top + (p.y * renderer.scale + renderer.panY) / rect.k };
  }

  // Pan so graph point p is drawn at screen position s.
  placeAt(renderer, p, s, rect) {
    this.setPan(renderer, (s.x - rect.left) * rect.k - p.x * renderer.scale, (s.y - rect.top) * rect.k - p.y * renderer.scale);
  }

  // The middle of the graph area as it appears on screen right now. This uses
  // the on-screen size, which changes the moment the screen splits; the graph's
  // own recorded size only catches up a few frames later.
  screenCentre(renderer, rect) {
    const w = rect.width || renderer.width / rect.k;
    const h = rect.height || renderer.height / rect.k;
    return { x: rect.left + w / 2, y: rect.top + h / 2 };
  }

  // The glide moves the node across the screen to the middle of the graph.
  // If the graph is resized mid-glide (the screen splits to show the note, or
  // un-splits), the node keeps its position on screen at that moment and the
  // glide carries on from there to the new middle - no jump.
  startPan(renderer, nodes) {
    if (!this.pans) this.pans = new Map();
    const prev = this.pans.get(renderer);
    if (prev) window.cancelAnimationFrame(prev.frame);
    const point = () => {
      let x = 0;
      let y = 0;
      for (const n of nodes) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return null;
        x += n.x;
        y += n.y;
      }
      return { x: x / nodes.length, y: y / nodes.length };
    };
    const p0 = point();
    if (!p0 || ![renderer.scale, renderer.panX, renderer.panY, renderer.width, renderer.height].every(Number.isFinite)) return;
    const rect0 = this.viewRect(renderer);
    const pan = { frame: 0, from: this.toScreen(renderer, p0, rect0), start: now(), firstStart: now(), duration: PAN_MS, layout: null, last: null, point };
    this.pans.set(renderer, pan);
    if (!this.lastLayout.has(renderer)) this.recordLayout(renderer, rect0);
    const tick = () => {
      const p = point();
      if (!p) { this.pans.delete(renderer); return; }
      const rect = this.viewRect(renderer);
      const layout = `${renderer.width}x${renderer.height}@${rect.left},${rect.top},${rect.width}x${rect.height}`;
      if (pan.layout && pan.layout !== layout && pan.last) {
        // Resized: carry on from where the node is on screen right now.
        pan.from = pan.last;
        pan.start = now();
        pan.duration = Math.max(250, PAN_MS - (now() - pan.firstStart));
      }
      pan.layout = layout;
      const t = Math.min(1, (now() - pan.start) / pan.duration);
      const e = 1 - Math.pow(1 - t, 3); // ease out
      const end = this.screenCentre(renderer, rect);
      const s2 = { x: pan.from.x + (end.x - pan.from.x) * e, y: pan.from.y + (end.y - pan.from.y) * e };
      try { this.placeAt(renderer, p, s2, rect); } catch (err) { this.pans.delete(renderer); return; }
      pan.last = s2;
      this.recordLayout(renderer, rect);
      if (t < 1) pan.frame = window.requestAnimationFrame(tick);
      else this.pans.delete(renderer);
    };
    pan.frame = window.requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ resize steadiness
  //
  // The plugin remembers each graph view's size, pan and screen position as of
  // the last frame. When the size changes, before the frame is drawn:
  //   - during a glide, the node being glided to stays where it was on screen
  //     (the glide then carries on from there);
  //   - otherwise, everything stays where it was on screen.

  recordLayout(renderer, rect) {
    rect = rect || this.viewRect(renderer);
    const prev = this.lastLayout.get(renderer);
    // The on-screen width that goes with the graph's current size: updated
    // whenever the graph's own size changes. (Any fixed difference between the
    // two, e.g. a border, is therefore never mistaken for a resize.)
    const pairWidth = !prev || prev.w !== renderer.width || prev.h !== renderer.height ? rect.width : prev.pairWidth;
    this.lastLayout.set(renderer, { w: renderer.width, h: renderer.height, panX: renderer.panX, panY: renderer.panY, left: rect.left, top: rect.top, pairWidth });
  }

  // Returns true if it corrected a resize.
  checkResize(renderer) {
    if (![renderer.width, renderer.height, renderer.panX, renderer.panY, renderer.scale].every(Number.isFinite)) return false;
    const rect = this.viewRect(renderer);
    const last = this.lastLayout.get(renderer);
    let corrected = false;
    if (last && (renderer.width !== last.w || renderer.height !== last.h)) {
      const pan = this.pans && this.pans.get(renderer);
      try {
        if (pan) {
          const p = pan.point && pan.point();
          const s2 = pan.last || pan.from;
          if (p && s2) this.placeAt(renderer, p, s2, rect);
        } else {
          this.setPan(renderer, last.panX + (last.left - rect.left) * rect.k, last.panY + (last.top - rect.top) * rect.k);
        }
        corrected = true;
      } catch (e) { /* ignore */ }
    }
    this.recordLayout(renderer, rect);
    return corrected;
  }

  // Remember the current layout just before the plugin itself resizes the graph
  // (opening or closing the notes pane).
  snapshotViews() {
    for (const renderer of this.hooks.keys()) {
      if ([renderer.width, renderer.height, renderer.panX, renderer.panY].every(Number.isFinite)) this.recordLayout(renderer);
    }
  }

  // Backup for graph versions where the resize/draw steps can't be wrapped:
  // check over the next few frames.
  onGraphResize(renderer) {
    let frames = 0;
    const watch = () => {
      if (this.checkResize(renderer)) return;
      if (++frames < 30) window.requestAnimationFrame(watch);
    };
    watch();
  }

  stopPans() {
    if (this.centerWait) { window.cancelAnimationFrame(this.centerWait); this.centerWait = 0; }
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
    // While dragging (mouse button held), don't reveal the names of nodes passed over.
    if (id && (this.pointerHeld || (renderer && renderer.dragNode))) id = null;
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
    if (selected && (id === selected.id || this.selection.includes(id))) return hideAll();
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

  // ------------------------------------------------------------------ multi-selection
  //
  // Obsidian can only highlight one node. With several selected, each node and
  // line is drawn with a stand-in "highlighted node" chosen so Obsidian lights
  // exactly the right things:
  //   - a selected node is drawn as the highlighted node (lit, name shown);
  //   - a shared node (connected to every selected node) is drawn next to a
  //     selected node (lit), and its name is then hidden;
  //   - anything else is drawn against a selected node it isn't connected to
  //     (dimmed);
  //   - a line is lit if it joins two selected nodes, or a selected node and a
  //     shared node.

  multiState(renderer) {
    if (this.settings.mode !== 'click' || this.selection.length < 2 || !renderer) return null;
    const links = Array.isArray(renderer.links) ? renderer.links : [];
    const key = `${this.selection.join('\n')}#${links.length}`;
    const cached = this.multiCache.get(renderer);
    if (cached && cached.key === key && cached.links === links) return cached.state;

    const selectedList = this.selection.map((id) => this.lookupNode(renderer, id)).filter(Boolean);
    let state = null;
    if (selectedList.length >= 2) {
      const adj = new Map();
      const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
      for (const l of links) {
        const a = this.endNode(renderer, l.source);
        const b = this.endNode(renderer, l.target);
        if (a && b && a !== b) { add(a, b); add(b, a); }
      }
      const selected = new Set(selectedList);
      const shared = new Set();
      const first = adj.get(selectedList[0]) || new Set();
      for (const n of first) {
        if (selected.has(n)) continue;
        if (selectedList.every((sNode) => (adj.get(sNode) || new Set()).has(n))) shared.add(n);
      }
      state = { selectedList, selected, shared, adj };
    }
    this.multiCache.set(renderer, { key, links, state });
    return state;
  }

  // A selected node that `node` isn't connected to (so Obsidian dims `node`).
  dimmingStandIn(state, node, exclude) {
    for (const sNode of state.selectedList) {
      if (sNode === node || (exclude && exclude.includes(sNode))) continue;
      if (!(state.adj.get(sNode) || new Set()).has(node)) return sNode;
    }
    return state.selectedList[0];
  }

  wrapProto(obj, name, make) {
    let proto = obj && Object.getPrototypeOf(obj);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
    if (!proto || typeof proto[name] !== 'function' || this.wrappedFns.has(proto[name])) return;
    const orig = proto[name];
    const wrapped = make(orig);
    this.wrappedFns.add(wrapped);
    proto[name] = wrapped;
    this.protoRestores.push(() => { if (proto[name] === wrapped) proto[name] = orig; });
  }

  wrapMultiRender(renderer) {
    const plugin = this;
    const node0 = Array.isArray(renderer.nodes) ? renderer.nodes[0] : null;
    if (node0) {
      this.wrapProto(node0, 'render', (orig) => function () {
        const r = this.renderer;
        const state = plugin.highlightOverride ? null : plugin.multiState(r);
        if (!state) return orig.apply(this, arguments);
        const isShared = state.shared.has(this);
        plugin.highlightOverride = state.selected.has(this) ? this : (isShared ? state.selectedList[0] : plugin.dimmingStandIn(state, this));
        try {
          return orig.apply(this, arguments);
        } finally {
          plugin.highlightOverride = null;
          // Shared nodes are lit but unnamed (unless being hovered).
          if (isShared && this.text && !(plugin.forcedText && plugin.forcedText.node === this)) {
            try { this.text.alpha = 0; } catch (e) { /* ignore */ }
          }
        }
      });
    }
    const link0 = Array.isArray(renderer.links) ? renderer.links[0] : null;
    if (link0) {
      this.wrapProto(link0, 'render', (orig) => function () {
        const src = this.source;
        const r = this.renderer || (src && src.renderer) || (this.target && this.target.renderer);
        const state = plugin.highlightOverride ? null : plugin.multiState(r);
        if (!state) return orig.apply(this, arguments);
        const a = plugin.endNode(r, this.source);
        const b = plugin.endNode(r, this.target);
        const lit = (state.selected.has(a) && (state.selected.has(b) || state.shared.has(b)))
          || (state.selected.has(b) && state.shared.has(a));
        plugin.highlightOverride = lit ? (state.selected.has(a) ? a : b) : plugin.dimmingStandIn(state, null, [a, b]);
        try { return orig.apply(this, arguments); } finally { plugin.highlightOverride = null; }
      });
    }
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
    if (this.settings.mode === 'click' && this.selection.length > 1 && node && this.selection.includes(node.id)) return true;
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
  syncMarkerClass(force) {
    const on = !!this.settings.styleSelected && !this.unloading;
    const body = document.body;
    if (!body || !body.classList) return;
    if (body.classList.contains('gcs-bw-nodes') === on && !force) return;
    body.classList.toggle('gcs-bw-nodes', on);
    this.applyRingColour(on);
  }

  // The ring colour Obsidian would read right now, via a probe element.
  probeRingColour() {
    const el = document.body.createDiv({ cls: 'graph-view color-circle' });
    el.style.display = 'none';
    let colour = '';
    try { colour = getComputedStyle(el).color; } catch (e) { colour = ''; }
    el.remove();
    return colour;
  }

  // 1. Wait until the new ring colour is in effect (the plugin's stylesheet can
  //    load a moment after the plugin itself).
  // 2. Tell Obsidian styles changed, so the graph re-reads its colours.
  // 3. Check the colour each graph is actually using; reopen only graphs that
  //    still have the old one.
  applyRingColour(on) {
    const dark = document.body.classList.contains('theme-dark');
    const wantCss = dark ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
    const wantRgb = dark ? 0xffffff : 0x000000;
    const start = now();
    const attempt = () => {
      let ready;
      try { ready = on ? this.probeRingColour() === wantCss : this.probeRingColour() !== wantCss; } catch (e) { ready = true; }
      if (!ready && now() - start < 3000) { window.setTimeout(attempt, 100); return; }
      try { this.app.workspace.trigger('css-change'); } catch (e) { /* ignore */ }
      window.setTimeout(() => {
        const stale = [];
        for (const type of GRAPH_TYPES) {
          for (const leaf of this.app.workspace.getLeavesOfType(type)) {
            const c = leaf.view && leaf.view.renderer && leaf.view.renderer.colors && leaf.view.renderer.colors.circle;
            if (c && typeof c.rgb === 'number' && (c.rgb === wantRgb) !== on) stale.push(leaf);
          }
        }
        if (stale.length) this.reopenGraphViews(stale);
      }, 250);
    };
    window.setTimeout(attempt, 50);
  }

  async reopenGraphViews(leaves) {
    for (const leaf of leaves) {
      try {
        const state = leaf.getViewState();
        await leaf.setViewState({ type: 'empty', state: {} });
        await leaf.setViewState(state);
      } catch (e) {
        console.error('Intuitive Graph Navigation: could not reopen the graph view', e);
      }
    }
    if (!this.unloading) this.scan();
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
    this.scanInner();
  }

  scanInner() {
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
          // Obsidian uses this to show a note preview when Ctrl is held.
          if (!this.settings.previewOnHover) return undefined;
          return orig && orig.apply(self, args);
        });
        this.wrapCallback(renderer, hook, 'onNodeUnhover', (orig, self, args) => {
          hook.store = null;
          return orig && orig.apply(self, args);
        });
        // Correct for resizes right inside Obsidian's own resize and drawing
        // steps, so a resized frame is never drawn uncorrected.
        this.wrapCallback(renderer, hook, 'onResize', (orig, self, args) => {
          const res = orig && orig.apply(self, args);
          this.checkResize(renderer);
          return res;
        });
        this.wrapCallback(renderer, hook, 'renderCallback', (orig, self, args) => {
          this.checkResize(renderer);
          return orig && orig.apply(self, args);
        });
        this.attachCircleListeners(renderer);
        this.hookLinks(renderer);
        this.hookCircleTints(renderer);
        this.wrapMultiRender(renderer);
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
      // Opening the first note splits the screen and shrinks the graph after the
      // camera has aimed; re-aim when that happens.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => this.onGraphResize(renderer));
        ro.observe(container);
        this.register(() => ro.disconnect());
      }
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

    const mod = !!(evt && Keymap.isModEvent(evt));

    if (this.settings.mode !== 'click') {
      // Hover mode: Ctrl/Cmd-click opens a new tab beside the graph instead of on the pinned graph.
      if (mod && this.settings.openInOtherPane && this.openOutsideGraph(hook.leaf, id, true)) return;
      return callOriginal();
    }

    this.lastGraphLeaf = hook.leaf;
    const managed = this.tabsManaged() && this.isFile(id);

    if (mod) {
      // Click mode: Ctrl/Cmd-click adds to (or removes from) the selection.
      const added = this.toggleInSelection(id);
      if (managed) { this.syncTabs(hook.leaf, added ? id : null); return; }
      if (!added) return;
      if (this.settings.openInOtherPane && this.openOutsideGraph(hook.leaf, id, true)) return;
      return callOriginal();
    }

    if (this.selection.includes(id)) {
      // Already selected: keep the selection, bring its note forward, pan to it.
      if (this.settings.centerOnSelect) this.centerOn([id]);
      if (managed) { this.syncTabs(hook.leaf, id); return; }
      if (this.settings.openInOtherPane && this.openOutsideGraph(hook.leaf, id)) return;
      return callOriginal();
    }

    this.setSelected(id);
    if (managed) { this.syncTabs(hook.leaf, id); return; }
    if (this.settings.openInOtherPane && this.openOutsideGraph(hook.leaf, id)) return;
    return callOriginal();
  }

  // ------------------------------------------------------------------ reading view
  //
  // Notes opened beside the graph start in Reading view. Clicking into one
  // switches it to editing; Escape while editing switches it back.

  readingState() {
    return this.settings.openInReadingView ? { state: { mode: 'preview' } } : undefined;
  }

  inNotesPane(leaf) {
    if (!leaf) return false;
    const pane = this.notesPaneRef || this.notesPane(this.graphLeafForTabs());
    return !!pane && leaf.parent === pane;
  }

  leafContaining(el) {
    let found = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!found && leaf.view && leaf.view.containerEl && leaf.view.containerEl.contains && leaf.view.containerEl.contains(el)) found = leaf;
    });
    return found;
  }

  setLeafMode(leaf, mode) {
    const v = leaf && leaf.view;
    if (!v || typeof v.getMode !== 'function' || typeof v.setState !== 'function' || v.getMode() === mode) return Promise.resolve();
    try {
      const state = Object.assign({}, typeof v.getState === 'function' ? v.getState() : {}, { mode });
      return Promise.resolve(v.setState(state, { history: false }));
    } catch (e) {
      return Promise.resolve();
    }
  }

  // A note that just opened beside the graph goes to Reading view, unless the
  // user has clicked into it to edit.
  applyReadingView(file) {
    if (!this.settings.openInReadingView || !file) return;
    const leaf = this.app.workspace.getMostRecentLeaf && this.app.workspace.getMostRecentLeaf();
    if (!leaf || this.leafPath(leaf) !== file.path || !this.inNotesPane(leaf)) return;
    if (this.editingLeaves.get(leaf) === file.path) return;
    this.setLeafMode(leaf, 'preview');
  }

  // ------------------------------------------------------------------ file explorer and link clicks

  // The note a click on a file-explorer item or a Reading-view link refers to.
  notePathFromClick(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const nav = target.closest('.nav-file-title');
    if (nav) {
      const p = nav.getAttribute && nav.getAttribute('data-path');
      return p && this.isFile(p) ? p : null;
    }
    const link = target.closest('a.internal-link, .internal-link');
    if (link && target.closest('.markdown-reading-view, .markdown-preview-view')) {
      const href = (link.getAttribute && (link.getAttribute('data-href') || link.getAttribute('href'))) || '';
      let linkpath = href.split('#')[0].split('|')[0];
      try { linkpath = decodeURIComponent(linkpath); } catch (e) { /* keep as is */ }
      if (!linkpath) return null;
      const leaf = this.leafContaining(link);
      const source = leaf ? this.leafPath(leaf) || '' : '';
      const file = this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest(linkpath, source);
      return file && file.path ? file.path : null;
    }
    return null;
  }

  // Click mode, files in the file explorer and links in notes (Reading view)
  // follow the same rules as graph nodes:
  //   click an unselected note     -> it becomes the only selection, note shown
  //   click a selected note        -> selection kept, note brought forward, camera to it
  //   Ctrl-click an unselected note -> added to the selection, note shown
  //   Ctrl-click a selected note    -> removed from the selection, its tab closed
  onNoteClick(evt) {
    if (this.settings.mode !== 'click' || !this.tabsManaged()) return;
    if (evt.button !== undefined && evt.button !== 0) return; // left button only
    const path = this.notePathFromClick(evt.target);
    if (!path) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
    this.lastGetLeaf = null;
    if (Keymap.isModEvent(evt)) {
      if (this.selection.length === 1 && this.selection[0] === path) {
        // Deselecting the last selected note: exactly the same as Escape.
        this.clearSelection();
        return;
      }
      const added = this.toggleInSelection(path);
      this.syncTabs(null, added ? path : null);
    } else if (this.selection.includes(path)) {
      if (this.settings.centerOnSelect) this.centerOn([path]);
      this.syncTabs(null, path);
    } else {
      this.setSelected(path);
      this.syncTabs(null, path);
    }
  }

  // ------------------------------------------------------------------ workspace routing
  //
  // Two small, reversible wrappers on Obsidian's workspace:
  //   - getLeaf: when the graph tab is active, Obsidian would open notes (from
  //     the file explorer, quick switcher, etc.) inside the graph's tab group,
  //     covering the graph. They're sent to the notes pane instead. Whether the
  //     open was a Ctrl/Cmd-click (new tab) is also noted for the selection.
  //   - trigger: note previews ('hover-link') from graph nodes and the file
  //     explorer are dropped unless "Note previews on hover" is on.

  patchWorkspace() {
    const ws = this.app.workspace;
    const plugin = this;
    this.wsRestores = this.wsRestores || [];
    const wrap = (name, make) => {
      const orig = ws[name];
      if (typeof orig !== 'function') return;
      const wrapped = make(orig);
      ws[name] = wrapped;
      this.wsRestores.push(() => { if (ws[name] === wrapped) ws[name] = orig; });
    };
    wrap('getLeaf', (orig) => function (newLeaf) {
      plugin.lastGetLeaf = { mode: newLeaf, time: now() };
      if (!plugin.redirecting) {
        const leaf = plugin.redirectLeaf(newLeaf);
        if (leaf) return leaf;
      }
      return orig.apply(this, arguments);
    });
    wrap('trigger', (orig) => function (name, info) {
      if (name === 'hover-link' && !plugin.settings.previewOnHover && info) {
        const parentType = info.hoverParent && info.hoverParent.getViewType ? info.hoverParent.getViewType() : '';
        const src = info.source || '';
        if (src === 'file-explorer' || src === 'graph' || src === 'localgraph' || parentType === 'file-explorer' || GRAPH_TYPES.includes(parentType)) return undefined;
      }
      return orig.apply(this, arguments);
    });
  }

  // If the active tab is a graph (or shares its tab group), return a leaf in the
  // notes pane to open into instead; otherwise null (Obsidian decides).
  redirectLeaf(newLeaf) {
    if (!this.settings.openInOtherPane || this.unloading) return null;
    if (newLeaf === 'split' || newLeaf === 'window') return null;
    const ws = this.app.workspace;
    const active = ws.getMostRecentLeaf && ws.getMostRecentLeaf();
    if (!active || !active.getRoot || active.getRoot() !== ws.rootSplit) return null;
    let graphLeaf = null;
    for (const g of ws.getLeavesOfType('graph')) if (g === active || g.parent === active.parent) graphLeaf = g;
    if (!graphLeaf) return null;
    this.redirecting = true;
    try {
      let pane = this.notesPane(graphLeaf);
      if (!pane) {
        this.snapshotViews();
        const leaf = ws.createLeafBySplit(graphLeaf, 'vertical');
        this.notesPaneRef = leaf.parent;
        return leaf;
      }
      const leaves = (Array.isArray(pane.children) ? pane.children : []).filter((l) => l && l.view);
      if (!newLeaf) {
        const reuse = leaves.find((l) => l === ws.getMostRecentLeaf() && !this.isPinnedLeaf(l)) || leaves.find((l) => !this.isPinnedLeaf(l));
        if (reuse) return reuse;
      }
      if (typeof ws.createLeafInParent === 'function') return ws.createLeafInParent(pane, Array.isArray(pane.children) ? pane.children.length : 0);
      return null;
    } catch (e) {
      return null;
    } finally {
      this.redirecting = false;
    }
  }

  // ------------------------------------------------------------------ tabs follow selection
  //
  // In Click mode the notes pane (the tab group where clicked notes open) holds
  // exactly the selected notes: selecting opens a tab (reusing a spare one),
  // deselecting closes it. Pinned tabs and non-note views are never touched,
  // and only the notes pane is managed.

  tabsManaged() {
    return this.settings.mode === 'click' && this.settings.tabsFollowSelection && this.settings.openInOtherPane;
  }

  isFile(path) {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  leafPath(leaf) {
    const f = leaf && leaf.view && leaf.view.file;
    return f && f.path ? f.path : null;
  }

  isPinnedLeaf(leaf) {
    try { return !!leaf.getViewState().pinned; } catch (e) { return false; }
  }

  graphLeafForTabs(graphLeaf) {
    if (graphLeaf) return graphLeaf;
    if (this.lastGraphLeaf && this.lastGraphLeaf.view) return this.lastGraphLeaf;
    const leaves = this.app.workspace.getLeavesOfType('graph');
    return leaves && leaves[0] ? leaves[0] : null;
  }

  // The tab group a normal click would open notes in, or null.
  notesPane(graphLeaf) {
    const ws = this.app.workspace;
    const isGraph = (leaf) => leaf && leaf.view && GRAPH_TYPES.includes(leaf.view.getViewType());
    const usable = (leaf) => leaf && !isGraph(leaf) && (!graphLeaf || leaf.parent !== graphLeaf.parent) && leaf.getRoot && leaf.getRoot() === ws.rootSplit;
    let target = null;
    if (this.notesPaneRef && Array.isArray(this.notesPaneRef.children) && this.notesPaneRef.children.some((l) => usable(l))) {
      return this.notesPaneRef;
    }
    const recent = ws.getMostRecentLeaf && ws.getMostRecentLeaf();
    if (usable(recent)) target = recent;
    if (!target) ws.iterateRootLeaves((leaf) => { if (!target && usable(leaf)) target = leaf; });
    this.notesPaneRef = target ? target.parent : null;
    return this.notesPaneRef;
  }

  openPathsAnywhere() {
    return new Set(this.leavesByPath().keys());
  }

  leavesByPath() {
    const out = new Map();
    this.app.workspace.iterateRootLeaves((leaf) => { const p = this.leafPath(leaf); if (p && !out.has(p)) out.set(p, leaf); });
    return out;
  }

  markPending(path) {
    if (!this.pending) this.pending = new Map();
    this.pending.set(path, now());
  }

  isPending(path) {
    const t = this.pending && this.pending.get(path);
    return t != null && now() - t < 1500;
  }

  syncTabs(graphLeaf, focusId) {
    const ws = this.app.workspace;
    this.snapshotViews();
    graphLeaf = this.graphLeafForTabs(graphLeaf);
    const want = this.selection.filter((id) => this.isFile(id));
    let pane = this.notesPane(graphLeaf);
    let fresh = null;
    if (!pane) {
      if (!want.length || !graphLeaf || graphLeaf.getRoot() !== ws.rootSplit) return;
      fresh = ws.createLeafBySplit(graphLeaf, 'vertical');
      pane = fresh.parent;
      this.notesPaneRef = pane;
    }
    const leaves = (Array.isArray(pane.children) ? pane.children : []).filter((l) => l && l.view);
    const kept = new Map();
    const spare = [];
    for (const leaf of leaves) {
      const p = this.leafPath(leaf);
      if (this.isPinnedLeaf(leaf)) { if (p) kept.set(p, leaf); continue; }
      if (p && want.includes(p) && !kept.has(p)) { kept.set(p, leaf); continue; }
      const type = leaf.view.getViewType && leaf.view.getViewType();
      if (p || type === 'empty') spare.push(leaf);
    }
    const elsewhere = this.leavesByPath();
    for (const id of want) {
      if (kept.has(id)) continue;
      const other = elsewhere.get(id);
      if (other && other.parent !== pane) { kept.set(id, other); continue; } // already open in another pane
      let leaf = spare.shift() || null;
      if (!leaf) {
        try {
          if (typeof ws.createLeafInParent === 'function') leaf = ws.createLeafInParent(pane, Array.isArray(pane.children) ? pane.children.length : 0);
        } catch (e) { leaf = null; }
      }
      if (!leaf) continue;
      const file = this.app.vault.getAbstractFileByPath(id);
      this.markPending(id);
      try { leaf.openFile(file, this.readingState()); } catch (e) { /* ignore */ }
      kept.set(id, leaf);
    }
    for (const leaf of spare) { try { leaf.detach(); } catch (e) { /* ignore */ } }
    const focusLeaf = focusId && kept.get(focusId);
    if (focusLeaf) { try { ws.setActiveLeaf(focusLeaf, { focus: false }); } catch (e) { /* ignore */ } }
  }

  // A selected note whose tab has been closed is deselected.
  checkClosedTabs() {
    if (!this.tabsManaged() || !this.selection.length) return;
    const open = this.openPathsAnywhere();
    const gone = this.selection.filter((id) => this.isFile(id) && !open.has(id) && !this.isPending(id));
    if (!gone.length) return;
    this.selection = this.selection.filter((id) => !gone.includes(id));
    this.selectedId = this.selection[0] || null;
    if (!this.selectedId) { this.stopPans(); for (const hook of this.hooks.values()) hook.store = null; }
    this.refreshIndicators();
    this.redrawAll();
    if (this.selection.length && this.settings.centerOnSelect) this.centerOn(this.selection);
  }

  openOutsideGraph(graphLeaf, path, newTab) {
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
      this.snapshotViews();
      target = ws.createLeafBySplit(graphLeaf, 'vertical');
    } else if (newTab) {
      // A new tab in the same pane that a normal click would use.
      let leaf = null;
      try {
        if (typeof ws.createLeafInParent === 'function' && target.parent) {
          const kids = Array.isArray(target.parent.children) ? target.parent.children.length : 0;
          leaf = ws.createLeafInParent(target.parent, kids);
        }
      } catch (e) { leaf = null; }
      if (!leaf) {
        try { ws.setActiveLeaf(target, { focus: false }); this.redirecting = true; leaf = ws.getLeaf('tab'); } catch (e) { leaf = null; } finally { this.redirecting = false; this.lastGetLeaf = null; }
      }
      if (leaf) target = leaf;
    }
    target.openFile(file, this.readingState());
    return true;
  }

  // ------------------------------------------------------------------ diagnostics

  copyDiagnostics() {
    const lines = [`Obsidian ${window.electron ? 'desktop' : ''} | apiVersion ${require('obsidian').apiVersion || '?'}`,
      `mode=${this.settings.mode} selected=${this.selectedId} selection=${this.selection.length} hovered=${this.hoverId} tabsManaged=${this.tabsManaged()} notesPane=${this.notesPaneRef ? (this.notesPaneRef.children || []).length + ' tabs' : 'none'}`,
      `hover signals seen: ${JSON.stringify(this.signals)}`,
      `plugin folder: ${this.manifest && this.manifest.dir} | id: ${this.manifest && this.manifest.id} | errors: ${(this.loadErrors || []).join(' ; ') || 'none'}`,
      `this startup: ${JSON.stringify(this.startupLog || null)}`,
      `previous startup: ${JSON.stringify(this.previousStartupLog || null)}`];
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
          lines.push(`link: ${ks(link)} | render=${typeof link.render} | hooked line objects=${this.tintHooks.size}`);
          const ms = this.multiState(renderer);
          if (ms) lines.push(`multi: selected=${ms.selectedList.length} shared=${ms.shared.size}`);
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
        .onChange(async (v) => { s.mode = v; if (v === 'hover') { this.plugin.selectedId = null; this.plugin.selection = []; } await this.plugin.saveSettings(); }));

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
      .setName('Tabs follow selection')
      .setDesc('In Click mode, the notes pane beside the graph holds exactly the selected notes: selecting opens a tab, deselecting closes it, and Escape closes them all. Closing a note\'s tab deselects it. Pinned tabs are left alone.')
      .addToggle((t) => t.setValue(s.tabsFollowSelection).onChange(async (v) => { s.tabsFollowSelection = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Open notes in Reading view')
      .setDesc('Notes opened beside the graph start in Reading view. Click into a note to edit it; press Escape to return to Reading view.')
      .addToggle((t) => t.setValue(s.openInReadingView).onChange(async (v) => { s.openInReadingView = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Note previews on hover')
      .setDesc('Let Obsidian show a note preview when you hover a graph node or a file in the file explorer with Ctrl/Cmd held. Off by default, since Ctrl/Cmd is used for selecting several notes.')
      .addToggle((t) => t.setValue(s.previewOnHover).onChange(async (v) => { s.previewOnHover = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Open notes beside the graph')
      .setDesc('Clicked notes open in another pane (splitting the graph tab if needed) so the graph stays visible.')
      .addToggle((t) => t.setValue(s.openInOtherPane).onChange(async (v) => { s.openInOtherPane = v; await this.plugin.saveSettings(); }));
  }
}
