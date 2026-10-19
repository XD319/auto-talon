"""Harbor installed-agent adapter for a locally packed AutoTalon build.

Pass --ak tarball_path=<absolute npm-pack tgz> and --ak arm_config_path=<json>.
The JSON must contain only runtime.config.json overrides, with no credentials.
This adapter must pass a Harbor oracle smoke run before paid trials.
"""
import json
import os
import re
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AutoTalonAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "auto-talon"

    def __init__(self, tarball_path: str, arm_config_path: str, max_iterations: int = 20, **kwargs):
        super().__init__(**kwargs)
        self.tarball_path = Path(tarball_path).resolve()
        self.arm_config_path = Path(arm_config_path).resolve()
        self.max_iterations = int(max_iterations)
        if self.max_iterations < 1 or not self.tarball_path.is_file() or not self.arm_config_path.is_file():
            raise ValueError("Invalid max_iterations, tarball_path, or arm_config_path")
        self.arm_config = json.loads(self.arm_config_path.read_text(encoding="utf-8"))
        if "pricing" not in self.arm_config.get("budget", {}):
            raise ValueError("Harbor arm config must provide budget.pricing")

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(self.tarball_path, "/tmp/autotalon.tgz")
        await self.exec_as_root(environment, command=(
            "set -e; "
            "missing=; "
            "command -v curl >/dev/null || missing=\"$missing curl ca-certificates\"; "
            "command -v gzip >/dev/null || missing=\"$missing gzip\"; "
            "if [ -n \"$missing\" ]; then apt-get update && apt-get install -y $missing; fi; "
            "arch=$(uname -m); case \"$arch\" in x86_64) arch=x64;; aarch64) arch=arm64;; *) exit 42;; esac; "
            "curl -fsSL https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-${arch}.tar.gz "
            "-o /tmp/autotalon-node.tar.gz; "
            "mkdir -p /opt/autotalon-node; tar -xzf /tmp/autotalon-node.tar.gz "
            "-C /opt/autotalon-node --strip-components=1; "
            "/opt/autotalon-node/bin/node --version"
        ))
        result = await self.exec_as_agent(environment, command=(
            "set -e; export PATH=/opt/autotalon-node/bin:$PATH; "
            "mkdir -p $HOME/autotalon-harbor; cd $HOME/autotalon-harbor; "
            "npm init -y >/dev/null; npm install --no-audit --no-fund /tmp/autotalon.tgz; "
            "./node_modules/.bin/talon version"
        ))
        if result.return_code != 0:
            raise RuntimeError(f"AutoTalon installation failed: {result.stderr}")

    def _run_script(self, instruction: str, config: str, provider: str) -> str:
        # Same allow-loop as the eval runner: an unattended container has no reviewer.
        return (
            "set -eu; export PATH=/opt/autotalon-node/bin:$PATH; "
            "mkdir -p .auto-talon; "
            f"printf '%s' {shlex.quote(config)} > .auto-talon/runtime.config.json; "
            f"printf '%s' {shlex.quote(provider)} > .auto-talon/provider.config.json; "
            "talon=$HOME/autotalon-harbor/node_modules/.bin/talon; "
            "rc=0; "
            f"\"$talon\" run {shlex.quote(instruction)} --cwd \"$PWD\" --max-iterations {self.max_iterations} "
            "--timeout-ms 1200000 --json-events > /tmp/autotalon-run.out 2>/tmp/autotalon-run.err || rc=$?; "
            "cat /tmp/autotalon-run.out; "
            "status=$(sed -n '/^Status: /{s/^Status: //p;q;}' /tmp/autotalon-run.out); "
            "guard=0; "
            "while [ \"$status\" = waiting_approval ]; do "
            "guard=$((guard + 1)); "
            "if [ \"$guard\" -gt 100 ]; then echo 'AutoTalon approval loop exceeded' >&2; exit 3; fi; "
            "pending=$(\"$talon\" approve pending); "
            "approval_id=$(printf '%s\n' \"$pending\" | sed -n '1s/ *|.*//p'); "
            "case \"$approval_id\" in "
            "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*) ;; "
            "*) echo 'AutoTalon approval id missing' >&2; printf '%s\n' \"$pending\" >&2; exit 4 ;; "
            "esac; "
            "rc=0; "
            "\"$talon\" approve allow \"$approval_id\" --reviewer harbor-eval "
            "> /tmp/autotalon-run.out 2>/tmp/autotalon-run.err || rc=$?; "
            "cat /tmp/autotalon-run.out; "
            "status=$(sed -n '/^Status: /{s/^Status: //p;q;}' /tmp/autotalon-run.out); "
            "done; "
            "case \"$status\" in "
            "succeeded|failed|cancelled) ;; "
            "*) echo \"AutoTalon stopped at ${status:-missing}\" >&2; exit 5 ;; "
            "esac; "
            "printf '\\nAutoTalon Exit Code: %s\\n' \"$rc\""
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        key = os.environ.get("DASHSCOPE_API_KEY")
        if not key:
            raise RuntimeError("DASHSCOPE_API_KEY missing; invalid trial")
        config = json.dumps(self.arm_config, separators=(",", ":"))
        provider = json.dumps({"version": 1, "currentProvider": "qwen", "customProviders": {
            "qwen": {"baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen3.7-flash",
                         "transport": "openai-compatible", "contextWindowTokens": 1000000}}}, separators=(",", ":"))
        provider_env = {
            "AGENT_PROVIDER": "qwen",
            "AGENT_PROVIDER_MODEL": "qwen3.7-flash",
            "AGENT_PROVIDER_API_KEY": key,
            # One-shot CLI exits after printing status. Eval resolves approvals the same way as talon eval.
            "TALON_FORCE_EXIT": "1",
        }
        result = await self.exec_as_agent(environment, command=self._run_script(instruction, config, provider), env=provider_env)
        task_id = re.search(r"^Task ID: ([\w-]+)$", result.stdout or "", re.M)
        exit_code = re.search(r"^AutoTalon Exit Code: (\d+)$", result.stdout or "", re.M)
        if task_id is None:
            raise RuntimeError("AutoTalon did not emit a task ID; invalid trial")
        if exit_code is None:
            raise RuntimeError("AutoTalon exit code missing; invalid trial")
        remote_export = "/tmp/autotalon-trial.json"
        exported = await self.exec_as_agent(environment,
            command=(
                "export PATH=/opt/autotalon-node/bin:$PATH; "
                f"$HOME/autotalon-harbor/node_modules/.bin/talon task export {shlex.quote(task_id.group(1))} "
                f"> {remote_export}"
            ),
            env=provider_env)
        if exported.return_code != 0:
            raise RuntimeError(f"AutoTalon trace export failed: {exported.stderr}")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        local_export = self.logs_dir / "autotalon-trial.json"
        await environment.download_file(remote_export, local_export)
        details = json.loads(local_export.read_text(encoding="utf-8"))
        trace = details.get("trace", [])
        costs = [event.get("payload", {}).get("costUsd") for event in trace if event.get("eventType") == "cost_report"]
        calls = sum(event.get("eventType") == "provider_request_succeeded" for event in trace)
        if calls == 0 or calls != len(costs) or any(not isinstance(cost, (int, float)) for cost in costs):
            raise RuntimeError("Cost coverage below 100%; invalid trial")
        details["costUsd"] = sum(costs)
        details["costCoverage"] = 1.0
        details["costMethod"] = "Per-request Qwen tier rates converted at locked USD/CNY; cache-miss upper bound"
        details["runExitCode"] = int(exit_code.group(1))
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "autotalon-trial.json").write_text(json.dumps(details, indent=2), encoding="utf-8")
