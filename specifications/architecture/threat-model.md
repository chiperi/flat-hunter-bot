# Threat Model (STRIDE)

## Scope & trust boundaries
<data-flow діаграма; де проходять межі довіри>

## Assets
<що захищаємо: PII, кошти, токени, секрети>

## Threats (STRIDE)
| ID | Категорія | Загроза | Мітигація | Статус |
|----|-----------|---------|-----------|--------|
| T-001 | Spoofing | <підміна ідентичності> | <auth/mTLS> | open |
| T-002 | Tampering | <підміна даних> | <підписи/валідація> | open |
| T-003 | Repudiation | <заперечення дій> | <audit log> | open |
| T-004 | Information disclosure | <витік> | <шифрування/маскування PII> | open |
| T-005 | Denial of Service | <перевантаження> | <rate limit/автоскейл> | open |
| T-006 | Elevation of privilege | <ескалація прав> | <RBAC/least privilege> | open |

## Data classification
<PII/PHI · retention · encryption at rest/in transit · право на видалення (GDPR)>
