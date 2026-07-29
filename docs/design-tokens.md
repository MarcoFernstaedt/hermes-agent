# Imperator design tokens — the written reference

The spec's instruction is *discover the existing tokens, write them down, and
conform.* This is that reference. It is descriptive, not aspirational: every
token below exists in `web/src/index.css` today. **Do not hardcode a value that
has a token, and do not add a token without adding it here.**

The palette is obsidian and gold and is **not up for redesign**.

## How the colour system is built

Colour is derived, not enumerated. Three base variables drive nearly everything
through `color-mix`, which is why the theme stays coherent when one base moves:

| Base | Role |
|---|---|
| `--background-base` | The obsidian canvas. |
| `--midground-base` | The foreground/ink base; mixed into the canvas to make every raised surface. |
| `--foreground-*` | Text ink. |

Depth is **percentage steps of `--midground-base` mixed into the canvas** —
that is the "layered obsidian" the spec describes, expressed as arithmetic:

| Step | Token | Mix |
|---|---|---|
| Card / popover | `--color-card`, `--color-popover` | 4% |
| Secondary surface | `--color-secondary` | 6% |
| Muted surface | `--color-muted` | 8% |
| Accent surface | `--color-accent` | 10% |
| Border / input | `--color-border`, `--color-input` | 15% (into transparent) |

**Gold is `--midground` / `--color-primary`.** It is an accent: the primary
action, the active state, and the one number that matters. A surface where
everything is gold is a surface where nothing is.

Semantic status colours are literal because they must not drift with the theme:
`--color-success` `#4ade80`, `--color-warning` `#ffbd38`,
`--color-destructive` `#fb2c36`.

Text ramp: `--color-text-secondary`, `--color-text-tertiary` (plus
`--color-foreground`). Data-series accents (`--series-input-token` etc.) exist
for charts so analytics never invents colours.

## Emphasis — what gold is for

The on-machine review found gold on "almost every label, nav item, border, and
action, so it no longer indicates the one thing that matters." That is the
failure the palette exists to avoid. The rule, in priority order:

**Gold (`--midground` / `--color-primary`) is permitted for exactly three things
per surface:**

1. **The primary action** — one per surface. Secondary actions are `ghost`.
2. **The active state** — the current nav item, the selected tab, focus rings.
3. **The one number that matters** — not every number. The one.

**Everything else uses the text ramp:** `--color-foreground` for body,
`--color-text-secondary` for supporting copy, `--color-text-tertiary` for
metadata. A heading is not gold. A label is not gold. A border is not gold —
borders are `current/10`–`current/20`.

Low-opacity `bg-midground/[0.02–0.10]` is **not** an emphasis use — that is the
surface-depth arithmetic above, and it is correct.

A quick census of full-opacity gold text:

```bash
grep -rEoh "text-(primary|midground)\b" web/src/{components,pages,blocks,capabilities} | wc -l
```

Treat a rising number as a regression in emphasis discipline. When adding gold,
the question is not "does this look important" but "is this *the* one".

### The ghost-button trap

`Button` takes a **`ghost` boolean**, not `variant="ghost"`. The variant form is
silently ignored, so the button renders as a gold primary — two quiet controls
shipped that way before the live review caught it. If a secondary button looks
gold, this is why.

## Type

| Token | Value |
|---|---|
| `--theme-font-sans` | system-ui stack (self-hosted; no CDN) |
| `--theme-font-mono` | ui-monospace stack — logs, code, tokens, JSON |
| `--theme-font-display` | currently aliases sans |
| `--theme-base-size` | `15px` |
| **minimum text size** | **`text-xs` (0.75rem ≈ 11px).** Never smaller. |
| `--theme-line-height` | `1.55` |
| `--theme-letter-spacing` | `0` |

Consume as `--font-sans` / `--font-mono`. Density is themeable via
`--theme-spacing-mul` and `--theme-density`.

## Radius

`--radius: 0.5rem` is the root; `--radius-sm/md/lg/xl` derive from
`--theme-radius` by arithmetic. Never write a raw `border-radius`.

## Motion (Part 10, complete)

One spring curve and one ease-out, reused everywhere. Durations are banded by
**why** something moved — motion is *caused*.

