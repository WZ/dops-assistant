# Design System — dops-assistant

## Product Context
- **What this is:** AI-powered root cause analysis for DevOps teams. Connects to monitoring stacks via MCP to investigate incidents, analyze metrics/logs, and deliver structured RCA reports.
- **Who it's for:** DevOps engineers, SREs, and platform teams investigating production incidents.
- **Space/industry:** Observability & incident management. Peers: Grafana, Datadog, PagerDuty, incident.io, Rootly, FireHydrant.
- **Project type:** Web application — dashboard + conversational chat + investigation pipeline + RCA reports.

## Aesthetic Direction
- **Direction:** Editorial/Refined — "The Investigator's Desk"
- **Decoration level:** Intentional — subtle paper-like texture on elevated surfaces, clean horizontal rules, monospace stamps and labels as decorative elements (case file aesthetic).
- **Mood:** A carefully prepared investigative document. The product feels like it takes incidents seriously — typography does the heavy lifting, color is rare and meaningful. Somewhere between a well-edited publication and a senior SRE's organized workbench.
- **Reference sites:** incident.io (editorial approach), Grafana (data density), Stripe Docs (typographic quality), Bloomberg Terminal (information authority).

### Competitive Positioning
The observability space converges on cold grays, geometric sans-serifs, and single-accent-color differentiation. dops-assistant stands apart through:
1. **Clean sans-serif typography** — Inter's professional clarity at all sizes, paired with tight tracking for headers, creates an enterprise-grade feel appropriate for Fortinet's product family.
2. **Deep Teal primary** — unclaimed in the space (Grafana=orange, Datadog=purple, PagerDuty=green). Signals calm expertise.
3. **Restrained color** — 80% of the UI is typography and neutrals. When teal or coral appears, it means something.

## Typography
- **Display/Hero:** Inter (300–800) — Clean, professional sans-serif with excellent readability at all sizes. Industry standard for enterprise SaaS. Used for page titles, section headers, RCA report headings, stat card titles, branding.
- **Body:** Plus Jakarta Sans (300–700) — Geometric sans with humanist warmth. Excellent x-height and readability at small sizes. Used for paragraphs, chat messages, form labels, table content, descriptions.
- **UI/Labels:** Same as body (Plus Jakarta Sans) at 11–12px medium weight.
- **Data/Tables:** JetBrains Mono (400–600) — Industry standard for code. Supports `tabular-nums` for aligned metrics. Used for log output, PromQL queries, tool call names, phase codes, badges, metric values.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts CDN — `https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap`
- **Scale:**

| Level | Size | Font | Weight | Usage |
|-------|------|------|--------|-------|
| Display | 28–32px | Inter | 700 | Page titles, hero headings |
| Title | 18–22px | Inter | 600 | Section headers, RCA report title |
| Subtitle | 14–16px | Inter | 500–600 | Subsection headers, stat card labels |
| Body | 13–14px | Plus Jakarta Sans | 400 | Paragraphs, chat messages, descriptions |
| Label | 11–12px | Plus Jakarta Sans | 500 | Form labels, table headers, secondary text |
| Caption | 10px | Plus Jakarta Sans | 400 | Timestamps, tertiary info |
| Mono-xs | 10–11px | JetBrains Mono | 500–600 | Tool calls, phase codes, badges, inline code |
| Mono-data | 12–13px | JetBrains Mono | 400 | Metric values, data tables, log output |
| Mono-display | 24–26px | JetBrains Mono | 600 | Large metric readouts (tabular-nums) |
| Uppercase | 9–11px | JetBrains Mono | 600 | Section labels (tracking: 0.08–0.12em) |

### Font Blacklist (never use)
Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Courier New (for body).

## Color
- **Approach:** Restrained — teal primary + coral accent. Most of the UI is typographic. Color appears only where it carries semantic meaning. No decorative gradients or accent-color-everywhere patterns.

### Palette

