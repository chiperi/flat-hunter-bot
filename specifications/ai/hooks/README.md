# hooks/

Скрипти на події (реєструються в `settings.json` → `hooks`).
Події: PreToolUse · PostToolUse · Stop · UserPromptSubmit · SessionStart тощо.
Виконує їх ГАРНЕС (не модель) — тому підходять для жорстких guardrails:
формат/лінт після правок, заборони, нотифікації.
