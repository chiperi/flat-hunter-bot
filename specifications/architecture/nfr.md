# Non-Functional Requirements (у числах)

> Кожен NFR — вимірюваний. Це фоновий Telegram-бот (long polling), не сервіс із вхідним API — тож
> метрики про latency/rps/horizontal-scaling не застосовні; натомість — свіжість сповіщень,
> відсутність дублів/втрат, стійкість і бюджет запитів.

| ID | Атрибут | Ціль (вимірювана) | Як перевіряємо |
|----|---------|-------------------|----------------|
| NFR-001 | Свіжість сповіщення | нове оголошення → сповіщення в межах **одного циклу** (`POLL_INTERVAL_MS ± POLL_JITTER_MS`, дефолт 5–10 хв) | scheduler spec (diff→notify); лог циклу |
| NFR-002 | Без дублів після рестарту | 0 повторних сповіщень про вже бачене | seen-hash у Redis (не в пам'яті); persistence spec (round-trip) |
| NFR-003 | Без тихих втрат | «seen» проставляється **лише** після успішного send; збій → ретрай наступного циклу | scheduler `deliver()` spec («не mark-seen при збої») |
| NFR-004 | Стійкість (blast radius) | помилка 1 джерела/профілю/користувача/сповіщення не зупиняє цикл для інших | джерело → `[]` на збої; per-profile/per-notify try/catch; `bot.catch`; scheduler spec |
| NFR-005 | Бюджет запитів DOM.RIA | ≤ `1 search + DOMRIA_MAX_DETAILS` info-запитів на **унікальний** пошук за цикл; у межах місячної квоти ключа | opt-2 кеш (лише нові id) + warn-лог при переповненні; site-specs spec |
| NFR-006 | Делікатність скрапінгу | ≤ 1 запит на джерело на **унікальний** пошук за цикл (dedup); джиттер + backoff; ротація UA | `SourceRegistry` dedup; `http-listing-source` spec (retry.util) |
| NFR-007 | Доступність інстансу | single-instance, `restart: unless-stopped`; 0 вхідних портів | docker-compose; деплой-workflow |
| NFR-008 | Приватність / безпека | allowlist fail-closed; **0** збережених персональних даних (телефони/імена); секрети не на диску | allowlist middleware spec; scraper зберігає лише id/ціна/площа/URL; deploy (env через SSH stdin, `rm -f .env`) |
| NFR-009 | Якість коду | coverage-gate **80/80/80/70** (stmt/branch/func/line), зелений на кожному push/PR | `jest.config` thresholds; CI (`deploy.yml`) |

## Примітки

- **Масштаб** — не «horizontal до N інстансів», а «один інстанс тримає allowlist-групу»: вартість
  циклу зростає з кількістю **унікальних** пошуків (не користувачів), бо однакові пошуки дедупляться;
  унікальні фетчі йдуть конкурентно (`Promise.all`).
- **Точність ціни** — усі ціни в грн (конвертація на боці джерела); оголошення без ціни виключаються
  (NFR-суміжне до коректності, тестовано в `matchesCriteria`/site-specs).
