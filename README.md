# Devin Pulse

Devin Pulse shows, inside VS Code-compatible editors, the model, prompt timing, token usage and confirmed throughput of your local Devin sessions. The UI is in Portuguese; this README is in English.

Devin Pulse is an independent community project. It is not affiliated with, endorsed by, or sponsored by Cognition.

## What it shows

- **Status bar** (right side): the last confirmed model request, as `model · latency · TPS`. While a prompt has no final response recorded, it shows the live elapsed time since that prompt was submitted and the TPS of the last completed call, labelled `última chamada`.
- **Panel** (`Devin Pulse: Abrir painel`): the selected session, the current prompt, session totals, a prompt history and the individual requests of a selected prompt.

## Metric meanings

- **Live elapsed ("desde envio")**: wall-clock time since a prompt was submitted, while no final response for that prompt is recorded. It includes tool runs and model waiting. It does not prove the model is still running; after a cancellation without a recorded ending, the timer stays at "desde envio".
- **Completed-request TPS**: throughput of a finished model request. It is either `reportado pelo Devin` (the value Devin recorded) or `requisição, inclui espera` (computed over the whole request, including waiting time). The panel labels the basis for each value.
- **Session totals vs prompt history**: session totals include every stored request after deduplication, including requests on discarded branches. The prompt history follows only the retained main branch, so totals need not equal the sum of the visible prompt rows. Delegated work not yet attached to a prompt is counted in totals and reported as outside the displayed history.
- **Latency**: the recorded duration of a single model request. **TTFT** is the time to its first token when recorded.
- **Prompt elapsed**: the duration of a completed prompt. A prompt that was superseded by the next prompt has no final response, so no duration is shown for it.
- **Scope**: `Principal` is a request made by the main agent; `Delegada` is a request made by a delegated sub-agent. A delegated history is attributed once, to its first main-chain handoff; work not yet attached is counted in session totals and shown as unassigned.
- **Tokens**: input, output, cache read and cache creation are shown separately, with a total. A value marked `≥` is a lower bound: the source record lacked or malformed that counter, so the number cannot be treated as complete.
- **Cost**: an estimate only, computed from prices you configure per exact model ID. Models without a configured price show `Não configurado / indisponível`, not zero. Coverage is shown when only some requests have a price.
- **TPS is not streaming**: metrics update after each request completes. Devin Pulse does not estimate live streaming throughput.

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
code --install-extension devin-pulse-0.1.0.vsix
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
| `devinPulse.prices` | `{}` | Optional estimates in USD per million tokens, keyed by exact model ID, with `input`, `output`, `cacheRead` and `cacheWrite`. |

Example:

```json
"devinPulse.prices": {
  "example-model-id": { "input": 1.0, "output": 4.0, "cacheRead": 0.1, "cacheWrite": 1.25 }
}
```

The example values are placeholders, not real prices. The collector validates the price table.

## Privacy and data handling

- Everything runs locally. The extension and collector make no network requests and have no credentials.
- The collector reads only metadata: identifiers, timestamps, models, counters and titles/directories needed to list sessions. Prompt and response text are never read into the UI, sent to the webview, logged or exported.
- The database is opened read-only. No data is written to it, and the panel cannot run commands or queries.
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
