# Design: Mobile layout

_Status: proposed · Size: L · Depends on: Accounts (the import flow it lays out) — can
start before it_

## Summary

Make the dashboard usable on a phone. It's a static page with Plotly and Leaflet, so
this is mostly CSS and a few interaction changes, but the runs table, map sidebar, draw
tool and run detail modal all assume a wide pointer-driven screen and need real redesign
rather than reflow.

## Goals

- Every tab is usable at 390 px wide with no horizontal page scroll.
- Charts stay readable and don't hijack scrolling.
- The import flow works from a phone's Files app (Strava emails the export link; people
  will open it on their phone).

## Non-goals

- Offline/PWA install. (Cheap to add later: a manifest and a cache-first service worker
  for `web/`.)
- Redesigning the desktop layout.

## Current state

`styles.css` has three narrow breakpoints (860, 720, 640 px) that only tweak a few
grids. Header is a single flex row with four tabs and two buttons; the runs table has
nine columns; the map has a fixed side panel; the modal is a centred box with an
80-vh scroll; `.info` tooltips are hover-only.

## Breakpoints

- `≤ 720 px`: phone layout (everything below).
- `721–1024 px`: tablet, mostly the desktop layout with the map sidebar collapsed.

## Changes by area

### Header and navigation
- Tabs move to a fixed bottom bar with icon + label (Overview, Progress, Runs, Map,
  Goal when present). Header keeps the brand, theme toggle, and an overflow menu holding
  Import, Settings, Sign in.
- `env(safe-area-inset-bottom)` padding on the bar.

### Overview
- `stat-grid` → two columns. The `countUp` animation is fine.
- Mileage chart height 220 px; Plotly `config.scrollZoom = false`, `dragmode = false`
  on touch devices (detected once via `matchMedia("(pointer: coarse)")`) so the page
  scrolls instead of the chart panning.
- Calendar: each year block scrolls horizontally inside its own container, latest month
  in view on load (`scrollLeft = scrollWidth`). Cells stay clickable; add a `title`-less
  tap that opens the run directly.
- Photo strip already scrolls horizontally.

### Progression
- Timeframe bar wraps to two rows; the date inputs stack.
- Charts 240 px tall; legends move to the top (`legend.orientation = "h"`).
- The "When you run" dual chart stacks vertically.
- `.info` tooltips become tap-to-toggle (add `aria-expanded`, close on outside tap).

### Runs
- Under 720 px the table becomes a card list: line 1 date · type pill · name; line 2
  miles · pace · HR · elev. Sorting moves to a select in the toolbar; search stays.
- Implementation: `drawRows` renders both markups from the same sorted array and CSS
  picks one (`display: none` on the other), so there's one data path.
- Virtualization is unnecessary at a few hundred runs; at a few thousand, cap the initial
  render at 200 and add "show more".

### Map
- Sidebar becomes a bottom sheet with a drag handle: peek state shows the region chips;
  expanded shows the segment tool and overlays. Sheet is a plain `position: fixed` div
  with a `transform` toggle; no library.
- Draw tool: Leaflet's touch drag must be disabled while drawing (`map.dragging.disable()`)
  and the painter must listen to `touchmove` with `preventDefault`. Brush width default
  bumps to 40 m on touch (fat fingers).
- The segment results panel opens as a second sheet over the first.
- Tiles: keep Carto; retina `{r}` already in the URL.

### Run detail and compare
- Modal becomes a full-screen sheet on phones: slides up, sticky close button,
  `overscroll-behavior: contain` so the page behind doesn't scroll.
- Detail stats grid → 4 columns of 2 rows. Charts 160 px. The splits table is already narrow.
- Detail map 220 px tall, `dragging` disabled until tapped (the "tap to interact" pattern)
  so vertical scrolling over the map doesn't pan it.

### Import
- Drop zone becomes a big "Choose export zip" button; drag-and-drop is irrelevant on
  phones. `accept=".zip"`.
- Progress with a percentage and elapsed time. FIT parsing of 200+ files on a phone is
  slow (estimate 2–4× a laptop); keep the worker, and add a "keep the screen on" hint
  since backgrounding the tab pauses the worker on iOS.
- Memory: a 100 MB export unzipped in memory plus parsed streams can exceed what mobile
  Safari allows a tab. Mitigation: unzip lazily per file (fflate supports streaming
  `Unzip`) instead of `unzipSync` of the whole archive, and release each track's bytes
  after parsing. This is the one non-CSS engineering item in this design and should be
  done first because it also helps desktop.

## Testing

- Playwright device profiles (iPhone 13, Pixel 7) against `?sample`: each tab renders
  with no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`),
  bottom bar visible, run card tap opens the sheet, map sheet expands.
- Manual on a real iPhone: import a real export (memory), draw a segment (touch).

## Open questions

- Bottom tab bar vs. a hamburger. Proposed: bottom bar; four or five destinations is
  exactly what it's for.
- Should the draw tool exist on phones at all? Proposed: yes but not in the peek state;
  it's a power feature.
