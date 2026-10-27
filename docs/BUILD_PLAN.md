# RiverRoom build plan

Checklist, in build order. Each stage was tested before the next began.

- [x] Monorepo scaffold (npm workspaces, strict TypeScript, Vitest)
- [x] `@riverroom/engine` — cards, CSPRNG shuffle, 7-card evaluator, betting state machine, side pots, settlement, invariants
- [x] Engine tests — categories, tie-breaks, blinds, heads-up order, min-raise, short all-ins, reopening, side pots, odd chips, conservation, seeded fuzzing
- [x] `@riverroom/protocol` — Zod schemas for every client→server payload, typed server views
- [x] Server — guest sessions (HttpOnly cookie), rooms, seats, host controls, per-room serialized queue, idempotent actions, staleness checks, turn clock, disconnect grace, per-player views
- [x] Persistence — Postgres schema + migrations; PGlite locally/tests, `pg` with `DATABASE_URL`; transition + snapshot in one transaction; encrypted snapshots; restart recovery
- [x] Server integration tests — real Socket.IO clients with separate identities
- [x] Web — home/identity, lobby, table, cards, chips, action bar, raise selector, results, hand log, history, stats, standings
- [x] E2E — Playwright, two independent browser contexts (one phone-sized)
- [x] Independent review pass → fixes (leave folds, superseded tabs refused, origin check, room eviction, two production-mode bugs found by E2E/prod checks) → reran everything
- [x] README, ARCHITECTURE, `.env.example`, deployment notes
- [x] Moving-big-blind rule (dead small blind / dead button)
- [x] Docker image built and verified against PostgreSQL 15 (E2E suite passing)
- [ ] Public deployment — not performed: no hosting credentials were available
