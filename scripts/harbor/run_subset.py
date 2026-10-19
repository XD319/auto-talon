"""Serial, fail-closed Harbor diagnostic runner. Requires a reviewed subset lock.

Usage: python scripts/harbor/run_subset.py <smoke|formal> <subset-lock.json> <packed-agent.tgz> <usd-cny-rate>
No score-based task selection or automatic retries. Formal mode requires smoke.ok.
"""
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARMS = ("governed", "comprehensive-ablation")
LOCAL_HARBOR = ROOT / "eval-artifacts" / "harbor" / "python"
PRICING_USD_CNY = 6.7298


def code_identity() -> dict[str, str]:
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    diff = subprocess.check_output(["git", "diff", "HEAD"], cwd=ROOT)
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, text=True).splitlines()
    hasher = hashlib.sha256()
    for relative in sorted(untracked):
        path = ROOT / relative
        if not path.is_file() or relative.startswith(("eval-artifacts/", ".auto-talon/")):
            continue
        hasher.update(relative.encode())
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return {"codeCommit": commit, "diffSha256": hashlib.sha256(diff).hexdigest(), "untrackedSha256": hasher.hexdigest()}


def harbor_task_filter(task_id: str) -> str:
    # Packaged Terminal-Bench ids are "<namespace>/<directory>". The lock stores the directory name.
    return task_id if "/" in task_id else f"terminal-bench/{task_id}"


def harbor_command() -> list[str]:
    executable = shutil.which("harbor")
    if executable:
        return [executable]
    if (LOCAL_HARBOR / "harbor").is_dir():
        os.environ["PYTHONPATH"] = str(LOCAL_HARBOR) + os.pathsep + os.environ.get("PYTHONPATH", "")
        return [sys.executable, "-c", "from harbor.cli.main import app; app()"]
    raise RuntimeError("Harbor is not installed")


def run(command: list[str]) -> None:
    env = os.environ.copy()
    # Harbor's summary prints a bullet; a GBK Windows console turns that into a false job failure.
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.run(command, cwd=ROOT, check=True, env=env)


def verify_dataset_lock(lock: dict) -> None:
    task_root = ROOT / "eval-artifacts" / "harbor" / "dataset-v6" / "terminal-bench-2-1"
    task_files = sorted(task_root.glob("*/task.toml"))
    if not task_files or str(lock["datasetVersion"]) != "6":
        raise RuntimeError("Pinned Harbor dataset v6 download is missing")
    metadata_hash = hashlib.sha256(b"".join(
        path.relative_to(task_root).as_posix().encode() + b"\0" + path.read_bytes()
        for path in task_files)).hexdigest()
    if metadata_hash != lock["datasetTaskMetadataSha256"]:
        raise RuntimeError("Official dataset metadata differs from the locked version")
    by_id = {item["id"]: item for item in lock["taskMetadata"]}
    for task_id in lock["taskIds"]:
        path = task_root / task_id / "task.toml"
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != by_id[task_id]["taskTomlSha256"]:
            raise RuntimeError(f"Locked task metadata changed: {task_id}")


def record_invalid(output: Path, mode: str, task_id: str, arm: str, job_dir: Path, reason: str) -> None:
    with (output / "invalid-trials.jsonl").open("a", encoding="utf-8") as file:
        file.write(json.dumps({"mode": mode, "taskId": task_id, "arm": arm,
                               "jobDir": str(job_dir), "reason": reason}) + "\n")


def reward(result: dict) -> float:
    if result.get("exception_info"):
        raise RuntimeError(f"Harbor trial exception: {result['exception_info'].get('exception_type')}")
    verifier = result.get("verifier_result") or {}
    rewards = verifier.get("rewards") or {}
    value = verifier.get("reward", rewards.get("reward"))
    if not isinstance(value, (float, int)):
        raise RuntimeError("Official Harbor verifier reward missing")
    return float(value)


def sunk_cost_usd(output: Path) -> float:
    path = output / "sunk-cost.json"
    if not path.is_file():
        return 0.0
    value = json.loads(path.read_text(encoding="utf-8")).get("costUsd", 0)
    if not isinstance(value, (int, float)) or value < 0:
        raise SystemExit("sunk-cost.json costUsd must be a non-negative number")
    return float(value)


