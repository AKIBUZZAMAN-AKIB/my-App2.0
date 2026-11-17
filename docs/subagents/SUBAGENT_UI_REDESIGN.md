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

## Checks

`agent-view.js` (each width 390 / 768 / 1280): exactly one visible tablist and the Agents tabs hidden; breadcrumb, name,
status above the nav; sections in one row (bar) or one column (side), no sideways scroll, selected visible; at 390 the
rest go into More and a section picked from More becomes selected and visible; Back restores the list and the Agents
tabs; the switcher opens another agent. `subagent-graph-fixes.js`: the breadcrumb lists the ancestry and a parent crumb
opens that agent.
