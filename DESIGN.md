# Lever — Design System

Source of truth for all UI in this repo. Every screen, component, and copy change must follow this
document; when something isn't covered here, extend this file first, then implement.

Reference implementation: the "Lever" prototype — `docs/lever-prototype.html` in this repo (also
published as a private artifact:
`https://claude.ai/code/artifact/de01ae86-3d92-4cf9-8df4-9aa9f305bd14`). This document supersedes
the current arcade-styled UI ("Price Arena" / command-deck look), which is being replaced.

"Lever" is the working brand name; final naming is still open (see workspace TODO). The design
does not depend on the name.

## 1. Product stance

Lever is a **leveraged prediction app that looks and feels like a consumer trading app** —
Robinhood-calm, not casino-loud. The mechanic is playful (10-second, 1000× up/down positions);
the interface earns trust by staying quiet, legible, and honest about the numbers.

The mechanics the UI must express (see `../plans/leveraged-prediction/frontend-ux.md` for the full
interaction contract — that document's states, copy table, and comprehension gates still bind):

- One market at a time (e.g. BTC/USD), streamed live with visible feed freshness.
- A play = direction (Up/Down) + stake ($1–$1,000, presets $5/$10/$25), at 1000× sensitivity.
- Plays settle **automatically at whatever the price is 10 seconds after open** (crank-driven).
  There is **no liquidation and no early close** — never imply one. After expiry a settlement
  sample may take up to 10 more seconds (**Settling**); past that buffer the stake is **Refunded**.
  Never show an expired-but-unsettled play as lost; a refund is neutral, never a win.
- Loss is floored at the stake. Profit is capped at the stake and pays a 10% fee: max return is
  1.9× stake ("max profit +$9.00 after fee" on a $10 play). Live P&L is labeled **Estimate**
  until settlement is final.
- Up to 8 concurrent positions; the market also caps at 8 active.
- A mandatory one-hour session (user-chosen USDC allowance) makes plays one-tap; session limit and
  buying power live in the navbar next to the wallet. Buying power is the routed ER balance only:
  base-layer funds never appear as buying power before the user deposits them into the arena.

## 2. Design principles

1. **Color only when money moves.** The chrome is monochrome (ink on warm white / warm dark).
   Green and red are reserved exclusively for direction, P&L, and price movement. No decorative
   accent color exists. If an element isn't about money moving, it doesn't get color.
2. **The chart is the hero.** It fills the available space; everything else is quiet furniture
   around it. Never crowd it with widgets.
3. **Numbers are the interface.** Big, tabular, precise. Prices to 3 decimals, money to 2,
   percentages to 1. Never let ticking digits jiggle layout (`font-variant-numeric: tabular-nums`).
4. **Honest microcopy.** Say exactly what happens, in the user's terms: "settles at whatever the
   price is in 10 seconds", "you can never lose more than your stake". No hype, no apologies,
   sentence case everywhere (buttons included).
5. **Calm motion.** Live things tick and drain (price, countdown bars); nothing else animates.
   Respect `prefers-reduced-motion`.

## 3. Tokens

Defined as CSS custom properties on `:root`. Both themes ship first-class; light is default,
dark follows `prefers-color-scheme` and an explicit `data-theme` override wins in both directions.

| Token          | Light                  | Dark                    | Role                                   |
|----------------|------------------------|-------------------------|----------------------------------------|
| `--bg`         | `#fafaf8`              | `#131417`               | Page ground (warm-biased, never pure)  |
| `--card`       | `#ffffff`              | `#1a1b1f`               | Cards, pills, inputs                   |
| `--ink`        | `#17181c`              | `#f0efec`               | Primary text, solid buttons            |
| `--mut`        | `#6e7076`              | `#9b9c9f`               | Secondary text, labels                 |
| `--hair`       | `#e8e7e3`              | `#26272b`               | Hairline borders, dividers, tracks     |
| `--up`         | `#00a862`              | `#2bd186`               | Up direction, gains, price above ref   |
| `--down`       | `#e5484d`              | `#ff6b6e`               | Down direction, losses, price below ref|
| `--wait`       | `#b45309`              | `#f5a623`               | Waiting/degraded: settling, stale feed |
| `--up-tint`    | `rgba(0,168,98,.09)`   | `rgba(43,209,134,.1)`   | Up chip/segment backgrounds            |
| `--down-tint`  | `rgba(229,72,77,.09)`  | `rgba(255,107,110,.1)`  | Down chip/segment backgrounds          |
| `--wait-tint`  | `rgba(180,83,9,.1)`    | `rgba(245,166,35,.12)`  | Waiting/degraded backgrounds           |

Rules:

- No other colors. White text on `--up`/`--down` solids is allowed (CTAs).
- Semantic green/red is not an accent — don't use it for focus rings, links, or branding.
- `--wait` (amber) is reserved for in-between and degraded states: settling/refunding plays, stale
  feed, blocked-action notices. Color never carries status alone — pair it with a label.
- Focus rings are `2px solid var(--ink)`, offset 2px.

## 4. Typography

- **Family**: Figtree (variable, 300–900) everywhere. Load via `next/font/google` with
  `display: swap`. Fallback `system-ui, sans-serif`. No monospace anywhere in the product UI.
- **Numerals**: `font-variant-numeric: tabular-nums` on every element that displays a number
  (class `.num` in the prototype). Figtree ships `tnum` — verified.
- **Wordmark**: `lever`, lowercase, weight 800, letter-spacing −0.4px, in `--ink`. Never colored.

Scale (desktop / mobile):

| Role                  | Size          | Weight | Notes                            |
|-----------------------|---------------|--------|----------------------------------|
| Big price             | 44px / 36px   | 700    | letter-spacing −1px, line-height 1.1 |
| Section h2            | 13px          | 700    | uppercase, letter-spacing 0.6px, `--mut` |
| Body / row primary    | 14.5–15px     | 600–700| sentence case                    |
| Secondary / meta      | 12–13px       | 600    | `--mut`                          |
| CTA label             | 16px          | 700    |                                  |
| Change / chg line     | 14px          | 600    | colored by sign                  |

## 5. Layout

Navbar is always present: wordmark left; right side = buying power (label over amount,
right-aligned) + wallet pill (hairline border, green 7px status dot, compact address `7xKp…9fQ4`).
Buying power renders as unavailable, never as the base-layer token balance, until the user's
collateral account is present on the routed ER.
Navbar is sticky, `--bg` with a `--hair` bottom border. On <560px, hide the buying-power block
(wallet pill stays).

**Mobile (default)**: single centered column, max-width 680px, 20px side padding, 24px vertical
gap, in order: quote (eyebrow `Solana · SOL-USD`, big price, change line) → chart (260px tall) →
ticket → positions. Page scrolls normally.

**Desktop (≥1000px)**: full-bleed two-column grid, `minmax(0,1fr) 400px`, 36px column gap,
height `calc(100dvh − navbar)`:

- Left ("stage"): quote on top, chart fills all remaining height.
- Right ("rail"): ticket, then positions; rail scrolls internally if needed.
- Implemented with `display: contents` wrappers so the mobile DOM is untouched.

Radii: cards 16px, buttons/inputs 10–12px, pills 999px, chips 10px. Spacing unit 4px; card
padding 20px; row padding 14px vertical with `--hair` bottom borders.

## 6. Components

### Quote header
Eyebrow row: market label (13px, `--mut`) + feed pill — `Live · 0.4s` (`--up-tint`),
`Delayed · last update 7s ago` (`--wait-tint`), or `Offline` (`--down-tint`), always dot + label.
Below: big price (2 decimals for BTC-scale, tabular) → change line `▼ $2.65 (0.004%) · last 40s`,
colored by sign over the visible chart window.

### Chart (canvas, Pixi)
- The chart is presentation-only: drag pans, a `↪ Return to live` pill restores follow; no gesture
  or click ever trades. Fixed 40-second window (−20s … +20s around "now") with five time labels;
  price axis labels on the left gutter. Both label sets are `--mut`, 11px.
- Faint gridlines in `--hair` (70% alpha) — they carry the time/price reading, keep them quiet.
- Price path: **monochrome `--ink` line, 2px**, with a 5%-alpha ink fill under it. Color is
  reserved for positions — the line itself is never green/red.
- Live marker: ink dot (3.5px + soft halo) at "now" plus a `--mut` horizontal reference line.
  Display price eases toward the latest tick.
- **Per open play**: a horizontal entry line at 85% alpha in the play's direction color, drawn
  from open time to expiry, ending in an expiry ring marker. While settling/refunding the line
  turns `--wait` at 50% alpha. This is the win/lose reference the player watches.
- Theme-aware: canvas colors are read from the CSS tokens (re-read ~every 500ms so a theme switch
  propagates). DPR-aware sizing.

### Ticket (card)
1. Stake field: label `Play amount`, `$` input (17px bold) + preset pills `$5 $10 $25`; active
   preset inverts to `--ink` bg / `--bg` text. Range $1–$1,000.
2. Economics line (12.5px `--mut`, live-updating): `10 sec · 1000× sensitivity — max profit
   +$9.00 after fee, max loss −$10.00.` Max profit/loss must be visible before the tap.
3. Direction buttons: **one-tap** `▲ Play up` / `▼ Play down`, side by side, ≥64px tall, solid
   `--up`/`--down` with white text. Supporting copy ("Price at settlement above/below entry")
   lives in `title`/screen-reader text, not the label. Both disable together whenever any gate
   fails (no wallet, no session allowance, insufficient balance, stale feed, close-only market,
   capacity, in-flight intent).
4. Blocked/status notices render below the buttons as `--wait-tint` rounded rows stating exactly
   what to fix (`You need $10.00 USDC to play`, `Market full · 8 active positions`), with a
   `Check status` action when an ambiguous transaction needs probing.

### Positions (list)
Section h2 `POSITIONS` with a `n/8` capacity counter. Rows, nearest expiry first:

- Chip: 36px rounded square, direction tint + `▲`/`▼`; turns `--wait-tint` while settling.
- Row: `Up · $10.00 stake` over `<status> · Entry $65,378 · 6.4s`, with a 3px progress bar
  (`--ink`, `--wait` when settling) tracking open → expiry.
- Status words: `Submitting / In play / Settling / Refunding / Won / Lost / Refunded` — sentence
  case; settling/refunding in `--wait`, won `--up`, lost `--down`.
- Right side: live **Estimate** (colored, signed) until final, then **Payout** (neutral value).
  `Payout ready · $X` chip when a fallback claim exists, plus the protected-payout claim card
  above the list when escrow is funded.
- Empty state: `No positions yet — choose an amount, then play up or down.`
- Footer note: `Results stay neutral until settlement is final.`

### Wallet & session
Wallet pill opens the wallet adapter modal when disconnected; connected state shows the dot +
compact address. Buying power reflects only the routed ER token balance and updates on
deposit/open/settle. Before the first ER deposit, do not substitute or reveal the base-layer token
balance as buying power.
Session-gate and faucet flows adopt this same visual language (cards, hairlines, ink CTAs) —
no bespoke styling. An inactive session never obscures the market by itself. The setup dialog opens
only after the user expresses intent by pressing `Play up`, `Play down`, or the inactive session
control in the navbar; dismissing it returns to the fully visible market. The navbar always pairs
session state with text (`Session active` or `Session inactive`) rather than color alone. The inactive
state is actionable and routes to Trade before opening setup when selected from another primary page.
Session setup has exactly two visible steps that match transaction routing:

1. `Deposit to arena · Base network` groups Session V2 creation, durable account preparation, and
   the collateral deposit/delegation into the single base-layer wallet transaction.
2. `Activate session · MagicBlock ER` approves the one-hour token allowance in the single ER wallet
   transaction.

The dialog may show detailed progress copy inside the active step, but it must not expand the flow
into more than these two steps. Before Step 1 reaches the ER, show explanatory copy instead of a
numeric balance. Afterward, label the amount `Arena balance`.
Devnet funding reports SOL and test-USDC outcomes independently. If test USDC is minted but the SOL
airdrop fails, preserve the successful mint and show
`SOL airdrop failed · $X test USDC minted` with a `Get devnet SOL from Solana faucet` link. Treat this
as a partial-success warning rather than discarding the successful mint or presenting a generic
failure. Faucet feedback must not expose the combined or base-layer balance before deposit; update
and display an amount as buying power only when the ER balance exists.

## 7. Motion

- Price line/dot movement and countdown bars: continuous (rAF), no easing curves needed beyond
  the price/scale lerp.
- State changes (notices, rows appearing): instant swap; no slides, fades, or confetti.
- Allowed micro-interaction: CTA hover `filter: brightness(1.06)`; live-dot pulse ≤1.4s opacity
  blink. Both disabled under `prefers-reduced-motion`.
- Direction buttons do not trigger haptics. Their press, session prompt, and transaction status are
  communicated visually and through accessible status text.

## 8. Copy voice

- Sentence case everywhere, including buttons and section labels (`POSITIONS` h2 is a styled
  uppercase, the source text stays "Positions").
- Verbs state exactly what happens: "Open Up position", "Position settled". The action keeps its
  name across the flow (open → opened; settle → settled).
- Numbers in copy are formatted like the UI (`$25.00`, `$25,000.00`, `$195.600`).
- Errors: what went wrong + how to fix, no apology, no jargon. Empty states invite the action.
- Never say: liquidation, bust, margin call, "closed early", or anything implying the position
  can end before 10s.

## 9. Accessibility & quality bar

- All interactive elements are real `<button>`/`<input>` with visible `:focus-visible` rings.
- Direction segments use `aria-pressed`; notices render in an `aria-live="polite"` region.
- Color is never the only signal: direction always pairs color with `▲`/`▼`, P&L with a sign.
- Contrast: body text ≥ 4.5:1 on `--bg`/`--card` in both themes (the token set satisfies this).
- Layout holds from 320px width up; the page body never scrolls horizontally.

## 10. Implementation notes for the revamp

- Tokens live in `app/globals.css` as the custom-property block from §3 (media query + explicit
  `data-theme` overrides). Components style through tokens only — no hardcoded hexes.
- Font: `next/font/google` Figtree; remove any arcade/monospace faces from the product UI.
- Existing component mapping: `game-arena` → page shell/layout, `price-arena` → chart,
  `command-deck` → ticket, `your-plays` → positions, `session-gate` → gate card in the same
  language. Keep hooks (`use-game-snapshot`, `use-play-transaction`, `use-game-session`,
  `use-devnet-faucet`) unchanged; this is a presentation-layer revamp.
- The prototype (`docs/lever-prototype.html`) is the visual spec; where this doc and the prototype
  disagree, update this doc deliberately rather than drifting.

## 11. Liquidity page

The liquidity page lives at `/liquidity`; `Trade` and `Liquidity` text links sit beside the wordmark
in the shared navbar. The active route uses `--ink`; the inactive route uses `--mut`. Links do not
use direction colors.

The page is a centered desktop canvas (`max-width: 1040px`) and a single mobile column. Its order is:
intro → portfolio metrics → add/remove card → market details. Use the same 20px page gutters, 16px
card radius, `--hair` borders, and quiet typography as the trade page.

### Portfolio metrics

- Heading: `Your liquidity`; supporting copy explains that LP value changes with trader outcomes
  and earned fees.
- Three equal metric cells on desktop and a stacked/grid layout on mobile:
  `Shares`, `Current value`, and `Deposited`.
- Shares are the exact on-chain integer with grouping separators. Current value is the shares'
  pro-rata claim on current pool USDC, formatted to two decimals.
- Deposited is the remaining cost basis reconstructed from the indexer's complete liquidity-event
  history. Deposits add their asset amount; executed removals reduce cost basis in proportion to the
  shares burned. Only show the value when the indexed share total matches the current on-chain share
  total; otherwise render `Syncing` rather than infer deposited principal from current share value.
- Market mode, active positions, total shares, and pool balance use a fresh indexer market summary
  when that field is present. Missing, stale, or unavailable indexed fields fall back to validated
  live contract state so liquidity actions remain usable. Wallet balance, pending withdrawals,
  liquidity-account routing, and the authoritative user-share balance always come from live state.
- The page is its own vertical scroll container beneath the sticky navbar. Its content must remain
  reachable at desktop and mobile viewport heights even though the shared trade shell is fixed to
  `100dvh`.

### Add/remove card

- A two-segment neutral control switches between `Add` and `Remove`; its selected state inverts to
  `--ink`/`--bg`. Green and red are not used for the tabs or CTA.
- Add accepts a USDC amount and shows the estimated shares received. Remove accepts a USDC amount,
  offers `25% / 50% / Max` presets, and shows shares burned plus expected USDC received.
- The primary button is a full-width neutral ink CTA: `Add liquidity` or `Remove liquidity`.
- First use may require one additional wallet signature to create and route the user's liquidity
  tracking account. Explain this before the action; progress copy distinguishes account preparation,
  token routing, wallet approval, and confirmation.
- Removal presents one user action and one ER wallet signature containing both
  `request_withdrawal` and `execute_withdrawal`. If the account already contains a pending request,
  block a new removal and explain that recovery is required.
- Deposits and withdrawals are disabled while the market has active risk. State this as
  `Liquidity changes resume when all open positions settle.` Close-only mode also disables deposits.
- Quotes state `Estimated` and use a 0.5% minimum-output guard. Refresh values after confirmation.

### Market details

Show `Pool liquidity`, `Your pool share`, `Total LP shares`, and `Market status` as quiet rows.
Market status is `Available` only when there are no active positions and deposits are permitted;
otherwise use `Positions settling` or `Deposits paused`. Status color, when used, must be paired with
the text.

The wallet control, loading/error treatment, focus states, tabular numerals, reduced-motion support,
and 320px minimum-width quality bar are identical to the trade page.

## 12. Brand mark and favicon

The wordmark remains lowercase `lever`, but it is paired with a compact neutral icon: a diagonal
lever bar resting on a triangular fulcrum inside a rounded square. The mark is monochrome and never
uses direction colors. The same geometry supplies the browser favicon so the navbar and tab remain
visually connected. At narrow widths the wordmark may hide while the icon remains.

## 13. Leaderboard page

The leaderboard lives at `/leaderboard` and is the third primary route beside `Trade` and
`Liquidity`. It follows the liquidity page’s centered `1040px` canvas, navbar, card borders, and
mobile single-column behavior.

The top section contains the page title and a prominent `Total volume` metric. Below it, a
connected-wallet summary shows the user’s volume, trade count, wins, and losses. The rankings table
uses the columns `Rank`, `Trader`, `Volume`, `Trades`, `Wins`, and `Losses`, ordered by settled
performance (net P&L first, with volume as the first tie-breaker) as reported by the indexer.

All leaderboard values are historical facts and therefore come from the indexer rather than current
account state. `Total volume` is the sum of indexed all-time volume across every fetched leaderboard
page; if the complete result cannot be established, show it as unavailable instead of presenting a
partial total. Until that datasource is connected, render em dashes and an explicit `Indexer
connection pending` state; never synthesize rankings from open positions or fixture data. Wallet
addresses use the standard compact form, and win/loss labels may use semantic green/red only when
real values exist.
