# Architecture Fitness Functions

Виконувані перевірки архітектурних характеристик у CI (Neal Ford).
Governance = код у пайплайні, а не ручне ревʼю.

| ID | Характеристика | Перевірка | Тип | Де |
|----|----------------|-----------|-----|----|
| FF-001 | Модульність | модуль A не імпортує internal модуля B | atomic/triggered | CI (arch test) |
| FF-002 | Performance | p95 latency < NFR-001 | holistic/continual | load test у пайплайні |
| FF-003 | Dependencies | немає заборонених/циклічних залежностей | atomic | CI |
| FF-004 | Security | немає critical vuln у залежностях | atomic | CI (SCA) |
