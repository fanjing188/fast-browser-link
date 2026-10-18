"""新建或升级未被修改的受管协作 profile；不复制凭据，不碰未知 profile。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

base = Path(__file__).resolve().parents[1]
sys.path.insert(
    0,
    str(
        next(
            (
                path
                for path in (base / "native-bridge", base / "native_bridge", base)
                if (path / "copilot.py").is_file()
            ),
            base / "native-bridge",
        )
    ),
)
from fbl_profiles import desired, profile_plan


def setup(root, model, provider="auto", apply=False, command="hermes", profile="fast-copilot"):
    root = Path(root).expanduser().absolute()
    if profile != "fast-copilot":
        raise ValueError("only dedicated copilot profiles may be created")
    target = root / "profiles" / profile
    if any(part.is_symlink() for part in (target, *target.parents)):
        raise ValueError("refusing symlink profile path")
    config = (
        desired(model, provider)
        if target.exists()
        else profile_plan(root, profile, model, provider)["config"]
    )
    # 中文注释：JSON 是 YAML 子集，不依赖用户安装 PyYAML；空 SOUL 防止默认长人格再次被播种。
    files = {
        "config.yaml": json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        "SOUL.md": "",
        "AGENTS.md": "",
        "workspace/AGENTS.md": "",
        "workspace/.hermes.md": "",
    }
    hashes = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()}
    print("Plan: create only " + str(target))
    for name, text in files.items():
        print("\n--- " + name + " ---\n" + (text or "(empty)"))
    print(
        "Credentials are not copied. Hermes may reuse root authentication; configure it only if unavailable."
    )
    marker = target / ".copilot-profile.json"
    if target.exists():
        if not marker.is_file() or marker.is_symlink():
            raise ValueError("unknown existing profile; no writes")
        recorded = json.loads(marker.read_text()).get("files", {})
        if set(recorded) != set(files) or not all(
            (target / name).is_file()
            and not (target / name).is_symlink()
            and hashlib.sha256((target / name).read_bytes()).hexdigest() == digest
            for name, digest in recorded.items()
        ):
            raise ValueError("managed profile was modified; no writes")
        local = target / "plugins/fast-browser-link"
        if local.exists() or local.is_symlink():
            if (
                not local.is_symlink()
                or local.resolve() != (root / "plugins/fast-browser-link").resolve()
            ):
                raise ValueError("managed plugin reference changed; no writes")
        old = json.loads((target / "config.yaml").read_text())
        if old.get("model") != config["model"]:
            raise ValueError("model/provider differs; upgrade does not change models")

        def additions(existing, wanted):
            merged = dict(existing)
            for key, value in wanted.items():
                if key not in merged:
                    merged[key] = value
                elif isinstance(value, dict) and isinstance(merged[key], dict):
                    merged[key] = additions(merged[key], value)
            return merged

        upgraded = additions(old, config)
        upgraded["_config_version"] = max(old.get("_config_version", 0), config["_config_version"])
        upgraded["platform_toolsets"] = config["platform_toolsets"]
        upgraded["plugins"] = config["plugins"]
        text = json.dumps(upgraded, ensure_ascii=False, indent=2) + "\n"
        if (target / "config.yaml").read_text() == text:
            print("Existing matching managed profile; no writes.")
            return
        print(
            "Plan: upgrade verified managed config only (title/approval defaults, ACP decision tools)."
        )
        if not apply:
            print("Preview only. Add --apply to upgrade.")
            return
        path = target / "config.yaml"
        fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        recorded["config.yaml"] = hashlib.sha256(text.encode()).hexdigest()
        marker.write_text(json.dumps({"version": 2, "files": recorded}, indent=2) + "\n")
        marker.chmod(0o600)
        print("Upgraded verified managed profile. Model/provider unchanged.")
        return
    if not apply:
        print("Preview only. Add --apply to create this profile.")
        return
    shared_plugin = root / "plugins/fast-browser-link"
    subprocess.run(
        [command, "profile", "create", profile, "--no-alias", "--no-skills"],
        env={**os.environ, "HERMES_HOME": str(root)},
        check=True,
    )
    if not target.is_dir() or any(part.is_symlink() for part in (target, *target.parents)):
        raise ValueError("profile creation returned an unsafe target")
    for name, text in files.items():
        path = target / name
        if any(part.is_symlink() for part in (path, *path.parents)):
            raise ValueError("new profile contains symlink target")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
    if shared_plugin.is_dir():
        plugins = target / "plugins"
        if plugins.is_symlink():
            raise ValueError("new profile plugins directory is a symlink")
        plugins.mkdir(exist_ok=True)
        (plugins / "fast-browser-link").symlink_to(shared_plugin, target_is_directory=True)
    marker.write_text(json.dumps({"version": 2, "files": hashes}, indent=2) + "\n")
    marker.chmod(0o600)
    print("Created " + profile + ". Existing profiles and active_profile were not changed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--profile", choices=["fast-copilot"], default="fast-copilot")
    parser.add_argument(
        "--model", default="gpt-5.6-luna", help="available inexpensive fast model identifier"
    )
    parser.add_argument("--provider", default="openai-codex")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    setup(args.root, args.model, args.provider, args.apply, profile=args.profile)
