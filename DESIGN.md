# Design System — dops-assistant

## Product Context
- **What this is:** AI-powered root cause analysis for DevOps teams. Connects to monitoring stacks via MCP to investigate incidents, analyze metrics/logs, and deliver structured RCA reports.
- **Who it's for:** DevOps engineers, SREs, and platform teams investigating production incidents.
- **Space/industry:** Observability & incident management. Peers: Grafana, Datadog, PagerDuty, incident.io, Rootly, FireHydrant.
- **Project type:** Web application — dashboard + conversational chat + investigation pipeline + RCA reports.

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Warmth
- **Decoration level:** Intentional — subtle grain texture (2.5% opacity noise overlay), dot-grid backgrounds, colored glow effects. Each texture signals a specific surface type.
- **Mood:** A precision instrument, not a cold monitor. The product should feel like a well-made tool — functional, data-dense, but warm enough to spend hours in during an incident. "Warm Precision" (light) and "Deep Instrument" (dark) capture this.
- **Reference sites:** Grafana (orange, dark-first dashboards), Datadog (purple brand, DRUIDS system), incident.io (editorial, light, minimal), PagerDuty (green, corporate), SigNoz (dark, red accents), Rootly (soft purple), FireHydrant (dark blue).

### Competitive Positioning
The observability space converges on cold grays, generic sans-serifs (Inter/Roboto), and single-accent-color differentiation. dops-assistant stands apart through:
1. **Cyan primary** — unclaimed in the space (Grafana=orange, Datadog=purple, PagerDuty=green)
2. **Warm neutrals** — cream backgrounds (light) and deep navy (dark) instead of pure white/black
3. **Grain + glow textures** — physical depth that flat competitors lack

## Typography
- **Display/Hero:** Outfit (300–800) — Geometric sans-serif with warmth. More personality than Inter, less quirky than a display serif. Used for page titles, section headers, stat values, uppercase labels.
- **Body:** DM Sans (300–600) — Excellent optical sizing (9–40pt). Clean and legible at small sizes. Used for paragraphs, form labels, table content, chat messages.
- **UI/Labels:** Same as body (DM Sans) at 11–12px medium weight.
- **Data/Tables:** JetBrains Mono (400–600) — Industry standard for code. Supports `tabular-nums` for aligned metrics. Used for log output, PromQL queries, tool call names, phase codes, badges with numeric content.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts CDN — `https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=JetBrains+Mono:wght@400;500;600&display=swap`
- **Scale:**

| Level | Size | Font | Weight | Usage |
|-------|------|------|--------|-------|
| Display | 28–32px | Outfit | 700 | Page titles, hero headings |
| Title | 18–22px | Outfit | 600 | Section headers, RCA report title |
| Subtitle | 14–16px | Outfit | 500–600 | Subsection headers, stat card labels |
| Body | 13–14px | DM Sans | 400 | Paragraphs, chat messages, descriptions |
| Label | 11–12px | DM Sans | 500 | Form labels, table headers, secondary text |
| Caption | 10px | DM Sans | 400 | Timestamps, tertiary info |
| Mono-xs | 10–11px | JetBrains Mono | 400–500 | Tool calls, phase codes, badges, inline code |
| Mono-data | 12–13px | JetBrains Mono | 400 | Metric values, data tables, log output |
| Mono-display | 24–26px | JetBrains Mono | 600 | Large metric readouts (tabular-nums) |
| Uppercase | 9–11px | Outfit/Mono | 600–700 | Section labels (tracking: 0.08–0.12em) |

### Font Blacklist (never use)
Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Courier New (for body).

### Overused Fonts (avoid as primary)
Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins.

## Color
- **Approach:** Balanced — primary + accent create a distinctive pairing. Semantic colors for status hierarchy. Muted backgrounds keep data readable.

### Palette

| Role | Light | Dark | HSL Light | HSL Dark | Usage |
|------|-------|------|-----------|----------|-------|
| Primary (Cyan) | #0F8BA0 | #18B8CC | 192, 75%, 36% | 185, 80%, 48% | Links, active states, focus rings, primary buttons, phase indicators |
| Accent (Amber) | #E87A18 | #E08A22 | 28, 90%, 52% | 32, 85%, 55% | Emphasis, warnings-adjacent, discovery, hotspots |
| Success | #2E9B6E | #36B57D | 160, 55%, 38% | 160, 65%, 42% | Healthy services, completed phases, positive deltas |
| Destructive | #D63B2F | #D64848 | 4, 72%, 50% | 0, 68%, 55% | Errors, critical services, failed phases |
| Warning | #C89012 | #D49A1C | 40, 85%, 48% | 38, 80%, 52% | Degraded services, caution states |
| Info | #3178B8 | #4A8FD6 | 210, 60%, 48% | 215, 70%, 55% | Informational notices, in-progress states |
| Background | warm cream | deep navy | 48, 20%, 97% | 228, 35%, 6% | Page background |
| Card | white | #141927 | 0, 0%, 100% | 225, 28%, 9% | Elevated surfaces, panels |
| Secondary | light gray | dark blue-gray | 220, 12%, 93% | 225, 18%, 14% | Secondary buttons, code blocks, hover states |
| Muted | warm gray | deep blue-gray | 45, 10%, 94% | 225, 18%, 12% | Muted backgrounds, skeleton loaders |
| Border | — | — | 220, 12%, 88% | 225, 16%, 17% | All borders, dividers |
| Foreground | near-black | light gray | 220, 25%, 14% | 216, 25%, 88% | Primary text |
| Muted FG | — | — | 220, 10%, 35% | 216, 15%, 65% | Secondary text, placeholders |

