# Opened sub-agent: one navigation

## Problem (before)

Opening a sub-agent stacked three navigation rows on top of each other:

1. the Agents-level tabs (Agents, Explorer, Diagram, Presets, Settings),
2. a row of "open agent" tabs (one per agent opened, with close buttons),
3. the agent's own scrolling pill row (Overview, Chat, Activity, Team, Graph, Goals, Tools, Context, Memory, Settings),

then a block of seven action buttons, then the agent's name. At 390 px the pill row scrolled sideways and the
actions wrapped into two lines. There was no clear "you are here", and the hierarchy (which agent started this one) was
only in the body.

## What professional apps do

| App / system | Child item opened from a list | Sections of the child |
|---|---|---|
| GitHub Primer `PageHeader` | `ParentLink` / `Breadcrumbs` above the title; title area with leading visual (icon) and trailing visual (status label); `Actions` slot on the right; `Description` for short facts | `PageHeader.Navigation` holds one `UnderlineNav` |
| Primer `UnderlineNav` guidelines | — | One row; items that do not fit go into a "More" menu; the selected item is never hidden; do not stack two UnderlineNavs, use a `NavList` (vertical) for a higher level |
| Primer `Breadcrumbs` | Shows ancestry, links to each level, `aria-current="page"` on the last; overflow can collapse middle items into a menu | — |
| GitHub Actions run / job | Breadcrumb (workflow › run), status icon + title, Re-run / ⋯ menu on the right | Jobs in a left side list on wide screens |
| Linear issue view | Breadcrumb (team › parent issue › issue), properties in a right column | Activity in the main column; no second tab row |
| Vercel deployment | Breadcrumb (project › deployment), status chip, primary action + ⋯ | One underline tab row (Deployment, Logs, Resources, Source) |
| LangSmith run view | Trace tree on the left, the selected run's header (name, status, latency, tokens) | One tab row (Run, Feedback, Metadata) |
| VS Code panels | — | One tab strip per panel; overflow goes into a "⋯" menu |

Common pattern: **the parent level becomes a breadcrumb in a page header, and the child's sections get exactly one
navigation — a vertical side nav on wide layouts and a single underline row with a More menu on narrow ones.** Secondary
actions go into one ⋯ menu; one or two primary actions stay visible.

## New model (after)

- **Header** (`AgentTabs.header`): breadcrumb `‹ All agents › parent › …` (ancestors collapse to `first › … › parent`
  past two levels), then the agent's avatar (status-coloured, spinning while running), name as the page heading, a
  switcher (`⇕`) that jumps to another agent without going back, the status chip, the title, and a one-line facts row
  (tokens / budget · steps · tool calls · model).
- **Actions**: Stop while running, else Try again; Open as chat; everything else (Run again…, Save as preset, Attach
  result, Delete data…) in one ⋯ menu.
- **One navigation** (`AgentTabs.nav` + `AgentTabs.layout`): the layout measures its own width (works the same in the
  docked panel, the dialog and on a phone). ≥ 720 px: a grouped vertical nav (Agent: Overview, Chat, Activity, Team,
  Graph, Goals · Configure: Tools, Context, Memory, Settings) beside the content. Narrower: one underline row; what does
  not fit goes into **More**, and the selected section always stays in the row. No horizontal scrolling.
- **The Agents-level tabs and the old open-agent tab row are hidden while an agent is open**; Back / the breadcrumb
  brings them back. The panel's description line is hidden too (the header says it).
- **Overview** is a two-column page on wide layouts (task, report, chat on the left; usage, "where it sits", files on the
  right) and one column on narrow ones. Settings also holds the spawn setup; Memory also lists the saved entries, so
  nothing that used to be in the long single page is lost.
- **Accessibility**: `nav[aria-label=Breadcrumb]` with `aria-current=page`; one `role=tablist` with roving tabindex,
  arrow keys / Home / End (vertical in side mode); focus moves to the agent's heading on open and stays on the same
  control across live refreshes; refreshes wait while a menu from the header is open.

## Second pass: one-line header, read-only Overview, long-press select

### What was still wrong

- The header took three lines: name + status, then a row of large Stop / Open as chat / ⋯ buttons, then a facts line
  with usage, which Overview showed again.
