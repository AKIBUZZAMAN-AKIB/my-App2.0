# agent.html browser checks

Headless Chromium (Playwright) runs against a mock NativeKit; no network, no AI provider.

- `mock3.js` — the old NativeKit surface; `mock-v2.js` adds the engine v2 APIs.
- `ui2.js` — layout and controls; `feat.js` — feature checks; `v2.js` — engine v2 paths
  (rewind/fork, approval with edited args, images, UI tools, MCP Apps, HTML widget, old-engine fallback);
  `render.js` — a long mixed reply (Markdown, table, code, KaTeX, Mermaid) while streaming.

The scripts load Playwright from `/tmp/pw/node_modules` and a Chromium path set in each file; adjust both
for your machine, then run e.g. `URL_=file://$PWD/www/agent.html SIZES=390x844m node tools/agent-html-tests/v2.js`.
