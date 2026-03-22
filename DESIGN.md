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
| Success | #2E9B6E | #3DAF7E | 152, 55%, 39% | 152, 55%, 46% | Healthy services, completed phases, positive deltas |
| Destructive | #C93B3B | #E04848 | 0, 55%, 51% | 0, 70%, 58% | Errors, critical services, failed phases |
| Warning | #B88A1E | #D4A826 | 42, 73%, 42% | 42, 73%, 49% | Degraded services, caution states |
| Info | #3178B8 | #4A8FD6 | 210, 58%, 46% | 215, 62%, 56% | Informational notices, in-progress states |
| Background | #FAFAF7 | #0F1115 | 40, 15%, 97% | 225, 18%, 7% | Page background (warm stone / deep charcoal) |
| Card | #FFFFFF | #181B22 | 0, 0%, 100% | 224, 16%, 11% | Elevated surfaces, panels |
| Secondary | #EDEBE6 | #252830 | 36, 16%, 92% | 222, 13%, 17% | Secondary buttons, code blocks, hover states |
| Muted | #F3F1EC | #1E2128 | 36, 19%, 94% | 222, 13%, 13% | Muted backgrounds, skeleton loaders |
| Border | #E2DFD9 | #2A2E36 | 33, 12%, 87% | 220, 14%, 19% | All borders, dividers, horizontal rules |
| Foreground | #1C1E21 | #E2E4E8 | 216, 8%, 12% | 216, 12%, 90% | Primary text |
| Muted FG | #6B6E73 | #8B8F96 | 216, 4%, 44% | 216, 5%, 57% | Secondary text, placeholders, timestamps |

### Dark Mode Strategy
Dark mode uses deep charcoal backgrounds (225° hue, cool undertone) rather than pure black. Primary teal shifts brighter (#2DD4A8) to maintain vibrancy against dark surfaces. Coral accent warms slightly. Background and card surfaces have subtle blue undertone for depth.

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
- **Approach:** Grid-disciplined dashboard
- **Grid:** Three-column: sidebar/main/chat via `ResizablePanelGroup`. Proportions: ~25% / ~45% / ~30% (user-adjustable).
- **Max content width:** No hard max — fills available viewport. Report text maxes at 640px for readable line length.
- **Border radius:**

| Token | Value | Usage |
|-------|-------|-------|
| sm | 4px | Badges, inline tags, code snippets |
| md | 8px | Buttons, inputs, small cards, stat cards |
| lg | 10px | Cards, panels, modals (default `--radius`) |
| xl | 14px | Large containers, mockup frames, popovers |
| full | 9999px | Pills, status dots, circular indicators |

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

## Dashboard Layout
The main dashboard ("Operations Desk") follows a two-panel layout: scrollable dashboard (left) + resizable console/chat (right).

**Dashboard column (top to bottom):**
1. **Status Strip** — system health, uptime, MCP/DB probe status. Monospace stamp. Always visible.
2. **Page title** — "Operations Desk" in Inter 700.
3. **KPI Stat Cards** — 2x2 grid. Investigations (active/complete/failed), Services Healthy (N/Total), Avg MTTR 7d (with trend arrow), Token Usage. Mono-display numbers, Inter labels.
4. **Active Investigations** — conditional coral-tinted section. Pulsing dots for running, red for failed. Collapses when nothing active.
5. **Services Grid** — 2-3 col cards with health dot, investigation count, last investigation time. Manage/Re-discover links below.
6. **Investigation Log** — compact table: status dot, service + severity badge, root cause, confidence, tokens, duration.
7. **Learned Patterns** — collapsed by default. Severity badge + service + symptom/root cause.

**Console panel (right):** Existing ChatPane, resizable 240-500px.

### Dashboard Interaction States

**Error banner** — full-width below title on fetch failure. Destructive/06 background, destructive/15 border, ⚠ icon + "Unable to load dashboard data" (body 13px) + error detail (mono 10px). "Retry" text button in destructive color. Fade-up entrance. Auto-dismisses on successful retry.

**Toast notifications** — bottom-right, 24px from edges, max-width 320px. Card background with border + shadow (0 8px 24px foreground/08). Status dot (success/destructive) + service name (body 13px semibold) + status text (mono 10px). Slide-in-right entrance (350ms), fade-out exit (250ms). Auto-dismiss 8s, hover pauses. Max 3 stacked, 8px gap. Click navigates to investigation.

**"Last updated" timestamp** — right-aligned in title row after services count. JetBrains Mono 9px, muted-foreground/50, tracking-wide. Format: "Updated HH:MM:SS" (24h, tabular-nums). Shifts to warning/60 after 2 minutes stale.

**Auto-refresh indicator** — full-width 2px hairline below status strip. Reuses progress-bar-track/fill pattern. Linear fill over 60 seconds (not eased — progress should feel steady). Instant reset on fetch. Indeterminate animation during manual retry.

**Empty state illustrations** — monochrome line art (stroke: muted-foreground/15, 1.5px, no fill). 64px viewBox rendered at 48px. Investigations: magnifying glass over blank page. Services: compass with dotted sweep lines. Text below: body 13px muted-foreground/70, mono 10px subtext. Centered, 12px gap.

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
| 2026-03-18 | KPIs: Investigations, Services Healthy, MTTR (7d trend), Token Usage | Four cards that answer: how many, how healthy, how fast, how much. MTTR trend arrow shows improvement/regression at a glance. |
| 2026-03-18 | All card backgrounds use CSS variables, not hardcoded rgba | Light mode had muddy gray cards when using dark-theme rgba values. Theme-adaptive variables ensure both themes work independently. |
| 2026-03-18 | Toast at bottom-right, not top-center | Top-center competes with the status strip and title. Bottom-right is out of the primary reading path — noticeable but not intrusive. Max 3 to prevent notification fatigue. |
| 2026-03-18 | "Last updated" as inline text, not separate component | A dedicated "freshness bar" is over-designed for a single timestamp. Inline after service count keeps it discoverable without adding visual weight. Warning color at 2min signals staleness without alarm. |
| 2026-03-18 | Empty states use monochrome line art, not filled illustrations | Colored illustrations would fight the restrained palette. Line art at 15% opacity stays subordinate to the content hierarchy — visible enough to humanize, light enough not to distract. |
| 2026-03-18 | Auto-refresh uses linear easing, not ease-out | Progress bars with eased motion feel deceptive — they appear to speed up or slow down when the refresh interval is constant. Linear communicates honest, predictable behavior. |
