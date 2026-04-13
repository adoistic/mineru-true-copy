# Design System — DocTransform

## Product Context
- **What this is:** Desktop document processing tool — OCR, translation, data extraction with layout-preserving output
- **Who it's for:** Government operations staff in India processing large volumes of PDF documents
- **Space/industry:** Document processing (Adobe Acrobat Pro, ABBYY FineReader, Nuance)
- **Project type:** Desktop app (Tauri + Next.js), dark theme, professional tool UI

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian
- **Decoration level:** Minimal — typography and spacing do the work. No gradients, no blobs, no decorative elements.
- **Mood:** Purposeful, engineered, quietly confident. The kind of app a government agency pays $100K for. The document is the hero; the UI recedes.
- **Reference sites:** Adobe Acrobat Pro (layout pattern), Figma desktop (density + dark theme), Linear (clean tool UI)
- **Approved mockups:** `~/.gstack/projects/adoistic-data-transformation-app/designs/design-system-20260413/v2/`

## Typography
- **Display/Hero:** Geist — clean geometric sans, built for UI. Use for tool titles and page headings.
- **Body:** Geist — same family for consistency in a dense tool. 13px base for maximum content density.
- **UI/Labels:** Geist — 11px for small labels, badges, metadata. All caps for section labels with 0.05em letter-spacing.
- **Data/Tables:** Geist with `font-variant-numeric: tabular-nums` — aligned columns in data views.
- **Code/Monospace:** Geist Mono — for JSON preview, file paths, technical output.
- **Indic Scripts:** Noto Sans Devanagari, Noto Sans Bengali, Noto Sans Tamil, etc. — for translated text display.
- **Loading:** `next/font/google` with `display: swap`. Geist is available via Vercel's font CDN.
- **Scale:**
  - `text-2xs`: 10px / 14px — micro labels, badges
  - `text-xs`: 11px / 16px — small labels, metadata, status bar, section headers (all caps)
  - `text-sm`: 13px / 20px — body text, form inputs, descriptions (THE default)
  - `text-base`: 14px / 20px — sidebar nav items, panel headers
  - `text-lg`: 16px / 24px — tool titles (OCR, Translation, etc.)
  - `text-xl`: 20px / 28px — page headings (rare, used in activation screen)
- **Weight scale:** 400 (body), 500 (labels, nav), 600 (headings, buttons), 700 (hero text, rarely used)

## Color
- **Approach:** Restrained. One accent + neutrals. Color is rare and meaningful.
- **CRITICAL: Neutral grays only.** No blue-tinted slate. The #1 AI slop tell is blue-tinted backgrounds. Use pure neutral grays.
- **Surfaces:**
  - `--bg-app`: `#111111` — deepest background, behind everything
  - `--bg-surface`: `#1a1a1a` — panels, sidebar, header, footer
  - `--bg-elevated`: `#252525` — hover states, active states, dropdowns
  - `--bg-input`: `#1e1e1e` — form inputs, file drop zones
- **Borders:**
  - `--border-default`: `#2a2a2a` — panel separators, card borders
  - `--border-subtle`: `#222222` — inner dividers
  - `--border-focus`: `#0ea5e9` — focus rings (2px)
- **Text:**
  - `--text-primary`: `#e5e5e5` — headings, primary content
  - `--text-secondary`: `#888888` — descriptions, labels, metadata
  - `--text-tertiary`: `#555555` — placeholders, disabled text
  - `--text-inverse`: `#111111` — text on light backgrounds (rare)
- **Accent:**
  - `--accent`: `#0ea5e9` — primary actions, links, active nav (sky-500)
  - `--accent-hover`: `#38bdf8` — button hover
  - `--accent-muted`: `rgba(14,165,233,0.1)` — active nav background, selected states
  - `--accent-text`: `#38bdf8` — accent text on dark backgrounds