| Token | Value | Use |
|---|---|---|
| `--ease-spring` | `cubic-bezier(0.22, 1, 0.36, 1)` | anything that travels |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | in-place change |
| `--motion-micro` | `100ms` | press, checkbox, icon swap (80–120 band) |
| `--motion-state` | `160ms` | hover, selection, colour, badges (120–200) |
| `--motion-move` | `240ms` | FLIP, reorder, stage change (200–280) |
| `--motion-panel` | `280ms` | panels, sheets, drawers, modals (240–320) |
| `--motion-route` | `260ms` | route / view transitions (240–300) |

Prefer the **composite shorthands** so a duration can never be paired with the
wrong easing: `--transition-micro`, `--transition-state`, `--transition-move`,
`--transition-panel`.

```css
transition: transform var(--transition-move);
```

In Tailwind, reach for the token rather than a literal:

```tsx
className="transition-transform duration-[var(--motion-panel)] ease-[var(--ease-spring)]"
```

### Discipline (enforced in review)

- **Never `transition-all`.** Name the properties. Animating every
  layout-triggering property at once is the rule this exists to prevent.
- Prefer `transform` and `opacity`; animate at most one layout property.
- Never animate on every render, and never animate a number that changed because
  the user navigated.
- Nothing loops for atmosphere. The single permitted continuous motion is an
  indicator of genuinely ongoing work.

### The catalogue — the motion you actually see

Tokens are the timing; these are the animations. **The app is meant to look
rich.** Accessibility is delivered by making each one degrade to an instant,
information-complete state change — not by making the app austere. Use them.

| Class / helper | Fires when | Feel |
|---|---|---|
| `.motion-enter` | a row arrives | fades in, rises 4px |
| `.motion-exit` | a row leaves | fades, list closes rather than snaps |
| `.motion-live` | a push updated this row | warms toward gold 8%, decays over 800ms |
| `.motion-pending` | optimistic write in flight | 70% opacity + gold inset edge; `data-settled="true"` settles it |
| `.motion-flip` | a card advances a stage / reorders | physically travels to its new position |
| `.motion-morph` | a card opens into detail | shared-element transform + opacity |
| `.motion-working` | genuinely ongoing work | the one permitted continuous motion |

JS-driven motion lives in `web/src/lib/motion.ts` (pure, unit-tested):

- `staggerDelay(i)` — batch entrances cascade 30ms apart, **capped at 6** so a
  long list never reads as slow.
- `shouldAnimateValue(from, to, { sameContext })` — counts a number only when
  the delta is meaningful *and* the change wasn't caused by navigation.
- `countValue(from, to, t)` — the eased value while counting.
- `flipDelta` / `flipTransform` / `isFlipWorthAnimating` — FLIP, skipping
  animation when nothing meaningfully moved.
- `prefersReducedMotion()` — honours **both** the OS and in-app settings, so
  JS-driven motion can never animate while CSS motion is off.

### Reduced motion

Two independent paths, both collapsing motion to ~0ms with **zero loss of
information or function**:

- `html[data-motion="reduced"]` — the in-app preference.
- `@media (prefers-reduced-motion: reduce)` — the OS preference, honoured
  without the user opening settings.

Because both are global `!important` rules, **components never branch on the
preference themselves.**

### The text-size floor

Nothing below `text-xs`. At a 15px base, an arbitrary `text-[0.65rem]` renders
at **9.75px** — unreadable for a low-vision user, and the review flagged exactly
this ("many controls and secondary labels are small and low-contrast"). 28 such
instances were raised to the floor. Audit with:

```bash
grep -rE "text-\[0\.[0-6][0-9]*rem\]" web/src   # any hit is a bug
```

## Conformance status

Audited across `components/`, `pages/`, `blocks/`, `capabilities/`:

- Zero hardcoded `duration-[Xms]` values.
- `transition-colors` (37 uses) is the dominant transition — correct for state
  change.
- The three off-token cases found were fixed: two `transition-all` (Jobs progress
  bar, Models usage bar) scoped to their real properties, and a hardcoded
  `duration-300`/`duration-200` moved onto the bands.

Re-run the audit with:

```bash
grep -rEoh "transition-all|duration-[0-9]+" web/src/{components,pages,blocks,capabilities}
```

Any hit is a conformance bug.
