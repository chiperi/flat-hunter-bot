# flat-hunter-bot — `specifications/`

Spec-bundle (stack: node), заповнений через `/spec-forge fill`. Це **джерело істини** про намір і
дизайн; код живе в корені репо (`../src`).

## Що де

| Шлях | Що це | Статус |
|---|---|---|
| `00-constitution.md` | Незмінні принципи проєкту (найвищий рівень) | ✅ заповнено |
| `product/specs/002-existing/spec.md` | **Фактична** спека поточного бота (reverse-engineered, з посиланнями на код) | ✅ (via `analyze`) |
| `product/specs/002-existing/review.md` | Gap/doc-drift рев'ю — 8 знахідок, усі виправлені (PR #24–#31) | ✅ (via `analyze`) |
| `product/specs/001-feature/spec.md` | Спека наступної фічі: **Proxy-enabled OLX source** | ✅ заповнено (spec; `plan`/`tasks` — за потреби) |
| `architecture/plan.md` | Фактична архітектура: модулі, ядро джерел, цикл, дані, деплой, тести | ✅ |
| `architecture/decisions/` | ADR: Redis-only, one-filter-per-user, sources landscape, DOM.RIA price-filter | ✅ |
| `architecture/nfr.md` | NFR у числах (свіжість, без дублів/втрат, стійкість, бюджет запитів, coverage-gate) | ✅ |
| `contracts/` | `openapi` — N/A (нема вхідного API); `asyncapi` — команди + сповіщення | ✅ |
| `knowledge/domain-notes.md` | Домен: валюта, DOM.RIA API, rieltor-розмітка, пастки | ✅ |
| `delivery/` | Backlog атомарних задач | ⬜ (немає активної фічі) |
| `roles/`, `ai/`, `platform/`, `quality/`, `services/` | Шаблони/скафолд ролей, AI-конфігів, платформи, CI | scaffolded (не через інтерв'ю) |

## Як користуватись

- **Brownfield-аналіз:** `/spec-forge analyze` — переоновлює `002-existing/{spec,review}.md` з коду.
- **Нова фіча:** `/spec-forge spec <опис>` → `001-feature/spec.md`, далі `plan` → `tasks` (→ `delivery/`).
- **Перевірка гейтів:** `spec-forge validate`.

> Примітка: цей бандл наразі **untracked** у git — комітьте, коли захочете зафіксувати.
