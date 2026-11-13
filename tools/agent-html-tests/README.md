# agent.html browser checks

Headless Chromium (Playwright) runs against a mock NativeKit; no network, no AI provider.

- `mock3.js` — the old NativeKit surface; `mock-v2.js` adds the engine v2 APIs.
- `ui2.js` — layout and controls; `feat.js` — feature checks; `v2.js` — engine v2 paths
  (rewind/fork, approval with edited args, images, UI tools, MCP Apps, HTML widget, old-engine fallback);
  `render.js` — a long mixed reply (Markdown, table, code, KaTeX, Mermaid) while streaming;
  `r3.js` — welcome screen and its Settings editor, follow-up suggestion chips, the sandboxed `html-widget`
  (CSP, auto size, dark mode, postMessage back, tap-only sends, canvas, code view, error fallback), link previews,
  image gallery + zoom, step progress, tool-result extras, image attach (picker/paste/drop) and the old-engine
  note, every Mermaid diagram type in light and dark with the wide-diagram scroll and the error fallback, and the
  widgets & suggestions guide. Runs 320/360/390 px phones and 1280 px desktop, light and dark, and fails on any
  console error or network request (`SIZES`, `DARK=0|1`, `ONLY=welcome,mermaid`, `SHOT=1` for screenshots).

- `subagents.js` with `mock-subagents.js` (a stateful fake of the engine's sub-agent manager) — the inline
  sub-agent card, approval labels, the Agents screen (list, detail, memory, presets, limits), the live tree and
  delegation diagrams; feature/method missing, NativeKit rejections, late and out-of-order events, rapid taps,
  hostile names, 200 sub-agents, reload persistence, keyboard, and layout at 320/360/390/1280 light and dark.

Module sources for newer features live in `tools/agent-html-src/` (`NN-name.js` + `.css`); run
`python3 tools/agent-html-src/build.py` to splice them into `www/agent.html` between `@@BEGIN/@@END` markers.

The scripts load Playwright from `/tmp/pw/node_modules` and a Chromium path set in each file; adjust both
for your machine, then run e.g. `URL_=file://$PWD/www/agent.html SIZES=390x844m node tools/agent-html-tests/v2.js`.
