# Expoline v0.1 — "unstoppable demo"

A working restaurant POS web app, seeded for **Bali Hai Restaurant** (San Diego).
One command to run: `npm install && npm start` → http://localhost:4317

## Quick start

```bash
cd build/expoline
npm install
npm start
```

- Node ≥ 22.5 required (uses built-in `node:sqlite` — zero native dependencies).
- First boot auto-seeds `db/expoline.db` (SQLite, WAL mode) with the full Bali Hai
  menu, 4 zones / 147 tables, demo users, and sample closed checks.
- Demo PINs: **server 1111** · **kitchen 2222** · **manager 2580**

## Architecture

```
Browser (PWA, vanilla JS) ──HTTPS/HTTP──▶ Express :4317 ──▶ SQLite (WAL)
        │                                    │
        │ IndexedDB outbox                   │ WebSocket /ws
        │ (offline queue)                    │ (live KDS push)
        ▼                                    ▼
  "OFFLINE — N queued" banner          KDS stations: bar / expediter /
                                       garde_manger / dessert
```

- **Backend** (`server.js`, ~1100 lines): Express + `ws` + `node:sqlite`.
  All money math is integer cents, computed server-side on every mutation —
  the client never decides a total.
- **Frontend** (`public/`, vanilla JS/CSS, no build step): hash-routed SPA,
  PWA manifest + service worker (app shell cached; API always network).
- **Seed** (`db/schema.sql`, `db/seed.js`): idempotent; `node db/seed.js`
  rebuilds the database from scratch.

## Money math (server-side, single source of truth)

```
subtotal       = Σ billable lines (held + sent; cancelled excluded)
surcharge      = round(subtotal × 5%)            ← every check
service_charge = guest_count ≥ 8 ? round(subtotal × 18%) : 0   ← single check enforced
tax            = round((subtotal + surcharge) × 7.75%)  ← tips NEVER taxed; svc charge not taxed (demo)
total          = subtotal + surcharge + service_charge + tax
balance        = total − Σ(amount − refunded)
```

**Finance honesty** (`GET /api/finance/payouts?date=`):
`expected_payout = card_volume − refunds − stripe_fees`, shown as line-by-line
math. Every fee is named (demo Stripe rate: 2.6% + $0.15/transaction). Tips are
shown separately and labeled "tips are not taxed". Sales date and payout date
(payout = sales date + 2 days, configurable) are distinct columns. There is no
"Other" fee bucket.

## Locked rules — enforced server-side, not just in the UI

1. **Hold+Send only.** There is no Stay / Release / Quick Send anywhere —
   not in the UI, not in the API.
2. **Drinks never hold food.** On send, drink items route to the **bar**
   station ticket immediately; food routes to expediter / garde_manger /
   dessert by item.
3. **Seat-first ordering.** Split flows: even split, split-by-seat,
   move-items-to-new-check. Splits are rejected on checks carrying the 18%
   large-party service charge (single check enforced).
4. **Roles enforced in the API** (`requireRole` middleware → 403):
   servers cannot list KDS tickets or bump; kitchen cannot open
   `/api/finance/*`; refunds are manager-only. 401 without a token.
5. **Multi-site schema**: every table carries `site_id` (seeded: `bali-hai`).

## Offline story — what's real vs. what's architecture

**Real in v0.1:** the frontend has an IndexedDB outbox. When offline
(`navigator.onLine` false **or** the "Offline demo" kill-switch in the header),
order mutations (open check, add items, void, send, payments incl. card,
close) queue locally with an amber **"OFFLINE — N orders queued"** banner;
on reconnect they flush oldest-first with temp-ID remapping. Cash payments
always work. Card payments are **simulated** store-and-forward (clearly
labeled DEMO — no real processor, no real keys).

**Architecture (documented, phase 2):** the production offline ladder is
LAN site brain → cellular failover → Bluetooth backup → local queue, with
real Stripe Terminal store-and-forward for cards. v0.1 demonstrates the
local-queue stage and the UX contract (banner, queue count, ordered flush);
LAN sync between devices is not yet implemented. We do not claim otherwise.

## API surface (all :4317, Bearer token except /api/health)

Auth: `POST /api/auth/login` · Config/menu/zones: `GET /api/config|menu|zones`
Checks: `POST /api/checks`, `GET /api/checks/open`, `GET /api/checks/:id`,
`POST /api/checks/:id/items`, `DELETE …/items/:item_id`,
`POST …/send`, `POST …/split`, `POST …/payments`, `POST …/close`
KDS: `GET /api/kds/tickets`, `POST /api/kds/tickets/:id/bump`, `GET /api/kds/recall`
Manager: `GET /api/finance/payouts`, `GET /api/finance/shift`,
`GET /api/manager/overview`, `POST /api/payments/:id/refund`
WebSocket: `/ws?token=` → `{action:'subscribe',channel:'kds',station}` →
`{type:'ticket'|'ticket_updated', ticket}`

## Known limitations (honest)

- Card processing is 100% simulated; no Stripe keys, no real charges.
- No menu editing UI (read-only menu viewer); 86'd items not implemented.
- No void/comp flow for already-sent items (held items can be voided).
- Single-site demo; multi-site isolation is schema-level only.
- PINs are demo-grade (in-memory token sessions, no hashing/rotation).
- Tax rate, surcharge, and fee rates are configurable in `site_config`
  but edited via DB, not UI.