- Overview repeated the whole Chat tab: the thread, a steer box, Send, a second Stop and **Pick parts**.
- Two different buttons were called **Stop**: the header's stopped the agent, the composer's (meant as "stop this
  step") did the same thing, because the engine had no interrupt.
- "Pick parts" was a separate mode with checkboxes on paragraphs; no chat app works that way.
- Several engine controls had no UI at all (pause/resume, stop with the agents below, title, export, select).

### Research

| Source | What it says | Used for |
|---|---|---|
| Primer `PageHeader` | Title area = leading visual + title + trailing visual (status `Label`) on one line; `Actions` (icon buttons) on the same line, right-aligned; leading/trailing actions hide on narrow viewports | One-line header, status beside the name, icon-only buttons < 560 px |
| Material 3 top app bar | Navigation left, title, then action icons, overflow menu far right; most-used action first | Order: primary action, Open as chat, ⋯ |
| Material contextual action bar (M2/M3 selection) | Long-press enters selection; the count replaces the title; a close (X) leads; actions trail | The selection bar |
| Apple HIG, lists / edit mode | Real checkboxes in selection mode, "Select All", toolbar actions for the selected rows; Shift / Cmd-click on Mac | Checkboxes, Select all, Shift-click range, Cmd/Ctrl-click |
| Telegram (desktop + mobile) | Long-press (or right-click → Select) starts selection, each tap adds, Shift-click selects a range, Esc clears; Copy / Forward / Delete | Same gestures; Copy / Quote / Send to main chat |
| WhatsApp, iMessage | Long-press a bubble → select; bar with the count; the composer gives way to the action bar | Composer hides while selecting |
| Claude Code / Cursor agents | Esc interrupts the current step and keeps the work; a new message steers; Stop ends the session | Interrupt (Esc) in the chat vs Stop in the header |
| Linear issue ⋯ menu, GitHub kebab | One menu, grouped by headings, destructive items last and red | The grouped ⋯ menu |

### What it is now

- **Header, one line** (`AgentTabs.header`, `AgentTabs.action`): `[avatar] name [⇕] [Running] ……… [■ Stop] [⤢ Open as chat] [⋯]`.
  The line never wraps: the name truncates first; below 560 px the buttons drop their labels and stay 32 px icon buttons
  with `aria-label` and a tooltip. While it runs the primary is **Stop**; when paused, **Resume**; when it has ended,
  **Try again**. The facts line is gone: usage lives only in Overview's Usage card. The breadcrumb stays as a small line
  above. "Open as chat" gets the same one-line header (back, name, status, Stop, ⋯), and the path line only when nested.
- **Overview is read-only**: a **Last message** card (what you asked last, its latest reply, clamped, "Working · step N"
  while it runs). No composer, no Send, no Stop, no Pick parts. Tapping the card or "Open chat" goes to the Chat tab.
- **Chat tab**: the thread and the composer. The composer's button is now **Interrupt** (Esc in the box): it stops only
  the current step, keeps the work, and the next message goes on. A queued agent shows **Cancel** instead.
- **Multi-select** (`09-msg-select.js`, used by the Chat tab and "Open as chat"): long-press (450 ms, cancelled by 8 px
  of movement) a message to select it; then a tap toggles, Shift-click selects a range, Ctrl/Cmd-click starts on
  desktop, Space toggles the focused message, Shift+↑/↓ extends, Ctrl/Cmd+A selects all, Esc or X leaves. A checkbox per
  message, a live region announces the count, and the composer gives way to a bar: X · "N selected" · Select all ·
  Copy · Quote · Send to parent (when it has one) · Send to main chat. Several messages are joined with who said each.
  The bar's labels drop to icons below 560 px. ⋯ → Select messages starts it without a long-press.
- **Every control has one place** (header ⋯, grouped):
  - Run: Interrupt, Pause / Resume, Stop it and the agents below, Try again, Run again…, Queue priority.
  - Chat: Open as chat, Select messages, Copy last reply, Attach result, Export chat (Markdown).
  - Agent: Edit title… (its name, the address agents use, stays), Model and limits, Tools and permissions, Context and
    compaction, Memory, Swarm role and rules, Move or message, Save as preset, Copy agent id.
  - Delete data… (red, last).
  Steer, edit and resend, regenerate and versions stay in the chat where they act.
- **Engine**: new `interrupt` action. It stops the current run like Stop, but `finish()` records it as stopped with the
  note "Interrupted. Send a message to go on." and still starts a message that waited for it (Stop drops those). A queued
  agent is not touched. The UI falls back to `stop` on an engine without it.

## Checks

`agent-view.js` (each width 390 / 768 / 1280): exactly one visible tablist and the Agents tabs hidden; breadcrumb, name,
status above the nav; sections in one row (bar) or one column (side), no sideways scroll, selected visible; at 390 the
rest go into More and a section picked from More becomes selected and visible; Back restores the list and the Agents
tabs; the switcher opens another agent. `subagent-graph-fixes.js`: the breadcrumb lists the ancestry and a parent crumb
opens that agent.

`subagent-view.js` (second pass; 320 / 390 / 1280 px, light and dark, 6 runs): the header's name, status, Stop, Open as
chat and ⋯ sit on one line (centres within 4 px, row ≤ 44 px), never overlap and stay on screen; 32 px buttons with an
aria-label and a tooltip, icon-only when narrow and labelled when wide; no usage in the header; one row of sections.
Overview: a read-only Last message (prompt + reply), no composer / Send / Steer / Stop / Interrupt / thread, no Pick
parts, a tap opens Chat. Exactly one button is called Stop; the composer's Interrupt sends `interrupt`, not `stop`.
Multi-select: mouse long-press, a tap adds, Shift-click range, touch long-press without the system menu, Copy (joined
with who said each), Quote into the composer, Send to main chat, Space / Shift+↑ / Ctrl+A / Esc, a live region, one Tab
stop; the composer gives way to the bar and comes back. The ⋯ menu lists every control (18 for a running agent), grouped
and on screen; Pause / Resume / Edit title / Export / Model and limits / Select messages / Stop it and the agents below
each do what they say. "Open as chat": a one-line header, long-press select and Esc there; the main chat gets no
checkboxes. `s1.js` covers the old Pick parts cases with the new selection (whole replies as Markdown, a hand-made text
selection, Send to the parent sub-agent). Rust: `interrupt_stops_the_step_and_a_message_goes_on`.
Screenshots: `shots-subagent-view.js` (390 and 1280 px, light and dark; before = the previous build via `URL_`).

