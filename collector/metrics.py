"""Read-only Devin measurements. No prompt or response content crosses this seam."""

from __future__ import annotations

import json
import math
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


TOKEN_FIELDS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "cacheRead": "cache_read_tokens",
    "cacheWrite": "cache_creation_tokens",
}

SESSIONS_SQL = """
SELECT id, title, working_directory, model, last_activity_at, main_chain_id
FROM sessions WHERE hidden = 0 ORDER BY last_activity_at DESC, id LIMIT 200
"""

# Extract metadata in SQLite: conversation text and tool arguments are never read.
NODES_SQL = """
SELECT row_id, node_id, parent_node_id, created_at,
 json_extract(chat_message, '$.role') AS role,
 json_extract(chat_message, '$.message_id') AS message_id,
 json_extract(chat_message, '$.metadata.is_user_input') AS is_user_input,
 json_extract(chat_message, '$.metadata.created_at') AS finished_at,
 json_extract(chat_message, '$.metadata.request_id') AS request_id,
 json_extract(chat_message, '$.metadata.generation_model') AS generation_model,
 json_extract(chat_message, '$.metadata.metrics') AS metrics,
 json_extract(chat_message, '$.metadata.extensions."chisel/client-message-id"')
   AS client_message_id,
 json_extract(chat_message, '$.metadata.extensions."subagent/chain_node_id"')
   AS delegated_head,
 COALESCE(json_array_length(chat_message, '$.tool_calls'), 0) AS tool_count,
 json_type(chat_message, '$.metadata.extensions."chisel/tool_call_content"')
   IS NOT NULL AS has_tool_content
FROM message_nodes WHERE session_id = ? ORDER BY row_id
"""


def default_database() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming")))
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    return root / "devin/cli/sessions.db"


def number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def timestamp(value: object) -> float | None:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp() * 1000
        except (ValueError, OverflowError):
            return None
    numeric = number(value)
    if numeric is None:
        return None
    return numeric if numeric >= 100_000_000_000 else numeric * 1000


def token_counts(metrics: dict) -> dict:
    result = {"unknown": []}
    for label, field in TOKEN_FIELDS.items():
        value = number(metrics.get(field))
        if value is None or not value.is_integer():
            result[label] = 0
            result["unknown"].append(label)
        else:
            result[label] = int(value)
    result["total"] = sum(result[label] for label in TOKEN_FIELDS)
    return result


def estimate_cost(model: str, tokens: dict, prices: dict) -> float | None:
    """Exact model match only; incomplete counters/prices are not a zero bill."""
    rate = prices.get(model)
    if not isinstance(rate, dict) or tokens["unknown"]:
        return None
    values = {key: number(rate.get(key)) for key in TOKEN_FIELDS}
    if any(value is None for value in values.values()):
        return None
    result = sum(tokens[key] * values[key] for key in TOKEN_FIELDS) / 1_000_000
    return result if math.isfinite(result) else None


def usage(requests: list[dict]) -> dict:
    counts = {key: sum(req["tokens"][key] for req in requests) for key in TOKEN_FIELDS}
    counts["total"] = sum(counts.values())
    counts["unknown"] = sorted(
        {key for req in requests for key in req["tokens"]["unknown"]}
    )
    priced = [req["costUsd"] for req in requests if req["costUsd"] is not None]
    return {
        "requests": len(requests),
        "tokens": counts,
        "costUsd": sum(priced) if requests and len(priced) == len(requests) else None,
        "pricedRequests": len(priced),
    }


def request_key(node: dict) -> str:
    return str(node["request_id"] or node["message_id"] or f"node:{node['node_id']}")