### Glow Effects
Colored box-shadows that add depth and signal semantic meaning:
- `--glow-cyan`: `0 0 10px hsla(192, 75%, 36%, 0.12)` (light) / `0 0 14px hsla(185, 80%, 48%, 0.30)` (dark)
- `--glow-amber`: `0 0 10px hsla(28, 90%, 52%, 0.12)` / `0 0 14px hsla(32, 85%, 55%, 0.25)`
- `--glow-green`: `0 0 10px hsla(160, 55%, 38%, 0.12)` / `0 0 14px hsla(160, 65%, 42%, 0.25)`
- `--glow-red`: `0 0 10px hsla(4, 72%, 50%, 0.10)` / `0 0 12px hsla(0, 68%, 55%, 0.22)`

### Dark Mode Strategy
Not a simple inversion. Dark mode ("Deep Instrument") uses deep blue-navy backgrounds (228° hue) rather than pure black. Saturation is increased 5–10% on primary/accent to maintain vibrancy against dark surfaces. Glow effects are amplified (higher alpha) to compensate for reduced ambient contrast.

### AI Slop Anti-Patterns (never use)
- Purple/violet gradients as default accent
- 3-column feature grid with icons in colored circles
- Centered everything with uniform spacing
- Uniform bubbly border-radius on all elements
- Gradient buttons as the primary CTA pattern
- Generic stock-photo-style hero sections

## Spacing
- **Base unit:** 4px
- **Density:** Compact — appropriate for data-heavy dashboards and investigation timelines.
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
- **Max content width:** No hard max — fills available viewport. Dashboard panels are fluid.
- **Border radius:**

| Token | Value | Usage |
|-------|-------|-------|
| sm | 4px | Badges, inline tags, code snippets |
| md | 8px | Buttons, inputs, small cards, stat cards |
| lg | 10px | Cards, panels, modals (default `--radius`) |
| xl | 14px | Large containers, mockup frames, popovers |
| full | 9999px | Pills, status dots, circular indicators |

## Motion
- **Approach:** Intentional — every animation aids comprehension. No motion for decoration alone.
- **Easing:**
  - Enter: `ease-out` (decelerate into position)
  - Exit: `ease-in` (accelerate out of view)
  - Move/Orchestrate: `cubic-bezier(0.25, 0.46, 0.45, 0.94)` (smooth, controlled)
- **Duration:**

| Token | Range | Usage |
|-------|-------|-------|
| micro | 50–100ms | Hover states, toggle switches, focus rings |
| short | 150–250ms | Button press feedback, input focus glow, tooltip appearance |
| medium | 300–400ms | Panel entrance (fade-up), card appearance, slide-in-right |
| long | 500–700ms | Phase stepper progress fill, glow-pulse cycle (2.5s infinite) |

- **Stagger:** 40ms delay between sequential items (`.delay-1` through `.delay-8`).
- **Entrance animations:**
  - `fade-up`: opacity 0→1, translateY 8px→0 (400ms)
  - `fade-in`: opacity 0→1 (350ms)
  - `fade-in-fast`: opacity 0→1, translateY 2px→0 (200ms)
  - `slide-in-right`: opacity 0→1, translateX 12px→0 (350ms)
- **Status animations:**
  - `glow-pulse`: box-shadow 6px→16px (2.5s infinite, primary color)
  - `status-pulse`: opacity 1→0.35 (1.8s infinite)
  - `shimmer`: background-position sweep (1.6s infinite, for loading states)
  - `progress-indeterminate`: translateX -100%→250% (1.6s infinite)

## Texture & Decoration
- **Grain:** SVG fractalNoise filter at 2.5% opacity, applied via `.noise::before` pseudo-element. Adds subtle physical texture to elevated surfaces.
- **Dot grid:** Radial gradient dots at 24px intervals, applied via `.bg-grid`. Used for background visual interest on hero/empty states.
- **Glow:** Colored box-shadows (see Color section). Applied to status indicators, active elements, and hover states on primary buttons.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-18 | Initial design system documented | Codified from existing CSS tokens in `src/web/index.css`. Created by /design-consultation based on product context and competitive research across 7 observability tools. |
| 2026-03-18 | Added warning and info semantic colors | Gap in existing system — had success/destructive but no warning (degraded services) or info (in-progress states). |
| 2026-03-18 | Formalized border-radius hierarchy | Existing system had single `--radius` with calculated derivatives. Codified intentional scale: sm(4px) for inline, md(8px) for interactive, lg(10px) for containers. |
| 2026-03-18 | Formalized motion tokens | Existing CSS had animations but no documented token system. Codified micro/short/medium/long durations and enter/exit/orchestrate easing curves. |
| 2026-03-18 | Documented typography scale | Font sizes were ad-hoc across components (8–32px range). Codified into named levels with specific fonts, weights, and usage guidance. |
