# Expoline Design System — "Harbor Luxe"

**Status: v0.1 color pass (2026-09-26).** Pure visual restyle of `public/styles.css` only.
No layout, functionality, or API changes. This document records the research,
the palette, the contrast math, and the honest limitations.

## Why this wins

1. **Environment-matched surfaces.** Dim bars and night kitchens get a deep
   harbor-ink dark theme (low glare, easy on night vision, what competitors'
   generic light UIs fail at). Sunlit patios keep readability because body
   text holds 14.9:1 and muted text 7.3:1 against the background — far above
   WCAG AA.
2. **Status owns color; everything else stays quiet.** Only six semantic hues
   exist in the product (sky, amber, brass, vermillion-red, emerald, yellow).
   Food categories, zones, and prices never take a status hue, so a color
   always means exactly one thing. Competitors scatter color; Expoline rations it.
3. **Colorblind-safe by construction.** The riskiest axis in POS (red vs green
   for paid/void) is neutralized three ways: hues are Okabe–Ito-informed with
   strong luminance separation, and **every status carries an icon + text
   label + border cue — never color alone** (CUD guidance).
4. **Premium identity.** Deep ink navy + champagne brass is the established
   visual language of luxury hospitality (the Jumeirah / St. Regis / waterfront
   register) — it reads "upscale restaurant," not "enterprise SaaS."
5. **Attention is budgeted.** Saturated color appears only on operational
   states (new ticket, held, overdue, offline). The default working state is
   quiet brass/neutral, so nothing screams during a rush except what needs
   action.

## Palette (all on dark, all AA-verified)

| Token | Hex | Role | Contrast (measured) |
|---|---|---|---|
| `--ink` | `#0e1420` | app background | — |
| `--ink-2` / `--ink-3` / `--ink-4` | `#141b2b` / `#1b2438` / `#232f4a` | raised surfaces / cards / hover | — |
| `--text` | `#ece7db` | body text | **14.9:1** on bg |
| `--text-dim` | `#a8a294` | secondary text | **7.3:1** on bg |
| `--text-faint` | `#99947f` | faintest allowed (hints, notes) | **6.1:1** on bg |
| `--brass` / `--brass-hi` | `#c9a86a` / `#e3c78e` | brand accent, primary actions, prices | 8.2 / 11.3:1 on bg |
| `--green` | `#3ed598` | DONE / PAID / SENT / SYNCED | 9.2:1 on surface, **6.6:1** in pill |
| `--amber` | `#e0a93e` | HELD / pending / aging | 8.1:1 on surface, **5.2:1** in pill |
| `--red` | `#ec6f6f` | OVERDUE / ERROR / VOID | 5.8:1 on surface, **4.8:1** in pill |
| `--sky` | `#63b3ed` | NEW arrivals (KDS) | 8.1:1 on bg, **5.3:1** in badge |
| `--yellow` | `#f0e442` | OFFLINE banner (solid, ink text) | **13.2:1** |

Body text target: ≥ 4.5:1. UI boundaries / large text: ≥ 3:1 where applicable.
All measured with relative-luminance math, not eyeballing.

## Status semantics (the six hues — nothing else may use them)

| Meaning | Hue | Non-color cue (always present) |
|---|---|---|
| NEW (KDS ticket) | sky blue `#63b3ed` | `● NEW` badge with border |
| HELD | amber `#e0a93e` | `⏸ HELD` pill with border |
| IN PROGRESS (working state) | quiet brass `#e3c78e` | `▶` prefix + text label |
| OVERDUE / ERROR / VOID | red `#ec6f6f` | `⚠` / `✕` + text label + pulsing red border on overdue tickets |
| DONE / PAID / SENT / SYNCED | emerald `#3ed598` | `✓` + text label |
| OFFLINE | solid yellow `#f0e442`, ink text | full-width banner + queue count text |

Key fix this pass: KDS `NEW` was amber — identical to `HELD`. It is now
sky blue, so "just arrived" and "waiting on server" can never be confused,
including by colorblind users (blue vs amber is safe under all common CVD).
The offline banner was also amber-on-dark; it is now solid yellow so it
cannot be mistaken for a held item.

## Research basis

- Dark interfaces preferred in dim environments; positive-polarity
  dark-on-light has a readability edge in bright conditions → keep the
  ink theme for KDS/bar/night, and plan a daylight/high-contrast mode for
  patio-daylight server use (see Limitations).
- Warm red/orange used broadly becomes visually irritating over long
  shifts → saturated hues are reserved for operational status only; the
  default state is quiet.
- Red/green is the riskiest status axis for color vision deficiency →
  Okabe–Ito-informed hues with strong luminance separation, plus mandatory
  icon + text + border cues on every status (Color Universal Design).
- Navy communicates trust/calm/reliability; restrained brass/gold
  communicates warmth and premium quality → Harbor Luxe identity.
- References: WCAG menu/display contrast guidance (aiscreen.io), dark-mode
  low-light research (NSF PAR 10275736), CUD / Okabe–Ito palette reference,
  IdealPOS POS screen setup guidance, Keylime dark-mode legibility notes.

## What changed in this pass (files)

- `public/styles.css` only:
  - `:root` tokens: brightened `--green`/`--red` and their pill tints for AA,
    lifted `--text-faint` `#6f6c62` → `#99947f` (was 3.5:1, now 6.1:1),
    added `--sky` / `--sky-dim` / `--yellow` tokens, documented the status
    contract in the header comment.
  - KDS `.t-status.new` → sky badge with `●` icon; `.in_progress` gets `▶`,
    `.fulfilled` gets `✓`; overdue tickets get `⚠` status + pulsing red border.
  - Pills gain `::before` icons: `⏸ HELD`, `✓ SENT/PAID`, `○ STAGED`, `✕ VOID`.
  - Offline banner → solid `--yellow` with ink text (was amber, collided
    with HELD).
  - `.tab` anchors: added `text-decoration: none` (manager tabs were showing
    browser-default underlines).
- Screenshots (post-change): `qa/screenshots/design-v1/01-login.png` through
  `08-offline.png` — login, floor, order pad, pay, KDS, manager overview,
  finance, offline banner.

## Honest limitations / future work

1. **No daylight mode yet.** The ink theme is optimal for dim bar/kitchen/
   night use. For harsh patio sunlight, positive-polarity (dark-on-light)
   text has a measured readability advantage — a daylight/high-contrast
   theme toggle is the recommended next visual investment, not forcing the
   dark palette everywhere.
2. **Red vs vermillion adjacency.** OVERDUE and ERROR/VOID both live in the
   red family; they are distinguished by label, icon, and context (KDS timer
   vs toast/pill), and luminance differs, but a future pass could give RUSH
   its own vermillion `#E4572E` treatment if operations demand it.
3. **Pre-existing copy defect (not introduced here):** Finance shows
   "− Stripe fees *no fee breakdown returned by API*" when a day has no card
   payments — reads like an error message. Recommend replacing with
   "No card payments this day" (copy change, flagged for builder team).
4. **Seed data nit:** menu category tabs show "Pupus" twice (lunch + dinner
   category merge in seed data). Data issue, not visual; flagged.
5. Contrast ratios were computed mathematically; a physical-device check
   (sunlit patio tablet, dim bar phone) is still recommended before pilot.