def read_request(node: dict, fallback_model: str, prices: dict) -> dict | None:
    if node["role"] != "assistant" or not node["metrics"]:
        return None
    try:
        metrics = json.loads(node["metrics"])
    except (TypeError, ValueError):
        return None
    if not isinstance(metrics, dict):
        return None
    model = node["generation_model"] or fallback_model or "unknown"
    tokens = token_counts(metrics)
    duration = number(metrics.get("total_time_ms"))
    ttft = number(metrics.get("ttft_ms"))
    if ttft is not None and duration is not None and ttft > duration:
        ttft = None
    tps = number(metrics.get("tokens_per_sec"))
    kind = "reported" if tps is not None else "unavailable"
    if tps is None and duration and "output" not in tokens["unknown"]:
        tps = tokens["output"] * 1000 / duration
        kind = "request"
    finished = timestamp(node["finished_at"])
    if finished is None:
        finished = timestamp(node["created_at"])
    return {
        "id": request_key(node),
        "nodeId": node["node_id"],
        "scope": "delegated",
        "model": model,
        "finishedAt": finished,
        "durationMs": duration,
        "ttftMs": ttft,
        "tps": tps,
        "tpsKind": kind,
        "tokens": tokens,
        "costUsd": estimate_cost(model, tokens, prices),
    }


def walk(head: int | None, nodes: dict[int, dict], warnings: list[str]) -> list[dict]:
    """Return a retained branch in ancestor order, never an arbitrary sibling."""
    result, visited = [], set()
    while head is not None:
        if head in visited or head not in nodes:
            warning = "Trilha incompleta ou cíclica; parte do histórico não pôde ser atribuída."
            if warning not in warnings:
                warnings.append(warning)
            break
        visited.add(head)
        node = nodes[head]
        result.append(node)
        head = node["parent_node_id"]
    return list(reversed(result))


def summarize(session: dict, rows: list[dict], prices: dict, now: float) -> dict:
    nodes = {row["node_id"]: row for row in rows}
    warnings: list[str] = []
    chain = walk(session["main_chain_id"], nodes, warnings)
    requests: dict[str, dict] = {}
    by_node: dict[int, str] = {}
    for row in rows:
        req = read_request(row, session["model"], prices)
        if req is None:
            continue
        key = req["id"]
        by_node[row["node_id"]] = key
        previous = requests.get(key)
        # Cloned nodes represent the same inference. Prefer the most complete
        # metadata; for equally complete copies, the later stored row wins.
        if previous is None or len(req["tokens"]["unknown"]) <= len(previous["tokens"]["unknown"]):
            requests[key] = req
    main_keys = {by_node[n["node_id"]] for n in chain if n["node_id"] in by_node}
    for key in main_keys:
        requests[key]["scope"] = "lead"

    turns, assigned, current = [], set(), None
    for node in chain:
        if node["role"] == "user" and node["is_user_input"] == 1:
            prompt_id = str(node["client_message_id"] or f"node:{node['node_id']}")
            if current is None or current["id"] != prompt_id:
                current = {
                    "id": prompt_id,
                    "index": len(turns) + 1,
                    "startedAt": timestamp(node["finished_at"]),
                    "_last": node,
                    "_lead": [],
                    "_delegated": [],
                }
                if current["startedAt"] is None:
                    current["startedAt"] = timestamp(node["created_at"])
                turns.append(current)
        if current is None:
            continue
        if node["role"] != "system":
            current["_last"] = node
        key = by_node.get(node["node_id"])
        if key and key not in assigned:
            current["_lead"].append(requests[key])
            assigned.add(key)
        # Persistent workers contain their earlier handoffs too. Attribute each
        # request only to the FIRST main-chain handoff that returns that branch.
        target = node["delegated_head"]
        if isinstance(target, str) and target.isdecimal():
            target = int(target)
        if isinstance(target, int) and not isinstance(target, bool):
            for delegated_node in walk(target, nodes, warnings):
                delegated_key = by_node.get(delegated_node["node_id"])
                if delegated_key and delegated_key not in assigned and delegated_key not in main_keys:
                    current["_delegated"].append(requests[delegated_key])
                    assigned.add(delegated_key)

    result_turns = []
    for i, turn in enumerate(turns):
        last = turn["_last"]
        terminal = (
            last["role"] == "assistant"
            and last["node_id"] in by_node
            and not last["tool_count"]
            and not last["has_tool_content"]
        )
        state = "complete" if terminal else ("open" if i == len(turns) - 1 else "superseded")
        ended = requests[by_node[last["node_id"]]]["finishedAt"] if terminal else None
        until = ended if terminal else (now if state == "open" else None)
        started = turn["startedAt"]
        elapsed = until - started if until is not None and started is not None and until >= started else None
        lead, delegated = turn["_lead"], turn["_delegated"]
        result_turns.append({
            "id": turn["id"],
            "index": turn["index"],
            "startedAt": started,
            "endedAt": ended,
            "state": state,
            "elapsedMs": elapsed,
            "lead": usage(lead),
            "delegated": usage(delegated),
            "lastRequest": lead[-1] if lead else None,
            "requests": sorted(
                lead + delegated,
                key=lambda req: (req["finishedAt"] or 0, req["nodeId"]),
            ),
        })
    if not chain and rows:
        warnings.append("O Devin não publicou uma trilha principal legível para esta sessão.")
    return {
        "id": session["id"],
        "title": session["title"] or session["id"],
        "directory": session["working_directory"],
        "model": session["model"],
        "warnings": warnings,
        "totals": usage(list(requests.values())),
        "unassignedRequests": len(set(requests) - assigned),
        "turns": list(reversed(result_turns)),
    }


