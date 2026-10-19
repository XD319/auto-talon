"""Lock a reproducible 10-task Terminal-Bench 2.1 diagnostic subset before any runs.

Usage: python scripts/harbor/lock_subset.py <official-dataset-directory> <dataset-version> <output.json> [id1,id2,...,id10]
Use a pinned official Harbor dataset download or a clean pinned git checkout. Review candidate metadata manually before
using the lock; this script deliberately refuses to replace an existing lock.
"""
import hashlib
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path


def main() -> None:
    if len(sys.argv) not in (4, 5):
        raise SystemExit("Usage: lock_subset.py <official-dataset-directory> <dataset-version> <output.json> [10 comma-separated IDs]")
    root, version, output = Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3]).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to replace existing subset lock: {output}")
    git = ["git", "-c", f"safe.directory={root}", "-C", str(root)]
    commit = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip() if (root / ".git").exists() else None
    code_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if commit is not None and subprocess.check_output([*git, "status", "--porcelain"], text=True).strip():
        raise SystemExit("Official dataset checkout must be clean")
    candidates = []
    task_root = root / "tasks" if (root / "tasks").is_dir() else root
    all_task_files = sorted(task_root.glob("*/task.toml"))
    for path in all_task_files:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        environment = data.get("environment", {})
        if environment.get("gpus", 0) != 0 or environment.get("memory_mb", 0) > 4096 or data.get("agent", {}).get("timeout_sec", 0) > 1800:
            continue
        task_dir = path.parent
        description = (task_dir / "instruction.md").read_text(encoding="utf-8")
        dockerfile = task_dir / "environment" / "Dockerfile"
        metadata = json.dumps(data)
        inspected = "\n".join([description, metadata, dockerfile.read_text(encoding="utf-8") if dockerfile.exists() else ""])
        if re.search(r"(?:API[_ -]?KEY|[A-Z_]+_TOKEN|paid account|paid subscription|external credentials)", inspected, re.I):
            continue
        candidates.append({"id": task_dir.name, "taskTomlSha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    if len(candidates) < 10:
        raise SystemExit(f"Only {len(candidates)} eligible candidates; review exclusions manually")
    # Stable pre-run selection by task ID. Scores are never an input.
    if len(sys.argv) == 5:
        requested = sys.argv[4].split(",")
        available = {item["id"]: item for item in candidates}
        if len(requested) != 10 or len(set(requested)) != 10 or any(item not in available for item in requested):
            raise SystemExit("Explicit IDs must be ten distinct eligible tasks")
        selected = [available[item] for item in requested]
        selection_rule = "ten pre-reviewed task IDs chosen from public task metadata for coding, debugging, security, and larger-file diversity; no scores consulted"
    else:
        selected = candidates[:10]
        selection_rule = "alphabetical first ten CPU tasks with <=4GB memory and <=1800s timeout, without external paid credentials"
    metadata_hash = hashlib.sha256(b"".join(path.relative_to(task_root).as_posix().encode() + b"\0" + path.read_bytes() for path in all_task_files)).hexdigest()
    lock = {"kind": "diagnostic_subset", "dataset": "terminal-bench/terminal-bench-2-1",
            "datasetVersion": version, "datasetCommit": commit, "datasetTaskMetadataSha256": metadata_hash,
            "codeCommit": code_commit,
            "model": {"provider": "qwen", "model": "qwen3.7-flash", "maxIterations": 20},
            "arms": {name: hashlib.sha256((Path(__file__).parent / "arms" / (name + ".json")).read_bytes()).hexdigest()
                     for name in ("governed", "comprehensive-ablation")},
            "taskIds": [item["id"] for item in selected],
            "taskMetadata": selected,
            "selectionRule": selection_rule}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(lock, indent=2))


if __name__ == "__main__":
    main()
