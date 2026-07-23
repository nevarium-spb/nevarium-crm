---
status: ACTIVE
revision: 2
---
# Spec: Невариум CRM v2 — hosted, /crm module + API

Revised 2026-07-10 after user pivot (D17): **hosted, accessible from anywhere** — supersedes the local-first architecture (revision 1, preserved in git history and in ~/.gstack/projects/nevarium-crm-design-a99bd4/).
Branch: claude/nevarium-crm-design-a99bd4
Reviews: /office-hours ✅ · /plan-ceo-review ✅ (SELECTIVE EXPANSION) · outside voice ✅ · /plan-eng-review in progress

## Problem

Невариум Лаб ИИ collects leads via the /start form and the «Нева» chat — both currently write only to the visitor's own localStorage (`nv_leads`), so no lead ever reaches the team. Client work is tracked ad hoc. The team (2–5, Russian-speaking) needs one CRM, reachable from anywhere: leads auto-arrive from the site, deals move through a pipeline, tasks and interaction history keep clients warm.

## Architecture (v2)

```
                    VPS в РФ (~300–500 ₽/мес)
  ┌───────────────────────────────────────────────────────────┐
  │  Caddy (auto-HTTPS, SPA rewrite)                          │
  │   ├── static: Vite build of the site (incl. /crm chunk)   │
  │   └── reverse-proxy /api/* ──▶ Node 20 (Fastify)          │
  │                                 ├── SQLite (better-sqlite3)│
  │                                 ├── auth: JWT httpOnly     │
  │                                 │   cookie, bcrypt, invite-│
  │                                 │   only users             │
  │                                 ├── POST /api/leads (public│
  │                                 │   rate-limited, honeypot)│
  │                                 │   → contact+deal («Новый»)│
  │                                 │   → Telegram notification │
  │                                 └── nightly SQLite backup  │
  │                                     (cron, 7 generations)  │
  └───────────────────────────────────────────────────────────┘
        ▲                    ▲                      ▲
   site visitor         team member             Telegram group
   (/start, Нева)       (/crm from anywhere)    (instant lead ping)
```

