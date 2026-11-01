# Devin Pulse

Devin Pulse shows, inside VS Code-compatible editors, the model, prompt timing, token usage and confirmed throughput of your local Devin sessions. The UI is in Portuguese; this README is in English.

Devin Pulse is an independent community project. It is not affiliated with, endorsed by, or sponsored by Cognition.

## What it shows

- **Status bar** (right side): the last confirmed model request, as `model · latency · TPS`. While a prompt has no final response recorded, it shows the live elapsed time since that prompt was submitted and the TPS of the last completed call, labelled `última chamada`.
- **Panel** (`Devin Pulse: Abrir painel`): the selected session, the current prompt, accumulated token volume, per-model consumption, an API-equivalent simulation, a prompt history and the individual requests of a selected prompt.

## Metric meanings

- **Live elapsed ("desde envio")**: wall-clock time since a prompt was submitted, while no final response for that prompt is recorded. It includes tool runs and model waiting. It does not prove the model is still running; after a cancellation without a recorded ending, the timer stays at "desde envio".
- **Completed-request TPS**: throughput of a finished model request, shown with its basis: `reportado pelo Devin` (the value Devin recorded) or `requisição, inclui espera` (computed over the whole request, including waiting time).
- **TPS por tempo de chamadas (inclui espera)**: per model, output tokens divided by the sum of the whole durations of the eligible requests. It includes waiting time. It is not an average of per-call reported TPS, and not wall-clock throughput. The panel shows how many requests contributed.
- **Volume acumulado de tokens**: the sum of token counts recorded across every stored request. Cache reads are repeated for each request that re-reads the context, so this total is accumulated request volume. It is not unique text, not the size of the context window, and not a percentage of any quota. Most of it is typically cache reads.
- **Saída gerada (registrada)**: output tokens as the source records them. Depending on the provider, this may include reasoning tokens beyond the visible final answer.
- **Cache lido — acumulado por chamada** and **Cache criado**: cache counters as recorded per request. They are shown separately from input and output.
- **Session totals vs prompt history**: session totals include every stored request after deduplication, including requests on discarded branches. The prompt history follows only the retained main branch, so totals need not equal the sum of the visible prompt rows. Delegated work not yet attached to a prompt is counted in totals and reported as outside the displayed history.
- **Latency**: the recorded duration of a single model request. **TTFT** is the time to its first token when recorded.
- **Prompt elapsed**: the duration of a completed prompt. A prompt that was superseded by the next prompt has no final response, so no duration is shown for it.
- **Scope**: `Principal` is a request made by the main agent; `Delegada` is a request made by a delegated sub-agent. A delegated history is attributed once, to its first main-chain handoff.
- **Lower bounds (`≥`)**: the source record lacked or malformed that counter, so the number is a lower bound, not a complete count.
- **Model IDs**: shown exactly as recorded. An internal identifier such as `compactor` is shown as-is; Devin Pulse does not assign it to a vendor or to any executor.

## Billing origin, API equivalents and simulation

Devin Pulse does not know your actual charges. Everything below is either a declaration you make or a calculation from prices you enter.

- **Origem de cobrança (declared)**: a route you declare per model in `devinPulse.billingSources`, or for `gpt-` models in `devinPulse.openAiBilling`. Labels: `ChatGPT/OAuth (configuração informada)`, `Cota/créditos Devin (configuração informada)`, `API externa (configuração informada)`, or `Não informada`. A declared route is applied to the session history; it is not a transaction-level billing record. Route changes made in the past are not known.
- **GPT through ChatGPT OAuth** uses subscription usage. Devin Pulse does not know a marginal API bill for it, and it does not show one.
- **Equivalente de API**: tokens multiplied by the rates you configure in `devinPulse.prices` for each exact model ID. This is an API-equivalent value, not a cost you paid and not a debit from a quota. Models without a configured price show `Não configurado / indisponível`, not zero. Coverage is shown when only some requests have a price.
- **Cache reads under API pricing**: when you configure a cache-read rate, cache reads are priced at that rate, not as normal input tokens. The volume total is not a normal-input charge.
- **Simulação a preços de API**: select a reference model with `devinPulse.simulationModel`. The block reapplies that model's configured rates to the same observed token volume and shows the signed difference. Negative differences are valid and are not clamped. This does not measure how the task would run without Fusion, nor any subscription or quota saving. It is not a financial or quality claim.