- **Semantic:**
  - `--success`: `#10b981` — completed, online, passed
  - `--success-muted`: `rgba(16,185,129,0.1)` — success backgrounds
  - `--warning`: `#f59e0b` — in progress, attention needed
  - `--warning-muted`: `rgba(245,158,11,0.1)` — warning backgrounds
  - `--error`: `#f43f5e` — failed, offline, errors
  - `--error-muted`: `rgba(244,63,94,0.1)` — error backgrounds
  - `--info`: `#38bdf8` — informational badges, tips
- **Dark mode:** This IS dark mode. No light mode planned for MVP.

## Spacing
- **Base unit:** 4px
- **Density:** Compact — professional tool for power users processing hundreds of documents
- **Scale (Tailwind classes):**
  - `gap-0.5` / `p-0.5`: 2px — micro spacing
  - `gap-1` / `p-1`: 4px — inner padding for badges, tags
  - `gap-1.5` / `p-1.5`: 6px — form input padding, tight list items
  - `gap-2` / `p-2`: 8px — between related items, small component padding
  - `gap-3` / `p-3`: 12px — sidebar padding, section inner padding
  - `gap-4` / `p-4`: 16px — between sections, panel padding
  - `gap-6` / `p-6`: 24px — major section spacing, main content padding
  - `gap-8` / `p-8`: 32px — only for activation screen / empty states

## Layout
- **Approach:** Three-panel, grid-disciplined
- **Structure:**
  ```
  ┌──────────────────────────────────────────────────┐
  │ HEADER (h-10, bg-surface, border-b)              │
  │ [DT] DocTransform           [Credits: 45,200] [⚙]│
  ├──────┬───────────────────────────────┬────────────┤
  │ SIDE │ CENTER                        │ RIGHT      │
  │ BAR  │ (document viewer)             │ PANEL      │
  │ w-16 │ flex-1                        │ w-72       │
  │ icon │                               │ (collaps.) │
  │ rail │ The star of the show.         │ Settings   │
  │  +   │ PDF/true-copy preview.        │ Export     │
  │ label│ JSON renders as true-copy.    │ Options    │
  ├──────┴───────────────────────────────┴────────────┤
  │ STATUS BAR (h-6, bg-surface, border-t)            │
  │ [●] Ready     Jobs: 0     Version: 2.4.0         │
  └──────────────────────────────────────────────────┘
  ```
- **Sidebar:** w-16 (64px) icon rail with labels below icons. Tool navigation: OCR, Extract, Translate, Combine, Search, Labels. Active: accent-muted bg + accent icon. Inactive: text-secondary, hover bg-elevated.
- **Center:** flex-1, the document viewer. This is where the user spends 90% of their attention. JSON uploads render as true-copy visual preview, never raw JSON. All formats display as they would look printed.
- **Right panel:** w-72 (288px), collapsible. Tool-specific settings with section headers in small caps. Sections separated by subtle 1px borders.
- **Header:** h-10 (40px). Logo mark + app name left. Credits badge + settings gear right. Compact.
- **Status bar:** h-6 (24px). Processing engine status dot + label. Job count. App version. Very subtle.
- **Border radius:**
  - `rounded-sm`: 2px — inputs, small badges
  - `rounded`: 4px — buttons, cards, dropdowns
  - `rounded-md`: 6px — panels, modals (rare)
  - `rounded-lg`: 8px — file drop zones, preview containers
  - `rounded-full`: 9999px — status dots, avatar badges

## Motion
- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Transitions:**
  - Panel collapse/expand: 150ms ease-out
  - Button hover/active: 100ms ease-out
  - Tab switch content: 0ms (instant)
  - Progress bar fill: continuous linear
  - Dropdown open/close: 100ms ease-out
  - Toast enter: 200ms ease-out (slide from right)
  - Toast exit: 150ms ease-in
- **No animations:** No entrance animations, no scroll effects, no loading skeletons. This is a tool.

## Component Patterns

