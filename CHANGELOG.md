# Changelog

## 0.2.0

- Session totals renamed to "Volume acumulado de tokens", annotated as accumulated request volume that includes repeated cache reads (not unique text, not a quota percentage).
- Per-model table: full model IDs, declared billing origin, request and role counts, all four token categories, latest reported TPS, consolidated TPS by call time (with sample coverage) and API-equivalent cost with pricing coverage.
- Declared billing routes (`devinPulse.billingSources`, `devinPulse.openAiBilling`) shown as configuration, never as transaction records. Unknown routes stay "Não informada".
- "Simulação a preços de API" block: observed volume at configured API tariffs compared with a chosen reference model (`devinPulse.simulationModel`). Signed differences are shown without clamping and are not savings claims.
- Cost values are labelled as API equivalents ("equivalente de API") everywhere.
- Session model and mode are shown in full, with wrapping.

## 0.1.0

- Status bar summary of the last confirmed model request, with live elapsed time for a prompt that has no final response yet.
- Webview panel with session totals, prompt history and per-request rows.
- Read-only local collector (Python standard library) for the Devin sessions database.
- Optional user-defined USD estimates per exact model ID.
