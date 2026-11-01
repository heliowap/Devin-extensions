"""Line-delimited local IPC. Never write to the Devin database or emit transcripts."""

import json
import sys

from metrics import snapshot


def main() -> None:
    for line in sys.stdin:
        request_id = None
        try:
            data = json.loads(line)
            if not isinstance(data, dict):
                raise ValueError("Objeto JSON esperado.")
            request_id = data.get("id")
            if data.get("action") != "snapshot":
                raise ValueError("Ação desconhecida.")
            path = data.get("databasePath", "")
            session = data.get("sessionId")
            workspaces = data.get("workspacePaths", [])
            prices = data.get("prices", {})
            billing_sources = data.get("billingSources", {})
            openai_billing = data.get("openAiBilling", "unknown")
            simulation_model = data.get("simulationModel", "")
            if not isinstance(path, str) or (session is not None and not isinstance(session, str)):
                raise ValueError("Seleção de banco ou sessão inválida.")
            if not isinstance(workspaces, list) or not all(isinstance(p, str) for p in workspaces):
                raise ValueError("Lista de workspaces inválida.")
            if not isinstance(prices, dict):
                raise ValueError("Tabela de preços inválida.")
            if not isinstance(billing_sources, dict) or not all(
                isinstance(model, str) and source in ("chatgpt", "devin", "api", "unknown")
                for model, source in billing_sources.items()
            ):
                raise ValueError("Origens de cobrança inválidas.")
            if openai_billing not in ("chatgpt", "devin", "api", "unknown"):
                raise ValueError("Origem OpenAI inválida.")
            if not isinstance(simulation_model, str):
                raise ValueError("Modelo de referência inválido.")
            result = snapshot(
                path, session, workspaces, prices,
                billing_sources=billing_sources,
                openai_billing=openai_billing,
                simulation_model=simulation_model,
            )
            response = {"id": request_id, "ok": True, "result": result}
        except (ValueError, TypeError):
            response = {"id": request_id, "ok": False, "error": "Solicitação de métricas inválida."}
        except Exception:
            response = {"id": request_id, "ok": False, "error": "Falha ao coletar métricas locais."}
        try:
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
        except (BrokenPipeError, OSError):
            return


if __name__ == "__main__":
    main()