## Requirements

- VS Code 1.95 or newer, or a compatible editor that can install VSIX packages.
- Python 3.10 or newer, available as `python3` (on Windows, `python` is tried as a fallback).
- A local Devin sessions database. The collector reads it read-only. Default locations:
  - macOS/Linux: `$XDG_DATA_HOME/devin/cli/sessions.db` (or `~/.local/share/devin/cli/sessions.db`)
  - Windows: `%APPDATA%\devin\cli\sessions.db`

## Installation

Build or download the VSIX, then install it with your editor:

```sh
npm ci
npm run package
code --install-extension devin-pulse-0.2.0.vsix
```

Your editor's Extensions view also offers an install-from-VSIX option. Reload the window if the editor asks for it.

## Usage

- Status bar: click to open the panel.
- Commands (Command Palette):
  - `Devin Pulse: Abrir painel`
  - `Devin Pulse: Selecionar sessão` — pins a session; the choice is stored per workspace.
  - `Devin Pulse: Acompanhar workspace` — returns to automatic selection: the most recent session whose directory matches an open workspace folder. Automatic mode is not a claim about which chat tab is active.
  - `Devin Pulse: Atualizar` — polls immediately.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `devinPulse.databasePath` | `""` | Path to the sessions database. Empty uses the default location. |
| `devinPulse.pythonPath` | `"python3"` | Python 3.10+ executable used for the collector. |
| `devinPulse.pollIntervalMs` | `1000` | Poll interval, 500–60000 ms. |
| `devinPulse.showStatusBar` | `true` | Show the status bar item. |
| `devinPulse.prices` | `{}` | Your API rates in USD per million tokens, keyed by exact model ID, with `input`, `output`, `cacheRead` and `cacheWrite`. Used only for API-equivalent values and simulation. No defaults. |
| `devinPulse.billingSources` | `{}` | Declared billing route per exact model ID: `chatgpt`, `devin`, `api` or `unknown`. Configuration, not evidence. No defaults. |
| `devinPulse.openAiBilling` | `"unknown"` | Declared route for models whose ID starts with `gpt-`: `unknown`, `chatgpt`, `devin` or `api`. |
| `devinPulse.simulationModel` | `""` | Exact model ID used as the reference in the API-equivalent simulation. Empty disables it. |

Example (placeholder values, not real prices or routes):

```json
"devinPulse.prices": {
  "example-model-id": { "input": 1.0, "output": 4.0, "cacheRead": 0.1, "cacheWrite": 1.25 }
},
"devinPulse.billingSources": {
  "example-model-id": "api"
},
"devinPulse.simulationModel": "example-model-id"
```

The collector validates the price table, billing routes and simulation model.

## Privacy and data handling

- Everything runs locally. The extension and collector make no network requests and have no credentials.
- The collector reads only metadata: identifiers, timestamps, models, counters and titles/directories needed to list sessions. Prompt and response text are never read into the UI, sent to the webview, logged or exported.
- The database is opened read-only. No data is written to it, and the panel cannot run commands or queries.
- Session titles can contain sensitive wording. They stay on your machine; do not paste panel screenshots that show them into public channels.
- Devin Pulse does not inspect or change the Devin chat interface.

## Development

```sh
npm ci
npm test       # Node unit tests and Python collector tests
npm run check  # syntax checks
npm run package
```

Synthetic fixtures are used throughout; do not commit real session data, captures or secrets.

## License

MIT. Copyright (c) 2026 Helio Pinheiro.
