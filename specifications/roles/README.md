# roles/ — інструкції для ролей

Рольові інструкції для команди (людей **або** AI-агентів, що грають роль). Кожен файл = одна персона:
хто вона, що робить, який артефакт віддає, чого **не** робить, і кому передає.

Це прямо лягає на spec-driven цикл:

```
Business Analyst → spec.md            (ЩО/НАВІЩО, вимоги)
        ↓
Solution Architect → plan.md + decisions/ + contracts/   (ЯК, архітектура, NFR, контракти)
        ↓                    ↘
Designer → design/ (UX/UI)    Developer → src/ + tests/ (реалізація за tasks.md)
```

| Роль | Файл | Володіє артефактом |
|------|------|--------------------|
| Business Analyst | [business-analyst.md](business-analyst.md) | `spec.md`, glossary |
| Solution Architect | [solution-architect.md](solution-architect.md) | `plan.md`, `decisions/`, `contracts/`, NFR |
| Designer (UX/UI) | [designer.md](designer.md) | design specs, a11y |
| Developer | [developer.md](developer.md) | `src/`, `tests/`, `tasks.md` |

## Як застосувати
- **Як гайд для людей** — читає той, хто грає роль.
- **Як AI-субагента** — скопіюй суть у `.claude/agents/<role>.md` (frontmatter + промпт) і виклич під задачу.
- Ключове в кожному файлі — **межі (boundaries)**: чого роль НЕ робить (щоб агент не «розповзався»).