def write_report(output: Path, records: list[dict], locked_ids: list[str], rate: float, sunk_usd: float = 0) -> None:
    formal = [record for record in records if record["mode"] == "formal"]
    by_key = {(record["taskId"], record["arm"]): record for record in formal}
    pairs = []
    for task_id in locked_ids:
        product = by_key.get((task_id, "governed"))
        control = by_key.get((task_id, "comprehensive-ablation"))
        if product is None or control is None:
            continue
        pairs.append({"taskId": task_id, "productReward": product["reward"], "controlReward": control["reward"],
                      "roundsDelta": product["rounds"] - control["rounds"],
                      "toolCallsDelta": product["toolCalls"] - control["toolCalls"],
                      "tokensDelta": product["tokens"] - control["tokens"]})
    def interval(field: str) -> dict:
        values = [pair[field] for pair in pairs]
        count = len(values)
        if not count:
            return {"n": 0, "mean": None, "ci95": None}
        mean = sum(values) / count
        if count < 2:
            return {"n": count, "mean": mean, "ci95": None}
        variance = sum((value - mean) ** 2 for value in values) / (count - 1)
        critical = [None, None, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262][count]
        margin = critical * math.sqrt(variance / count)
        return {"n": count, "mean": mean, "ci95": [mean - margin, mean + margin]}
    report = {"kind": "diagnostic_subset", "complete": len(formal) == 20,
              "lockedTaskIds": locked_ids, "validFormalTrials": len(formal), "paired": pairs,
              "pairedIntervals": {field: interval(field) for field in ("roundsDelta", "toolCallsDelta", "tokensDelta")},
              "successCases": [pair for pair in pairs if pair["productReward"] > 0],
              "failureCases": [pair for pair in pairs if pair["productReward"] == 0 or pair["controlReward"] == 0],
              "spentCnyIncludingSmoke": (sum(record["costUsd"] for record in records) + sunk_usd) * rate,
              "interpretation": "Diagnostic subset only; not comparable to full Terminal-Bench leaderboard"}
    if len(pairs) == 10:
        wins = [sum(pair[key] > 0 for pair in pairs) for key in ("productReward", "controlReward")]
        report["taskDiscrimination"] = "insufficient" if all(value >= 9 for value in wins) or all(value <= 1 for value in wins) else "diagnostic"
    (output / "comparison.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 5 or sys.argv[1] not in ("smoke", "formal"):
        raise SystemExit("Usage: run_subset.py <smoke|formal> <lock.json> <agent.tgz> <usd-cny-rate>")
    mode, lock_path, tarball, rate = sys.argv[1], Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve(), float(sys.argv[4])
    if abs(rate - PRICING_USD_CNY) > 0.00001 or not tarball.is_file():
        raise SystemExit("Rate must match 6.7298 used to convert locked Qwen pricing; repack and relock for a new rate")
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if len(lock["taskIds"]) != 10 or len(set(lock["taskIds"])) != 10:
        raise SystemExit("The reviewed lock must have exactly ten distinct task IDs")
    verify_dataset_lock(lock)
    for arm in ARMS:
        path = ROOT / "scripts" / "harbor" / "arms" / (arm + ".json")
        if hashlib.sha256(path.read_bytes()).hexdigest() != lock["arms"][arm]:
            raise SystemExit(f"Arm config changed after subset lock: {arm}")
    if not os.environ.get("DASHSCOPE_API_KEY"):
        raise SystemExit("DASHSCOPE_API_KEY missing")
    run(["docker", "info", "--format", "{{.ServerVersion}}"])
    harbor = harbor_command()
    run([*harbor, "--version"])
    output = lock_path.parent
    smoke_marker = output / "smoke.ok"
    oracle_marker = output / "oracle.ok"
    if mode == "formal" and not smoke_marker.exists():
        raise SystemExit("Oracle and two-task smoke must pass before formal runs")
    if mode == "formal" and not oracle_marker.exists():
        raise SystemExit("Oracle check missing")
    if mode == "formal" and json.loads(oracle_marker.read_text(encoding="utf-8"))["lockSha256"] != hashlib.sha256(lock_path.read_bytes()).hexdigest():
        raise SystemExit("Subset lock changed after oracle")
    if mode == "formal" and json.loads(smoke_marker.read_text(encoding="utf-8"))["lockSha256"] != hashlib.sha256(lock_path.read_bytes()).hexdigest():
        raise SystemExit("Subset lock changed after smoke")
    manifest_path = output / "run-manifest.json"
    identity = code_identity()
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest["lockSha256"] != hashlib.sha256(lock_path.read_bytes()).hexdigest() or
                manifest["tarballSha256"] != hashlib.sha256(tarball.read_bytes()).hexdigest() or manifest["usdCny"] != rate or
                manifest.get("codeCommit") != identity["codeCommit"] or manifest.get("diffSha256") != identity["diffSha256"] or
                manifest.get("untrackedSha256") != identity["untrackedSha256"]):
            raise SystemExit("Packed code or exchange rate changed mid-batch")
    else:
        manifest = {"lockSha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(),
                    "tarballSha256": hashlib.sha256(tarball.read_bytes()).hexdigest(), "usdCny": rate,
                    "maxCny": 50, "model": lock["model"], **identity,
                    "costMethod": "per-request Qwen input-size tier; cache-miss upper bound in USD at locked exchange rate",
                    "priceSource": "https://help.aliyun.com/zh/model-studio/qwen3-7-flash",
                    "fxSource": "https://www.boc.cn/sourcedb/whpj/enindex_1619.html",
                    "fxQuotedAt": "2026-10-14T00:27:23+08:00"}
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    ledger_path = output / "ledger.jsonl"
    if (output / "invalid-trials.jsonl").exists():
        raise SystemExit("Invalid trial requires manual cost and failure audit before resuming")
    records = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines()] if ledger_path.exists() else []
    sunk = sunk_cost_usd(output)
    spent = sum(record["costUsd"] for record in records) + sunk
    task_ids = lock["taskIds"][:2] if mode == "smoke" else lock["taskIds"]
    jobs = output / "jobs"
    jobs.mkdir(exist_ok=True)
    if mode == "smoke" and not oracle_marker.exists():
        oracle_dir = jobs / "smoke-oracle"
        if oracle_dir.exists():
            raise SystemExit(f"Oracle job already exists without validated marker: {oracle_dir}")
        run([*harbor, "run", "-d", f"{lock['dataset']}@{lock['datasetVersion']}",
             "-a", "oracle", "-i", harbor_task_filter(lock["taskIds"][0]), "-n", "1", "-k", "1",
             "-o", str(jobs), "--job-name", "smoke-oracle", "--yes"])
        official = [path for path in oracle_dir.rglob("result.json") if path.parent != oracle_dir]
        if len(official) != 1 or reward(json.loads(official[0].read_text(encoding="utf-8"))) != 1:
            raise RuntimeError("Official oracle smoke did not pass")
        oracle_marker.write_text(json.dumps({"lockSha256": manifest["lockSha256"]}) + "\n", encoding="utf-8")
    for task_id in task_ids:
        for arm in ARMS:
            if any(record["mode"] == mode and record["taskId"] == task_id and record["arm"] == arm for record in records):
                continue
            # Keep a one-trial reserve on top of the per-trial $0.20 task limit.
            if (spent + 0.4) * rate >= 50:
                raise SystemExit("CNY 50 cap or one-trial reserve reached; batch incomplete")
            job_name = f"{mode}-{arm}-{task_id}"
            job_dir = jobs / job_name
            if job_dir.exists():
                raise SystemExit(f"Job already exists without ledger entry: {job_dir}")
            command = [*harbor, "run", "-d", f"{lock['dataset']}@{lock['datasetVersion']}",
                       "-a", "scripts.harbor.autotalon_agent:AutoTalonAgent", "-m", "qwen/qwen3.7-flash",
                       "--ak", f"tarball_path={tarball}", "--ak", f"arm_config_path={ROOT / 'scripts' / 'harbor' / 'arms' / (arm + '.json')}",
                       "--ak", "max_iterations=20", "-i", harbor_task_filter(task_id), "-n", "1", "-k", "1",
                       "-o", str(jobs), "--job-name", job_name,
                       "--allow-agent-host", "dashscope.aliyuncs.com", "--yes"]
            try:
                run(command)
            except subprocess.CalledProcessError as error:
                record_invalid(output, mode, task_id, arm, job_dir, f"Harbor job failed: exit {error.returncode}")
                raise
            official = list(job_dir.rglob("result.json"))
            official = [path for path in official if path.parent != job_dir]
            internal = list(job_dir.rglob("autotalon-trial.json"))
            if len(official) != 1 or len(internal) != 1:
                reason = "Missing or ambiguous official/internal trial artifacts"
                if len(official) == 1:
                    try:
                        info = json.loads(official[0].read_text(encoding="utf-8")).get("exception_info") or {}
                    except (OSError, json.JSONDecodeError):
                        info = {}
                    if info:
                        message = str(info.get("exception_message", ""))
                        reason = f"Harbor trial exception before artifacts: {info.get('exception_type')}: {message[-500:]}"
                record_invalid(output, mode, task_id, arm, job_dir, reason)
                raise RuntimeError(f"{reason}: {job_dir}")
            trial = json.loads(internal[0].read_text(encoding="utf-8"))
            runtime_error = (trial.get("task") or {}).get("errorMessage") or ""
            invalid_provider = any(fragment in runtime_error.lower() for fragment in (
                "insufficient balance", "insufficient quota", "invalid api key", "unauthorized",
                "authentication", "protocol", "model not found", "rate limit"))
            if invalid_provider or any(event.get("eventType") == "provider_request_failed" for event in trial.get("trace", [])):
                record_invalid(output, mode, task_id, arm, job_dir, f"Provider/protocol failure: {runtime_error}")
                raise RuntimeError(f"Invalid provider trial: {job_dir}")
            if mode == "smoke" and not trial.get("toolCalls"):
                record_invalid(output, mode, task_id, arm, job_dir, "No tool calls in agent smoke")
                raise RuntimeError(f"Agent smoke did not exercise tool calls: {job_dir}")
            cost = trial.get("costUsd")
            if trial.get("costCoverage") != 1 or not isinstance(cost, (int, float)):
                record_invalid(output, mode, task_id, arm, job_dir, "Cost coverage below 100%")
                raise RuntimeError(f"Cost coverage below 100%: {job_dir}")
            try:
                score = reward(json.loads(official[0].read_text(encoding="utf-8")))
            except (RuntimeError, ValueError, json.JSONDecodeError) as error:
                record_invalid(output, mode, task_id, arm, job_dir, f"Official scoring failed: {error}")
                raise
            usage = [event.get("payload", {}).get("usage", {}) for event in trial["trace"]
                     if event.get("eventType") == "provider_request_succeeded"]
            tokens = sum(int(item.get("totalTokens") or
                             (item.get("inputTokens", 0) + item.get("outputTokens", 0))) for item in usage)
            record = {"mode": mode, "taskId": task_id, "arm": arm, "reward": score, "costUsd": cost,
                      "jobDir": str(job_dir), "rounds": trial["task"]["currentIteration"],
                      "toolCalls": len(trial["toolCalls"]), "tokens": tokens,
                      "runtimeStatus": trial["task"]["status"], "runtimeError": runtime_error,
                      "runExitCode": trial.get("runExitCode")}
            with ledger_path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(record) + "\n")
            records.append(record)
            spent += cost
            write_report(output, records, lock["taskIds"], rate, sunk)
            if spent * rate >= 50:
                raise SystemExit("CNY 50 cap reached; batch incomplete")
    if mode == "smoke":
        smoke_marker.write_text(json.dumps({"lockSha256": manifest["lockSha256"], "trialCount": 4}) + "\n", encoding="utf-8")
    write_report(output, records, lock["taskIds"], rate, sunk)
    print(json.dumps({"mode": mode, "completedTrials": len([r for r in records if r["mode"] == mode]),
                      "spentCny": spent * rate}, indent=2))


if __name__ == "__main__":
    main()