| Role | Light | Dark | HSL Light | HSL Dark | Usage |
|------|-------|------|-----------|----------|-------|
| Primary (Teal) | #0D7C66 | #2DD4A8 | 166, 80%, 27% | 160, 67%, 50% | Links, active states, focus rings, primary buttons, phase indicators |
| Accent (Coral) | #C2533D | #E0785A | 10, 55%, 50% | 14, 65%, 60% | Emphasis, discovery highlights, secondary CTAs, hotspots |
| Success | #1E9458 | #4EDB94 | 152, 72%, 34% | 152, 70%, 55% | Healthy services, completed phases, positive deltas |
| Destructive | #C93434 | #F75A5A | 0, 72%, 46% | 0, 90%, 68% | Errors, critical services, failed phases |
| Warning | #B88A1E | #D4A826 | 42, 73%, 42% | 42, 73%, 49% | Degraded services, caution states |
| Info | #3178B8 | #4A8FD6 | 210, 58%, 46% | 215, 62%, 56% | Informational notices, in-progress states |
| Background | #FAFAF7 | #0F1115 | 40, 15%, 97% | 225, 18%, 7% | Page background (warm stone / deep charcoal) |
| Card | #FFFFFF | #181B22 | 0, 0%, 100% | 224, 16%, 11% | Elevated surfaces, panels |
| Secondary | #EDEBE6 | #252830 | 36, 16%, 92% | 222, 13%, 17% | Secondary buttons, code blocks, hover states |
| Muted | #F3F1EC | #1E2128 | 36, 19%, 94% | 222, 13%, 13% | Muted backgrounds, skeleton loaders |
| Border | #E2DFD9 | #2A2E36 | 33, 12%, 87% | 220, 14%, 19% | All borders, dividers, horizontal rules |
| Foreground | #131517 | #EEEFF2 | 216, 10%, 8% | 216, 10%, 95% | Primary text |
| Muted FG | #585D63 | #9DA1A8 | 216, 6%, 38% | 216, 5%, 65% | Secondary text, placeholders, timestamps |

