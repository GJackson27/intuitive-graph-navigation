# Intuitive Graph Navigation

Make Obsidian's graph view easier to explore. Click a node and it stays highlighted with its connections until you press Escape, instead of the highlight disappearing as soon as your mouse moves.

## Features

- **Click mode.** Clicking a node opens its note beside the graph and keeps the node and its connections highlighted until you press **Escape** or click another node.
- **Select several nodes.** Ctrl-click (Cmd-click on Mac) adds nodes to the selection. Only the selected nodes, the nodes they all share, and the connections between them stay lit, so you can see what notes have in common.
- **Tabs follow your selection.** In Click mode, the notes pane beside the graph holds exactly the selected notes. Selecting opens a tab, deselecting closes it, and closing a tab deselects its node.
- **Follows your notes.** Opening a note from the file explorer, a link or the quick switcher selects its node in the graph, as if you had clicked it. With the graph active, notes opened from the file explorer go beside the graph instead of covering it, and Ctrl/Cmd-clicking files there adds them to the selection.
- **Reading view first.** Notes opened beside the graph start in Reading view. Click into a note to edit it, and press Escape to go back to Reading view.
- **Hover labels.** While a node is selected, hovering any other node shows its name exactly as it would look if clicked, and the label follows the node as the graph moves. Names aren't revealed while you're dragging.
- **Coloured connections.** Lines from the highlighted node take the colour of the node at the other end, so you can see at a glance which groups it connects to. Lines blend smoothly back to the default colour when deselected.
- **Group colour first.** Nodes in a colour group keep their group colour when they are highlighted or open, instead of switching to the accent colour.
- **Clear open-note ring.** The ring Obsidian draws around the open note's node is black in light mode and white in dark mode.
- **Camera follows.** Selecting a node glides the graph so the node moves to the centre of the view. When the notes pane opens or closes, the graph stays steady on screen; if the pane is opening, the glide waits until it has appeared.
- **Pinned graph.** Graph tabs are kept pinned so opening notes never replaces your graph.

Everything works in both the global graph and local graphs, and each feature can be turned off in settings.

## Using it

Switch between **Click mode** and **Hover mode** (Obsidian's normal behaviour) using any of these:

- the mode label in the status bar (**Graph: Click mode** / **Graph: Hover mode**),
- the ribbon icon,
- the command **Toggle hover / click mode** (you can assign it a hotkey in **Settings → Hotkeys**).

In Click mode, graph nodes, files in the file explorer and links in notes (in Reading view) all work the same way:

| Action | Result |
| --- | --- |
| Click something not selected | It becomes the only selection, its note opens beside the graph, and the camera glides to it |
| Click something already selected | The selection is kept, its note is brought forward, and the camera glides to it |
| Ctrl/Cmd-click something not selected | It's added to the selection and its note opens in a new tab beside the graph |
| Ctrl/Cmd-click something already selected | It's removed from the selection and its tab closes |
| Hover a node | Shows its label without changing the selection (not while dragging) |
| Escape | While editing a note: returns it to Reading view. Otherwise: closes the selected notes' tabs and clears the selection |

With several nodes selected, the selected nodes show their names and are lit, along with any nodes connected to all of them (shown without names) and the connections between them. Everything else is dimmed, and the camera glides to the centre of the selection. A normal click on an unselected node, or opening a note that isn't selected, returns to a single selection. Escape, or closing all the selected notes' tabs, clears it.

In Hover mode, Ctrl/Cmd-click opens the note in a new tab beside the graph instead of on the pinned graph tab.

The command **Clear graph selection** also clears the selection.

### Tip: colour groups

Coloured connections and group colours are most useful with colour groups set up. In graph view, open the settings (gear icon) → **Groups** → **New group**, and give each group a query (for example `tag:#person` or `path:Projects`) and a colour.

## Settings

| Setting | What it does |
| --- | --- |
| Mode | Click mode or Hover mode. |
| Keep graph tabs pinned | Pins every global graph tab so opening notes never replaces it. |
| Select the open note | Opening a note selects its node, as if you had clicked it. |
| Hover highlight when nothing is selected | In Click mode, hovering still highlights connections while nothing is selected. |
| Hover name style | Show hovered names as the graph's own label, or as a tooltip by the cursor. |
| Black and white open-note ring | Black ring in light mode, white in dark mode, instead of the accent colour. |
| Group colour first | Grouped nodes keep their group colour when highlighted or open. |
| Colour connections by node | Lines from the highlighted node take the colour of the node at the other end. |
| Centre on selected node | In Click mode, the graph glides so the selected node moves to the centre. |
| Tabs follow selection | In Click mode, the notes pane holds exactly the selected notes. Pinned tabs and other panes are left alone. |
| Open notes in Reading view | Notes opened beside the graph start in Reading view; click in to edit, Escape to return. |
| Note previews on hover | Allow Obsidian's note preview when hovering a graph node or a file in the file explorer with Ctrl/Cmd held. Off by default, since Ctrl/Cmd selects several notes. |
| Open notes beside the graph | Clicked notes open in another pane so the graph stays visible. |

## Compatibility

Obsidian doesn't offer an official API for customising the graph view, so this plugin works with the graph view's internal code. That code can change in any Obsidian update, which could stop some features working until the plugin is updated.

The plugin is written to fail safely: if something it expects isn't there, that feature simply does nothing, and disabling the plugin always restores Obsidian's normal graph.

To keep the graph visible and your selection in step, the plugin also adjusts how Obsidian chooses a tab when a note opens while the graph is active, and stops note previews from graph nodes and the file explorer (see **Note previews on hover**). Both changes are undone when the plugin is turned off.

If something stops working, please [open an issue](../../issues) and include the output of the command **Copy diagnostics (for troubleshooting)**: with the graph open, select a node, run the command, and paste what it copies. It describes the graph view's internals so the problem can be fixed quickly. It contains no note content beyond the names of the selected and hovered notes.

## Privacy

- The plugin makes no network requests and collects nothing.
- It writes to the clipboard only when you run **Copy diagnostics**, and never reads from it.
- It keeps a small startup log (timings and any errors, no note content) in its own settings file, `.obsidian/plugins/intuitive-graph-navigation/data.json`, so that diagnostics can show what happened at startup.

## Installing

**From Obsidian:** open **Settings → Community plugins → Browse**, search for **Intuitive Graph Navigation**, then install and enable it.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<your vault>/.obsidian/plugins/intuitive-graph-navigation/`, then enable the plugin in **Settings → Community plugins**.

## License

[MIT](LICENSE) © 2026 Gregory Jackson
