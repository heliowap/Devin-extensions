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
            if not isinstance(path, str) or (session is not None and not isinstance(session, str)):
                raise ValueError("Seleção de banco ou sessão inválida.")
            if not isinstance(workspaces, list) or not all(isinstance(p, str) for p in workspaces):
                raise ValueError("Lista de workspaces inválida.")
            if not isinstance(prices, dict):
                raise ValueError("Tabela de preços inválida.")
            result = snapshot(path, session, workspaces, prices)
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
