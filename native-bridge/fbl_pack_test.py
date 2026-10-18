"""功能包离线验收：复用宿主合同、确定性推荐和命令输出校验。"""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

from copilot_capabilities import Registry
from copilot_contracts import Templates, validate
from copilot_packages import Packages, read_package
from copilot_pack_contracts import localized
from fbl_runtime import private_write, safe


def contained(root, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError("package paths must be relative")
    path = root / relative
    if not path.resolve().is_relative_to(root) or any(
        part.is_symlink() for part in (path, *path.parents) if part.is_relative_to(root)
    ):
        raise ValueError("package path escapes directory or contains symlink")
    return path


def static_check(directory):
    root, value = read_package(safe(Path(directory).expanduser().absolute()))
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("package contains symlink")
    files = value.get("files", [])
    if not isinstance(files, list):
        raise ValueError("package files must be a list")
    for relative in [*value.get("templates", {}).values(), *files]:
        if not contained(root, relative).is_file():
            raise ValueError("missing package file")
    if value.get("experience_file"):
        contained(root, value["experience_file"])
    for command in [
        *value.get("fetchers", {}).values(),
        *value.get("pool", {}).values(),
    ]:
        check_argv(root, command)
    for bindings in value.get("capabilities", {}).values():
        for binding in bindings:
            if "risk" not in binding:
                raise ValueError("binding risk declaration required")
            for key in ("argv", "plan_argv"):
                if key in binding:
                    check_argv(root, binding[key])
            for relative in binding.get("required_paths", []):
                contained(root, relative)
    for flow in value.get("flows", {}).values():
        name = flow.get("name")
        if isinstance(name, dict):
            localized(name, 100)
        elif not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("invalid flow name")
        if "judgment" in flow and type(flow["judgment"]) is not bool:
            raise ValueError("flow judgment must be boolean")
        if "risk" not in flow or any("risk" not in step for step in flow.get("steps", [])):
            raise ValueError("flow and step risk declarations required")
        seen = set()
        for step in flow.get("steps", []):
            sources = [step.get("from", ""), *step.get("input", {}).values()]
            for source in sources:
                if isinstance(source, str) and source.startswith("$steps."):
                    if source.split(".")[1] not in seen:
                        raise ValueError("unknown or forward step reference")
            seen.add(step["id"])
    packages = Packages([root], include_builtin=False)
    for flow in packages.flows.values():
        for step in flow["steps"]:
            if step.get("capability") and not packages.bindings.get(step["capability"]):
                raise ValueError("step capability has no binding")
    templates = Templates(root, packages)
    for action in packages.templates:
        templates.get(action)
    for tool in packages.tools:
        for page in tool.get("pages", []):
            if any(identity not in packages.flows for identity in page.get("flows", [])):
                raise ValueError("page references unknown flow")
    return root, packages


def check_argv(root, argv):
    if not isinstance(argv, list) or not argv:
        raise ValueError("invalid command argv")
    for index, arg in enumerate(argv):
        if not isinstance(arg, str):
            raise ValueError("invalid command argument")
        if index == 0 and "/" not in arg:
            continue
        if (
            arg.startswith("./")
            or "/" in arg
            and "{" not in arg
            or arg.endswith((".py", ".js", ".sh", ".mjs"))
        ):
            if not contained(root, arg).is_file():
                raise ValueError("command file missing from package")


def sandbox_command(registry, binding, inputs, work):
    if not shutil.which("sandbox-exec"):
        raise ValueError("network-denying sandbox unavailable; command not run")
    try:
        return registry._command({**binding, "_automatic": True}, inputs, work, threading.Event())
    except ValueError as error:
        if str(error) == "command failed":
            from copilot_diagnostics import redact

            detail = redact((work / "stderr").read_text(errors="replace"))[:500]
            raise ValueError("sandboxed command failed: " + detail) from error
        raise


def test_pack(directory, command_runner=None):
    checks = []

    def check(kind, name, run):
        try:
            result = run()
            checks.append({"kind": kind, "name": name, "ok": True})
            return result
        except (
            OSError,
            ValueError,
            TypeError,
            KeyError,
            IndexError,
            AttributeError,
            subprocess.SubprocessError,
        ) as error:
            checks.append({"kind": kind, "name": name, "ok": False, "error": str(error)})
            return None

    loaded = check(
        "static", "package contracts, references, risks and paths", lambda: static_check(directory)
    )
    if loaded is None:
        return {"ok": False, "checks": checks}
    root, packages = loaded
    with tempfile.TemporaryDirectory(prefix="fbl-pack-test-") as temporary:
        temporary = str(Path(temporary).resolve())
        registry = Registry(packages, Path(temporary), private_write, validate)
        scenario_file = root / "tests/scenarios.json"
        scenarios = []
        if scenario_file.exists():

            def read_scenarios():
                value = json.loads(scenario_file.read_text())
                if not isinstance(value, list) or len(value) > 100:
                    raise ValueError("scenarios must be a list of at most 100 cases")
                scenarios.extend(value)

            check("scenario", "scenario declarations", read_scenarios)
        for index, scenario in enumerate(scenarios):

            def run_scenario():
                if not isinstance(scenario, dict) or not isinstance(scenario.get("url"), str):
                    raise ValueError("scenario URL required")
                context = {
                    "url": scenario["url"],
                    "tables": scenario.get("tables", []),
                    "follow_completed": scenario.get("follow_completed", []),
                    "dwell_seconds": scenario.get("dwell_seconds", 0),
                }
                completed = context["follow_completed"]
                if (
                    not isinstance(completed, list)
                    or len(completed) > 100
                    or any(
                        not isinstance(row, dict)
                        or row.get("flow") not in packages.flows
                        or row.get("status") not in {"completed", "failed", "stopped", "partial"}
                        or not isinstance(row.get("object"), str)
                        or not isinstance(row.get("records", []), list)
                        for row in completed
                    )
                ):
                    raise ValueError("invalid scenario completions")
                if "table_columns" in scenario:
                    context["tables"] = [
                        {
                            "headers": scenario["table_columns"],
                            "samples": scenario.get("table_rows", []),
                        }
                    ]
                rows = registry.recommendations(context, scenario.get("selection", ""))
                actual = {row["params"]["flow"] for row in rows}
                for field in ("expect", "expect_absent"):
                    wanted = scenario.get(field, [])
                    if not isinstance(wanted, list) or any(
                        item not in packages.flows for item in wanted
                    ):
                        raise ValueError("scenario references unknown flow")
                    failed = set(wanted) - actual if field == "expect" else set(wanted) & actual
                    if failed:
                        raise ValueError(field + ": " + ", ".join(sorted(failed)))

            check("scenario", str(index + 1), run_scenario)
        for capability, bindings in packages.bindings.items():
            for binding in bindings:
                if binding["type"] != "command":
                    continue

                def run_binding():
                    runner = command_runner or sandbox_command
                    if binding.get("risk") == "zero" and binding.get("local_only") is True:
                        fixture_file = contained(root, "tests/fixtures/" + binding["id"] + ".json")
                        fixtures = json.loads(fixture_file.read_text())
                        if not isinstance(fixtures, list) or not 1 <= len(fixtures) <= 100:
                            raise ValueError("fixture list required")
                        for i, fixture in enumerate(fixtures):
                            inputs = fixture["input"]
                            validate(inputs, registry.schemas[capability]["input"])
                            work = Path(temporary) / binding["id"] / str(i)
                            work.mkdir(parents=True)
                            output = runner(registry, binding, inputs, work)
                            validate(output, registry.schemas[capability]["output"])
                            if "expect" in fixture and output != fixture["expect"]:
                                raise ValueError("fixture output differs")
                    else:
                        # 中文注释：帮助也运行在禁止网络、仅临时目录可写的沙箱；不信任风险自声明。
                        sandbox = shutil.which("sandbox-exec")
                        if not sandbox:
                            raise ValueError("network-denying sandbox unavailable; help not run")
                        with tempfile.TemporaryDirectory(dir=temporary) as work:
                            policy = (
                                "(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "
                                + json.dumps(work)
                                + "))"
                            )
                            result = subprocess.run(
                                [sandbox, "-p", policy, *binding["argv"], "--help"],
                                cwd=work,
                                capture_output=True,
                                timeout=3,
                            )
                            if result.returncode:
                                raise ValueError("side-effect-free --help failed")

                check("capability", binding["id"], run_binding)
    return {"ok": all(item["ok"] for item in checks), "checks": checks}


def readable(result):
    return "\n".join(
        ("PASS" if row["ok"] else "FAIL")
        + " "
        + row["kind"]
        + " · "
        + row["name"]
        + (": " + row["error"] if not row["ok"] else "")
        for row in result["checks"]
    )
