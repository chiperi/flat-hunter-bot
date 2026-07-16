# flat-hunter-bot — `specifications/`

Кураторський набір документації (не повний spec-forge-бандл). Ми свідомо лишили тільки те, що має
**тривалу цінність** і повільно дрейфує, і прибрали скафолд-шаблони та план ще не збудованої фічі
(їх легко відновити з git-історії / перегенерувати `spec-forge` за потреби). Код — у `../src`.

## Що лишили і навіщо

| Шлях | Що це | Чому тримаємо |
|---|---|---|
| `00-constitution.md` | 10 незмінних принципів проєкту | Пояснює «правила гри»; дрейфує повільно |
| `architecture/decisions/0001–0004` | ADR: Redis-only · one-filter-per-user · sources landscape · DOM.RIA price-filter | **Справжні** ухвалені рішення — те «чому так», що губиться з пам'яті |
| `architecture/nfr.md` | NFR у числах (свіжість, без дублів/втрат, стійкість, бюджет запитів, coverage 80/80/80/70) | Вимірювані гарантії, яких нема в README |
| `knowledge/domain-notes.md` | Домен: валюта ($/€→грн), DOM.RIA API, rieltor-розмітка, пастки (`REDIS_KEY_PREFIX`) | Здобуте знання, що економить години наступного разу |
| `product/specs/002-existing/spec.md` | Reverse-engineered спека поточного бота (з `path:line`) | Точний зріз «що робить система сьогодні» |
| `product/specs/002-existing/review.md` | Gap/doc-drift рев'ю | Дало 8 фіксів (PR #24–#31); карта відомих ризиків |

## Що прибрали (є в git-історії PR #32, якщо колись знадобиться)
- Скафолд-шаблони `spec-forge`: `ai/`, `roles/`, `platform/`, `quality/`, `services/` та порожні
  `architecture/{fitness-functions,observability,threat-model,traceability-matrix}.md`.
- План ще **не збудованої** фічі «Proxy-enabled OLX source»: `product/specs/001-feature/`,
  `architecture/decisions/0005–0007`, `delivery/`, `architecture/plan.md`, `contracts/`.
  (Фіча свідомо відкладена — потребує резидентського проксі; ми лишились на DOM.RIA + rieltor.)

## Як оновлювати
- **Аналіз коду:** `/spec-forge analyze` — переоновлює `002-existing/{spec,review}.md`.
- **Нове рішення:** додати наступний `architecture/decisions/000N-*.md` (Nygard-формат).
- **Нове знання про домен:** дописати в `knowledge/domain-notes.md`.