### Buttons
- **Primary:** bg-accent text-inverse font-semibold rounded px-3 py-1.5 text-sm. Hover: bg-accent-hover.
- **Secondary:** bg-transparent border border-default text-secondary rounded px-3 py-1.5 text-sm. Hover: bg-elevated text-primary.
- **Ghost:** bg-transparent text-secondary rounded px-2 py-1 text-sm. Hover: bg-elevated text-primary.
- **Size:** All buttons min-h-[36px]. Icon-only min-h-[32px] min-w-[32px].

### Form Inputs
- **Text input:** bg-input border border-default rounded-sm px-2 py-1.5 text-sm text-primary. Focus: border-focus ring-1.
- **Checkbox:** 16x16px, rounded-sm, border-default. Checked: bg-accent with white checkmark.
- **Segmented control:** For Cloud/Local toggles. Two segments, rounded, bg-elevated. Active segment: bg-accent text-inverse.
- **Dropdown:** Same as text input + chevron.

### File Drop Zone
- **Default:** border-2 border-dashed border-default rounded-lg p-8. Cloud-upload icon + "Drop a file to process" + format list.
- **Drag over:** border-accent bg-accent-muted.
- **Has file:** Solid border, show filename + page count.

### Document Viewer
- **The hero of the app.** Documents render at natural scale on the darkest background (#111111), making them the brightest element on screen.
- **JSON input:** Always render as true-copy visual preview, never raw JSON.
- **Side-by-side mode:** Two panels, 50/50 split. Original left, translated right. Synced scrolling. View toggle buttons above: [Side-by-side] [Translated Only] [Diff].
- **Confidence indicators:** Small dot + text label per paragraph. Green "High" / Amber "Med" / Red "Low".

### Settings Panel (Right)
- **Section headers:** All caps, 11px, letter-spacing 0.05em, text-secondary. Separated by 1px border-default.
- **Cloud/Local toggles:** Segmented controls, independent per feature (OCR Engine, Table Recognition, Translation).
- **Language selector:** Checkboxes grouped by script family (Devanagari, Dravidian, Eastern, Other).
- **Export formats:** Grouped under True Copy / Reflowed / Data headers.
- **Glossary:** Collapsible section with term count badge. Expand to see/edit term pairs.

### Progress
- **Bar:** h-1.5 rounded-full bg-elevated. Fill: bg-accent. Linear animation.
- **Label:** text-xs text-secondary. "Page 3/10 — Hindi"

### Status Indicators
- **Dot:** h-2 w-2 rounded-full. Green = ready. Amber = processing. Red = error.
- **Confidence:** Dot + text label for colorblind accessibility.

### Navigation (Sidebar)
- **Icon rail:** 64px wide. Icons h-5 w-5, stroke-[1.5]. Label below icon, text-2xs.
- **Active:** bg-accent-muted, icon + label in accent color.
- **Inactive:** text-secondary. Hover: bg-elevated.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-13 | Initial design system | /design-consultation based on competitive research |
| 2026-04-13 | Neutral gray (#111/#1a1a1a), not blue-slate | Blue tint is the #1 AI slop tell. Neutral grays look premium. |
| 2026-04-13 | Geist single font family | Purpose-built for tool UIs, excellent tabular nums |
| 2026-04-13 | 13px body text | Dense tool for power users. Geist legible at 13px. |
| 2026-04-13 | Sky-500 accent | Trustworthy without being corporate. Used sparingly. |
| 2026-04-13 | Three-panel with icon rail sidebar | Category standard. Matches Adobe/Figma desktop. |
| 2026-04-13 | JSON renders as true-copy | Users upload OCR JSON, expect to see the document, not code. |
| 2026-04-13 | Independent Cloud/Local toggles | Per-feature control, not global. OCR engine, tables, translation each independent. |
| 2026-04-13 | No light mode MVP | Single environment. Dark mode only. |