- **Frontend**: same React SPA; `/crm/*` is a lazy chunk with its own `CrmLayout` (public `Layout`/ChatWidget not mounted there); nested routes so CrmLayout persists across CRM navigation; `TITLES` prefix-aware; error boundary + retry on chunk load failure.
- **Repository layer**: unchanged interface, now an **HTTP adapter** (fetch → REST API) instead of IndexedDB. In-memory adapter remains for tests. (The seam designed in rev 1 is doing exactly its job.)
- **Auth**: login page replaces PIN gate. Invite-only: admin creates users (first admin seeded via interactive CLI prompt on the server — credentials never in env files; user management in settings). bcrypt hashes, JWT in httpOnly Secure SameSite=Lax cookie, 30-day sliding expiry, **per-user `tokenVersion`** checked on every request so user deletion / password reset revokes sessions immediately. All /api/crm/* routes require auth; per-user attribution comes from the session, never the client.
- **Lead intake**: `POST /api/leads` — public endpoint. Payload variants: form `{task, scale, name, contact, note}` and chat `{task, detail, contact}` (chat has no name → Contact.name = the contact handle, or «Без имени»; `detail` → Deal.note). Rate-limit/honeypot hits are **accepted and flagged** `suspicious` (visible in the inbox with a «подозрительный» badge), never silently dropped — RF mobile CGNAT makes per-IP false positives likely. Creates Contact (source `site-form`/`site-chat`) + Deal in «Новый». Telegram notification goes through an **outbox table** (retry with backoff until sent — a dead bot token can't lose the ping permanently). Site side: Start.jsx and the chat engine POST with retry-on-next-visit (failed payloads queue in localStorage and re-POST on the next page load); the form's existing mailto fallback stays visible.
- **Data**: SQLite file on the VPS. Nightly backup via `VACUUM INTO` (WAL-safe — a plain `cp` of a live WAL database can corrupt), 7 rotated copies on-disk **plus the bot sends the nightly dump to the admin's Telegram** (off-box copy, still in-RF). Manual JSON export/import in settings (admin-only import, atomic). 152-ФЗ: client personal data stays on RF territory. All «сегодня / завтра / просрочено» computations pinned to **Europe/Moscow**; `dueDate` stored as a plain `YYYY-MM-DD` string.
- **Dropped from rev 1** (obsolete under a server): export/merge with tombstones, backup autopilot / FS Access API, BroadcastChannel banners, PIN gate, nv_leads first-run import (replaced by a "paste JSON" import tool in settings for old test leads). Server-side duplicate warning on create (phone/email match) stays.

## Data model (unchanged from rev 1, plus User)

- `User`: id, name, email, passwordHash, role (`admin | member`), createdAt.
- `Contact`: id, name*, company, phone, email, messenger, note, source (`site-form | site-chat | manual | import`), archived, + base.
- `Deal`: id, contactId*, title*, stage*, amount (₽, optional), note, closedAt, + base.
- `Task`: id, title*, contactId, dealId, dueDate, done, doneAt, + base.
- `Interaction`: id, contactId*, dealId, type (`звонок | встреча | письмо | сообщение | другое`), note, happenedAt, + base.
- Base: createdAt, updatedAt, createdBy (userId). Stages constant: Новый → Контакт → Переговоры → Договор → Оплачено / Проиграно; `closedAt` set entering a terminal stage, cleared on leaving. Deletion: contact soft-blocked while linked deals exist (archive offered); deal deletion keeps interactions on the contact timeline.

## UI scope (unchanged from rev 1 unless noted)

- `/crm` dashboard: today's + overdue tasks, latest interactions, pipeline funnel (open = stage ∉ {Оплачено, Проиграно}; terminal totals; «без суммы: N») **+ lead inbox: new site leads land at the top**.
- `/crm/deals` kanban: «переместить в этап» menu baseline, desktop pointer drag enhancement.
- `/crm/contacts` directory (search, 500-cap + refine), `/crm/contacts/:id` card with deals/tasks/timeline.
- `/crm/tasks` list, overdue highlighted.
- `/crm/settings`: profile, users (admin), export/import, CSV export of contacts (UTF-8 BOM), diagnostics (record counts, server version, last backup), demo seed flagged `demo:true` + «очистить демо» (excluded from exports).
- **Нева command bar + Ctrl+K palette** (`e.code === 'KeyK'`): auto-detect command vs search by grammar prefixes; preview-confirm before any write; uncertain parse → pre-filled form. Grammar (normative, inlined from rev 1):
  1. `лид <Имя>[, <компания>][, <телефон или email>]` — comma-split; `/^\+?[\d\s()-]{6,}$/` → phone; `@` → email; remainder → company. Creates contact + deal in «Новый».
  2. `задача: <текст>[ — <имя контакта>][ <дата>]` — fuzzy contact match; dates: `сегодня`, `завтра`, `послезавтра`, weekday names (next occurrence, today excluded), `DD.MM`, `DD.MM.YYYY`; unparsed date text stays in the title.
  3. `звонок|встреча|письмо|сообщение с <Имя>[: <заметка>]` — prefix = interaction type; declension-tolerant contact match; no match → interaction form.
  Parser is a pure function with its own test suite; RU date parsing shared with task forms; all relative dates resolve in Europe/Moscow.
- Forms: double-submit guards, unsaved-changes warning, stale-edit handling (409 from API → refresh offer).
- Fully Russian UI, Невариум glassmorphism tokens, **no generic SaaS look** (standing rule); responsive to mobile.

## Error & rescue map (v2)

| Codepath | Failure | Action | User sees |
|---|---|---|---|
| any /api/crm/* | 401 (expired session) | redirect to login, return-to preserved | login page |
| any fetch | network fail/timeout | retry button; no silent loss of a pending write | «Нет связи с сервером» toast |
| write | 409 updatedAt conflict | refetch + notice | «Запись изменена — обновить?» |
| POST /api/leads | rate limit / honeypot | 204 silently (visitor UX unchanged), logged | nothing |
| Telegram send | bot/network down | lead still saved; logged; 1 retry | nothing |
| SQLite write | disk full/locked | 500 + structured log | «Ошибка сервера» toast |
| import | malformed/newer schema | atomic reject | «Файл повреждён / обновите приложение» |
| lazy chunk | load fail | error boundary | «Не удалось загрузить — обновить» |
| login | wrong creds | generic message + server-side per-IP+account throttle | «Неверный email или пароль» |
| parser | uncertain | pre-filled form | «не понимаю — открыть форму?» |

## Engineering hardening (from /plan-eng-review 2026-07-10)

- SQLite: WAL mode + `busy_timeout=5000`; indexes on `deals.contactId`, `deals.stage`, `tasks.contactId`, `tasks.dueDate`, `interactions.contactId`; migrations via `PRAGMA user_version` + ordered files in `server/migrations/`.
- Fastify: `trustProxy: true` (behind Caddy) so per-IP rate limits see the real client IP.
- Mutations require a same-origin `Origin` header check (belt-and-braces on top of SameSite=Lax).
- Client: single `apiFetch` wrapper owns 401 → login redirect (return-to preserved), 409 → conflict notice, network error → retry toast. No per-call error handling.
- Dashboard served by one aggregate endpoint `GET /api/crm/dashboard` (tasks due, latest interactions, funnel, lead inbox) — one round-trip, not four.
- Dev: Vite `server.proxy` forwards `/api` to the local Fastify process.
- Deploy: named docker volume for the SQLite file + backups directory; compose builds better-sqlite3 in-image.

## Security (v2 — now a real surface)

- Auth on every /api/crm/* route; JWT httpOnly Secure cookie; bcrypt cost 12; server-side login throttling.
- `POST /api/leads`: input validation (lengths, types), per-IP rate limit, honeypot, no reflection of input.
- SQL: parameterized statements only (better-sqlite3 prepared).
- CORS: same-origin API; no cross-origin surface.
- No secrets in the repo; `.env.example` documents JWT_SECRET, TG_BOT_TOKEN, TG_CHAT_ID, seed admin credentials.
- Audit: structured log line for every mutation (who, what, when).

## Tests

1. Parser + RU dates (pure, unchanged).
2. Repository over in-memory adapter (UI contract).
3. API integration (Fastify inject + tmp SQLite): auth flow, CRUD, 401/409, lead intake incl. rate limit + honeypot, import atomicity, login throttle, Telegram-failure-still-saves-lead.
4. Funnel aggregation; CSV escaping (quotes/commas/newlines in names).
5. Client: session-expiry 401 → login redirect; kanban stage move with 409 conflict → refresh flow.
6. Existing site tests keep passing; non-/crm bundle unchanged.

## Deployment

- **The site is not deployed anywhere today (confirmed D18)** — this VPS is its first production home; no cutover needed.
- Repo gains `server/` (Fastify app + migrations) and `deploy/` (docker-compose: caddy + app; Caddyfile with SPA rewrite + /api proxy). Nightly backup cron in compose. Compose pins an RF-reachable registry mirror (Docker Hub throttles RF IPs); bootstrap smoke test verifies the better-sqlite3 in-image build fits small-tier memory.
- `deploy/README.md`: bootstrap sequence (buy domain if needed → create VPS → docker compose up → seed admin via CLI prompt → point DNS → smoke test).
- Rollback: git revert + rebuild; SQLite backup restore is one documented command.
- **Single release (D19)**, commits ordered so server + lead intake could deploy standalone before UI polish if desired.
- **User-side prerequisites** (only things I can't do): own/buy a domain, buy the VPS, point the DNS A-record, create a Telegram bot via @BotFather, add it to your group, provide `TG_BOT_TOKEN` and `TG_CHAT_ID`.

## NOT in scope (v2)

- Offline mode / IndexedDB cache (the adapter seam allows it later).
- Editable stages; per-member activity feed; LLM-backed Нева parsing (TODOS.md).
- Password reset by email (admin resets manually — no SMTP dependency in v1).
- Multi-workspace/tenancy — single team.

## Implementation tasks (v2)

- [ ] **T1 (P1)** server: Fastify app, SQLite schema + migrations, auth (login/logout/session), CRUD API, 409 conflict handling, structured logs. `server/`
- [ ] **T2 (P1)** lead intake: POST /api/leads + rate limit + honeypot + Telegram notify; wire Start.jsx + chat engine (fire-and-forget, localStorage fallback).
- [ ] **T3 (P1)** app shell: nested routes, persistent CrmLayout, TITLES prefix, lazy chunk + error boundary, login page + session handling.
- [ ] **T4 (P1)** repository HTTP adapter + in-memory test adapter.
- [ ] **T5 (P1)** pages: dashboard (inbox, tasks, funnel), deals kanban, contacts + card, tasks, settings (users, export/import, CSV, diagnostics, demo seed).
- [ ] **T6 (P1)** Нева command bar + Ctrl+K palette + parser + RU dates.
- [ ] **T7 (P1)** tests (suites 1–5).
- [ ] **T8 (P1)** deploy kit: docker-compose, Caddyfile, backup cron, bootstrap README, .env.example.
- [ ] **T9 (P2)** polish: demo seed, diagnostics, empty states, brand pass.

## Design specification (from /plan-design-review, approved mockup: variant A «Приборная панель»)

**Approved visual language** (mockup: `~/.gstack/projects/nevarium-crm-design-a99bd4/designs/crm-dashboard-20260710/variant-A.{html,png}`): dark navy `--bg-0` with faint blue/cyan radial ambience; fixed 220px left rail (`--bg-1`, logo `NEVARIUM/CRM`, active item = blue gradient fill + border, «Спросите Неву · Ctrl K» pinned at rail bottom); content in glass tiles (`--glass-bg`, 1px `--glass-border`, `--radius`, blur 16px, per-tile radial glow); tile headers = outlined numeral (`Unbounded`, transparent fill, 1.3px blue stroke) + uppercase `Unbounded` label; funnel = glowing gradient horizontal bars with tabular-numeral ₽ sums; accent pink strictly for warnings/просрочено/подозрительный.

**Screen hierarchy (what the user sees 1st/2nd/3rd):**
- Dashboard: 1) greeting + day summary line, 2) «Новые лиды» tile (top-left, largest), 3) «Сегодня» tasks → funnel → activity feed.
- Deals kanban: 1) stage columns as glass wells (column header = stage name + ₽ sum in `Unbounded`), 2) deal cards (title, contact, amount, age-in-stage dot), 3) per-card «переместить» menu. Desktop drag = enhancement.
- Contact card: 1) name + company header with source chip, 2) deals strip, 3) tabbed timeline (Всё / Звонки / Задачи).
- Login: centered single glass panel on the site's Backdrop ambience, N-mark, «Невариум CRM», email/password, no marketing chrome.
- Ctrl+K palette: centered modal, same glass-strong surface as the rail's Нева hint, input styled like variant C's command bar (blue-glow border), results list below with type icons; command parses render a preview card inside the modal with «Подтвердить / Открыть форму».

**Interaction state table (user-visible spec, RU):**
| Feature | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| Lead inbox | 2 skeleton rows (shimmer on glass) | «Пока тихо. Новые лиды с сайта появятся здесь» + «Добавить вручную» | toast «Нет связи» + retry | new row slides in, blue glow pulse 1s | «подозрительный» badge |
| Kanban | skeleton columns | per-column: «Перетащите сделку или создайте новую» + ghost-card button | 409 → card snaps back + «Запись изменена — обновить?» | card settles with 150ms ease | deal без суммы shows «— ₽» |
| Tasks | skeleton list | «Все задачи закрыты» + button «Новая задача» | toast | checkbox fill animation, row fades to done | просрочено = warm red `#ff7b7b` |
| Forms | button spinner, fields locked | n/a | inline field errors + top summary | close + toast «Сохранено» | unsaved-changes prompt on navigate |
| Import/export | progress line | n/a | «Файл повреждён — ничего не импортировано» | «Импортировано: N контактов, M сделок» | duplicate warnings listed before confirm |
| Login | button spinner | n/a | «Неверный email или пароль» (generic) | redirect to return-to | throttled: «Попробуйте через N секунд» |

**Journey storyboard (emotional arc):** morning open → login persists (no friction) → greeting names you and the day's shape (oriented in 3 seconds) → a new lead glows at top (small dopamine hit, clear next action) → one click logs the call via Нева preview (competence) → funnel sum ticks up (progress made visible). The 5-second impression is «инструмент лаборатории», not «админка».

**Responsive spec (intentional, not stacked):**
- ≥1024px: rail + 2-column tile grid (funnel/activity span full width).
- 640–1023px: rail collapses to 64px icon rail (tooltips on hover/long-press); tiles single column.
- <640px: rail becomes a 5-item bottom tab bar (56px height, 44px+ targets, active = blue glyph + label); Нева palette invoked from a floating N button bottom-right; kanban renders one stage at a time with horizontal stage-pager chips; all move actions via the «переместить» menu.
- Touch targets ≥44px, `:focus-visible` outlines (already in base.css), ARIA: `nav`/`main` landmarks, kanban move-menu fully keyboard operable (arrow keys between stages), palette is `role=dialog` with focus trap, contrast: body text `--text-2` on `--bg-0` ≈ 9:1; `--text-3` reserved for metadata ≥12px.

**Design-system note:** tokens.css is the normative system; the CRM introduces only: `--warn: #ff7b7b`, skeleton shimmer, and the icon set (stroke 1.5px, geometric, no filled circles). A repo DESIGN.md consolidating this is a P3 TODO.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 9 proposals, 7 accepted, 2 deferred |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 21 issues, 0 critical gaps — all folded into spec |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score 5/10 → 9/10; mockup A approved; states/journey/responsive/a11y specified |
| Outside Voice | claude subagent | Independent 2nd opinion | 3 | ran | 13 + 12 findings; drove local-first→hosted refinements and D11–D14, D18–D19 decisions |

- **CROSS-MODEL:** outside voice challenged strategy twice (lead relay, phasing); user resolved all tensions — relay became core intake, single release kept.
- **VERDICT:** CEO + ENG + DESIGN CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