### Dark Mode Strategy
Dark mode uses deep charcoal backgrounds (225° hue, cool undertone) rather than pure black. Primary teal shifts brighter (#2DD4A8) to maintain vibrancy against dark surfaces. Coral accent warms slightly. Background and card surfaces have subtle blue undertone for depth. Status colors (success, destructive) are pushed to high saturation + lightness so dots and sparklines pop against dark cards — green at 70% sat / 55% L, red at 90% sat / 68% L. Foreground text is near-white (95% lightness) for maximum readability.

### AI Slop Anti-Patterns (never use)
- Purple/violet gradients as default accent
- 3-column feature grid with icons in colored circles
- Centered everything with uniform spacing
- Uniform bubbly border-radius on all elements
- Gradient buttons as the primary CTA pattern
- Generic stock-photo-style hero sections

## Spacing
- **Base unit:** 4px
- **Density:** Compact for dashboards and data tables. Generous line-height (1.7) in report text and chat messages — reading comfort matters for investigation narratives.
- **Scale:**

| Token | Value | Usage |
|-------|-------|-------|
| 2xs | 2px | Hairline gaps, dot indicators |
| xs | 4px | Tight inline spacing (gap-1) |
| sm | 8px | Component internal padding, small gaps (gap-2) |
| md | 16px | Standard padding, card internals (gap-4, p-4) |
| lg | 24px | Section spacing, card padding (gap-6, p-6) |
| xl | 32px | Major section gaps (gap-8, p-8) |
| 2xl | 48px | Section separators, large vertical rhythm |
| 3xl | 64px | Page-level vertical rhythm |

## Layout
- **Approach:** Grid-disciplined dashboard with vertical sidebar navigation
- **Shell structure:** `sidebar (48px) | content (60%) | chat (40%)` via flex + `ResizablePanelGroup` for the content/chat split.
- **Sidebar:** 48px icon-only rail, always visible. Active indicator: 3px × 16px teal bar on left edge. Theme toggle pinned to sidebar bottom.
- **Top bar:** 40px. Left: branding dots + "DOPS ASSISTANT". Right: health status cluster (dot + HEALTHY + uptime + mcp:ok + db:ok). No navigation items in the top bar.
- **Content/Chat split:** `ResizablePanelGroup` horizontal. Content panel default 60%, chat panel default 40%, both user-resizable.
- **Max content width:** No hard max — fills available viewport. Report text maxes at 640px for readable line length.
- **Border radius:**

| Token | Value | Usage |
|-------|-------|-------|
| sm | 4px | Badges, inline tags, code snippets |
| md | 8px | Buttons, inputs, small cards, stat cards, sidebar buttons |
| lg | 10px | Cards, panels, modals (default `--radius`) |
| xl | 14px | Large containers, mockup frames, popovers |
| full | 9999px | Pills, status dots, circular indicators |

### Navigation

Three sidebar items:

| Icon | Page | Content |
|------|------|---------|
| Layout grid | **Dashboard** | KPIs, active investigations, health strip, investigation log |
| Server stack | **Services** | Full service card grid (grouped by health), search, hide/unhide, manage, discover |
| Gear | **Settings** | Tabbed: Providers + Skills |

**Sidebar behavior:**
- 36px icon buttons with 8px border-radius
- Active state: `primary/8` background + `primary` icon color + left-edge bar
- Inactive: `muted-foreground` icon, hover → `secondary` background
- Tooltip on hover: `JetBrains Mono 10px`, slides out 8px to the right, `fg` background / `bg` text

**Page transitions:** Switching pages does not change the chat panel — the console persists across all pages. The chat panel's "investigate" command automatically navigates the left panel to the investigation detail view regardless of current page.

## Motion
- **Approach:** Minimal-functional — every animation aids comprehension. No motion for decoration. The product should feel calm and precise, not bouncy.
- **Easing:**
  - Enter: `ease-out` (decelerate into position)
  - Exit: `ease-in` (accelerate out of view)
  - Move/Orchestrate: `cubic-bezier(0.25, 0.46, 0.45, 0.94)` (smooth, controlled)
- **Duration:**

| Token | Range | Usage |
|-------|-------|-------|
| micro | 50–100ms | Hover states, toggle switches, focus rings |
| short | 150–250ms | Button press feedback, input focus, tooltip appearance |
| medium | 300–400ms | Panel entrance (fade-up), card appearance, slide-in-right |
| long | 500–700ms | Phase stepper progress fill |

- **Stagger:** 40ms delay between sequential items.
- **Entrance animations:**
  - `fade-up`: opacity 0→1, translateY 8px→0 (400ms)
  - `fade-in`: opacity 0→1 (350ms)
  - `slide-in-right`: opacity 0→1, translateX 12px→0 (350ms)
- **Status animations:**
  - `status-pulse`: opacity 1→0.35 (1.8s infinite, for active investigation indicators)
  - `shimmer`: background-position sweep (1.6s infinite, for loading states)

## Texture & Decoration
- **Paper texture:** SVG fractalNoise filter at 2.5% opacity, applied via `::before` pseudo-element on elevated surfaces. Adds subtle physical depth — the "case file" feel.
- **Horizontal rules:** Clean 1px borders as section dividers. No heavy card borders or shadow-heavy elevation. Let typography create hierarchy.
- **Monospace stamps:** Section labels use JetBrains Mono uppercase with wide letter-spacing (0.1–0.12em). Creates a "case file classification" aesthetic.

## Page: Dashboard

The main dashboard ("Operations Desk") is a read-only monitoring view. No management actions — just status and history.

**Dashboard sections (top to bottom):**
1. **Page title** — "Operations Desk" in Inter 700 + subtitle showing service count and last-updated timestamp.
2. **KPI Stat Cards** — 3-column grid. Investigations (count + complete/failed + confidence), Services Health (healthy/total, colored by status), Avg MTTR 7d (with trend arrow). Mono-display numbers, Inter labels.
3. **Active Investigations** — conditional coral-tinted section. Pulsing dots for running, red for failed. Collapses when nothing active.
4. **Health Strip** — compact chip layout replacing the full service card grid. Each service rendered as a `dot + name` chip (JetBrains Mono 10px) in a wrapping flex container. Chips sorted: degraded/down first, then healthy, then unknown. Clicking a chip navigates to the Services page. "View all →" link at the end navigates to Services.
5. **Investigation Log** — compact table: status dot, service + severity badge, root cause, confidence, timestamp.
6. **Learned Patterns** — collapsed by default. Severity badge + service + symptom/root cause.

### Health Strip Design

The health strip is a single card container (`bg-card`, `border`, `border-radius: lg`, `padding: 12px 16px`) with wrapping flex layout (`gap: 6px`). Each chip:
- `padding: 4px 10px`, `border-radius: 6px`, `background: secondary/50`
- Dot: `5px` circle, colored by health status (success/warning/destructive/muted-foreground)
- Name: `JetBrains Mono 10px 500`, `foreground/90`
- Hover: `background: secondary`
- Clicking a chip navigates to the Services page (not an inline expansion)

**Rationale:** The health strip communicates the same information as the full card grid (which service is in what state) in ~1/5th the vertical space. On a monitoring dashboard, you only need to *identify* unhealthy services at a glance — the details belong on the Services page.

### Dashboard Interaction States

**Error banner** — full-width below title on fetch failure. Destructive/06 background, destructive/15 border, ⚠ icon + "Unable to load dashboard data" (body 13px) + error detail (mono 10px). "Retry" text button in destructive color. Fade-up entrance. Auto-dismisses on successful retry.

**Toast notifications** — bottom-right, 24px from edges, max-width 320px. Card background with border + shadow (0 8px 24px foreground/08). Status dot (success/destructive) + service name (body 13px semibold) + status text (mono 10px). Slide-in-right entrance (350ms), fade-out exit (250ms). Auto-dismiss 8s, hover pauses. Max 3 stacked, 8px gap. Click navigates to investigation.

**"Last updated" timestamp** — inline in page subtitle after services count. JetBrains Mono 9px, muted-foreground/50, tracking-wide. Format: "Updated HH:MM:SS" (24h, tabular-nums). Shifts to warning/60 after 2 minutes stale.

**Auto-refresh indicator** — full-width 2px hairline at top of content area. Breathing animation (primary/30 opacity pulse). Resets on fetch.

**Empty state illustrations** — monochrome line art (stroke: muted-foreground/15, 1.5px, no fill). 64px viewBox rendered at 48px. Investigations: magnifying glass over blank page. Services: compass with dotted sweep lines. Text below: body 13px muted-foreground/70, mono 10px subtext. Centered, 12px gap.

## Page: Services

Full service management page. Contains all service cards, health monitoring, and management actions that were previously on the Dashboard.

**Services page sections:**
1. **Page title** — "Services" in Inter 700 + subtitle with total count and health breakdown.
2. **Toolbar** — search input (JetBrains Mono 10px, 180px→220px on focus) + action buttons: Select (toggle bulk mode), Manage (navigate to manage sub-view), Re-discover (primary button, triggers AI discovery).
3. **Service groups** — cards grouped by health status (Degraded/Down → Healthy → Unknown → Hidden). Each group has a collapsible header with arrow + colored dot + label + count.
4. **Service cards** — 3-column grid. Each card: health dot (8px with ring), service name, health status label, 24h sparkline (DotTimeline), investigation count + last investigation time. Hide button on hover. Full card is clickable → triggers investigation via chat.

**Management actions** (all moved from Dashboard):
- Hide/unhide individual services
- Bulk select mode with "Hide N selected" action bar
- "hide all" link on Unknown group header
- Manage and Re-discover toolbar buttons

**Sub-views** (navigate within Services page, not separate pages):
- `services:manage` — ServicesManage component
- `services:history` — VersionHistory component
- `services:discovery` — DiscoveryProgress component
- `services:review` — DiscoveryReview component

## Page: Settings

Combined Providers + Skills page with tab navigation.

**Settings page structure:**
1. **Page title** — "Settings" in Inter 700 + subtitle "Providers, skills, and configuration".
2. **Tab bar** — horizontal tabs at top: "Providers" (default), "Skills". Tab style: JetBrains Mono 10px 500, 2px bottom border for active tab (primary color), border-bottom 1px separator.
3. **Providers tab** — existing ProvidersPage content (provider cards with name, transport, connection status badge, role badges).
4. **Skills tab** — existing SkillsPage content (skill editor with YAML).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-18 | Started fresh with "Investigator's Desk" direction | Previous "Industrial/Utilitarian" system was too similar to category norms. New editorial direction differentiates through serif typography and restrained color. |
| 2026-03-20 | Switched display font from Fraunces to Inter | FortiSOC branding needs enterprise-grade sans-serif. Inter is clean and professional at all sizes. Fraunces serif felt out of place for a Fortinet product name. |
| 2026-03-18 | Chose Plus Jakarta Sans for body | Geometric sans with humanist warmth. Better personality than Inter/Roboto without sacrificing readability. |
| 2026-03-18 | Chose teal (#0D7C66) as primary | Unclaimed color in the observability space. Calm and stable — opposite of the "everything is on fire" energy most incident tools project. |
| 2026-03-18 | Chose coral (#C2533D) as accent | Warm, earthy attention without the alarm of red. Pairs naturally with teal (complementary relationship). |
| 2026-03-18 | Restrained color approach | Most of the UI is typographic. Color is rare and meaningful. Differentiates from competitors who blast accent color everywhere. |
| 2026-03-18 | Minimal-functional motion | Calm, precise product feel. No decorative animation. Matches the editorial aesthetic. |
| 2026-03-18 | Dashboard layout: Status → KPIs → Active → Services → Log → Patterns | Status strip first (SRE glance bar), KPIs second (overall health), Active third (conditional fire detector). Information hierarchy matches incident response mental model. |
| 2026-03-18 | KPIs: Investigations, Services Healthy, MTTR (7d trend), Token Usage | Original four cards — Token Usage later replaced with Avg Confidence. |
| 2026-03-23 | KPIs: Investigations (+ success rate), Services Health (real Prometheus data), MTTR (7d trend), Avg Confidence | Four cards answering: how many + how well, how healthy (real data), how fast, how good. Token Usage removed (not actionable). Services Health now uses real Prometheus health poller data instead of investigation-derived status. Success rate excludes stale-cleanup failures. Confidence uses json_valid-guarded extraction from RCA reports. |
| 2026-03-18 | All card backgrounds use CSS variables, not hardcoded rgba | Light mode had muddy gray cards when using dark-theme rgba values. Theme-adaptive variables ensure both themes work independently. |
| 2026-03-18 | Toast at bottom-right, not top-center | Top-center competes with the status strip and title. Bottom-right is out of the primary reading path — noticeable but not intrusive. Max 3 to prevent notification fatigue. |
| 2026-03-18 | "Last updated" as inline text, not separate component | A dedicated "freshness bar" is over-designed for a single timestamp. Inline after service count keeps it discoverable without adding visual weight. Warning color at 2min signals staleness without alarm. |
| 2026-03-18 | Empty states use monochrome line art, not filled illustrations | Colored illustrations would fight the restrained palette. Line art at 15% opacity stays subordinate to the content hierarchy — visible enough to humanize, light enough not to distract. |
| 2026-03-18 | Auto-refresh uses linear easing, not ease-out | Progress bars with eased motion feel deceptive — they appear to speed up or slow down when the refresh interval is constant. Linear communicates honest, predictable behavior. |
| 2026-03-24 | Switched from horizontal top nav to 48px vertical icon sidebar | Product has grown to enough pages that horizontal nav was running out of space. Vertical sidebar matches observability tool conventions (Grafana, Datadog, incident.io) and scales to future pages. |
| 2026-03-24 | Reorganized into 3 pages: Dashboard, Services, Settings | Dashboard was trying to be monitoring overview + service management + investigation history all at once. Split into: Dashboard (read-only monitoring), Services (full management), Settings (providers + skills combined). |
| 2026-03-24 | Replaced full service card grid on Dashboard with compact health strip | Full card grid with management UI was the primary source of dashboard clutter. Health strip (dot + name chips) communicates service status in ~1/5th the vertical space. Details and management moved to dedicated Services page. |
| 2026-03-24 | Combined Providers and Skills into Settings page with tabs | Both are configuration concerns. Separating them into two top-level nav items isn't justified — they're visited infrequently. Tabs keep both discoverable without adding nav depth. |
| 2026-03-24 | Theme toggle moved from top bar to sidebar bottom | Declutters the top bar (now just branding + health status). Theme toggle is a low-frequency action that doesn't need prime top-bar real estate. Sidebar bottom is the convention (VS Code, Linear, Notion). |
| 2026-03-24 | KPI grid changed from 4 columns to 3 | Dropped Avg Confidence as a standalone KPI card. Confidence value is now shown inline in the Investigations card detail text. Three cards answer: how many + how well, how healthy, how fast. |
| 2026-03-24 | Brightness pass — both themes | Dark mode: foreground 90%→95% L, muted-fg 57%→65% L, success 55%/46%→70%/55%, destructive 70%/58%→90%/68%. Light mode: foreground 12%→8% L (darker), muted-fg 44%→38% L, success 55%/39%→72%/34%, destructive 55%/51%→72%/46%. DotTimeline opacity: healthy 0.45→0.75, down 0.7→1.0. Status dots: removed /80 damping, ring glow /15→/25. Rationale: status indicators and text were too dim in both themes — monitoring dashboards need at-a-glance readability. |