def inside_workspace(directory: str, workspace: str) -> bool:
    try:
        directory = os.path.normcase(os.path.realpath(directory))
        workspace = os.path.normcase(os.path.realpath(workspace))
        return os.path.commonpath((directory, workspace)) == workspace
    except (ValueError, OSError):
        return False


def snapshot(
    database_path: str = "",
    session_id: str | None = None,
    workspace_paths: list[str] | None = None,
    prices: dict | None = None,
    now_ms: float | None = None,
) -> dict:
    """A consistent read-only snapshot. Null/unknown never means a zero bill."""
    now = now_ms if now_ms is not None else time.time() * 1000
    result = {
        "schemaVersion": 1,
        "observedAt": now,
        "source": {"state": "ready", "message": None},
        "sessions": [],
        "selectedSessionId": None,
        "session": None,
    }
    path = Path(os.path.expandvars(database_path)).expanduser() if database_path else default_database()
    if not path.is_file():
        result["source"] = {
            "state": "missing",
            "message": "Banco local do Devin não encontrado. Abra uma sessão local ou configure o caminho.",
        }
        return result
    connection = None
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        sessions = [dict(row) for row in connection.execute(SESSIONS_SQL)]
        if session_id and not any(s["id"] == session_id for s in sessions):
            selected = connection.execute(
                """SELECT id,title,working_directory,model,last_activity_at,main_chain_id
                   FROM sessions WHERE id=? AND hidden=0""",
                (session_id,),
            ).fetchone()
            if selected:
                sessions.append(dict(selected))
        result["sessions"] = [{
            "id": s["id"], "title": s["title"] or s["id"],
            "directory": s["working_directory"], "model": s["model"],
            "updatedAt": timestamp(s["last_activity_at"]) or 0,
        } for s in sessions]
        selected = None
        for s in sessions:
            if session_id:
                matches = s["id"] == session_id
            else:
                matches = not workspace_paths or any(
                    inside_workspace(s["working_directory"], workspace) for workspace in workspace_paths
                )
            if matches:
                selected = s
                break
        if selected is None:
            result["source"]["message"] = "Nenhuma sessão corresponde à seleção. Escolha uma sessão no painel."
            return result
        rows = [dict(row) for row in connection.execute(NODES_SQL, (selected["id"],))]
        result["selectedSessionId"] = selected["id"]
        result["session"] = summarize(selected, rows, prices or {}, now)
        return result
    except (sqlite3.Error, ValueError, TypeError, OverflowError):
        result["source"] = {
            "state": "error",
            "message": "Não foi possível ler as métricas. O banco pode estar ocupado ou ter um formato incompatível.",
        }
        result["session"] = None
        result["selectedSessionId"] = None
        return result
    finally:
        if connection is not None:
            connection.close()
