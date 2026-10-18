"""本机 ACP 握手和持续推理测量；不监听端口，不打开浏览器，不修改 Hermes 配置。"""

import argparse
import json
from pathlib import Path
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native-bridge"))
from copilot import DEFAULTS, private_write, Templates, inference_session_prompt, model_json_prompt
from copilot_acp import ACP


def measure(directory, output, samples=1, profile=None):
    directory = Path(directory).expanduser().resolve()
    config = {**DEFAULTS, **json.loads((directory / "config.json").read_text())}
    if profile:
        config["inference_profile"] = profile
    events = []
    runtime = ACP(config, directory, lambda event: events.append(event))
    measurements = []
    try:
        started = time.monotonic()
        runtime.start()
        handshake = time.monotonic() - started
        result, startup_metrics = model_json_prompt(
            runtime, inference_session_prompt(Templates(directory / "templates"))
        )
        if result.get("ready") is not True:
            raise ValueError("inference session not ready")
        for index in range(samples):
            result, metrics = model_json_prompt(
                runtime,
                json.dumps(
                    {
                        "session_title": "协作·测量",
                        "type": "infer",
                        "instruction": '不使用任何工具。仅返回严格 JSON {"scene":"general","suggestions":[]}。',
                        "steps": [{"description": "选中 synthetic keyword", "at": index}],
                        "page": {
                            "url": "https://example.test/",
                            "title": "Synthetic measurement",
                            "items": [],
                        },
                    }
                ),
            )
            if result != {"scene": "general", "suggestions": []}:
                raise ValueError("unexpected inference output")
            measurements.append(metrics)
            print(json.dumps({"sample": index + 1, **metrics}), flush=True)
        private_write(
            Path(output).expanduser().resolve(),
            json.dumps(
                {
                    "handshake_seconds": handshake,
                    "samples": measurements,
                    "p50_operation_to_suggestion_seconds": statistics.median(
                        row["seconds"] for row in measurements
                    )
                    + 1.5,
                    "profile": config["inference_profile"],
                    "startup": startup_metrics,
                    "tools_verified": runtime.tools_verified,
                    "target_tokens_per_turn": 3000,
                    "target_met": all(row["tokens"] <= 3000 for row in measurements),
                    "events": events[:100],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
    finally:
        runtime.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--profile", help="inference Hermes profile, defaults to configured fast-copilot"
    )
    parser.add_argument("--samples", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.samples <= 10:
        parser.error("samples must be 1..10")
    measure(args.directory, args.output, args.samples, args.profile)
