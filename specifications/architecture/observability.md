# Observability & SLO

## Metrics
<RED (rate/errors/duration) для сервісів; USE (utilization/saturation/errors) для ресурсів>

## Logs
<структуровані (JSON); audit trail значущих подій; БЕЗ PII у логах>

## Traces
<distributed tracing; наскрізний trace-id через сервіси>

## SLO / SLA / error budget
| SLI | Ціль (SLO) | Вікно | Error budget |
|-----|------------|-------|--------------|
| availability | 99.9% | 30 днів | ~43 хв/міс |
| latency p95 | < 200 ms | 30 днів | — |

## Alerts & runbooks
<які алерти; посилання на runbook кожного failure mode>
