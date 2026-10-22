"""标准推荐系统的离线合同、排序、目录和新鲜度验收。"""

import copy
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-bridge"))
from copilot_packages import Packages
from copilot_pack_contracts import validate_recommendation
from copilot_recommendations import (
    rank,
    inventory,
    binding_revision,
    health_scope,
    metadata_current,
    feedback_active,
)
from copilot_capabilities import Registry
from copilot_contracts import private_write, validate
from fbl_discovery import mcp_tool_list, digest as discovery_digest, file_digest


class Recommendations(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.now = 2000000000

    def tearDown(self):
        self.tmp.cleanup()

    def row(self, identity, **values):
        return {
            "id": identity,
            "action": "assist.task",
            "task_type": "page.summary",
            "status": "pending",
            "work_id": "work",
            "material_ids": ["material"],
            "subject_kind": "page",
            **values,
        }

    def ranked(self, rows, **state):
        return rank(rows, {"work_id": "work", **state}, clock=lambda: self.now)

    def package(self, identity, **value):
        path = self.root / identity
        path.mkdir()
        (path / "package.json").write_text(json.dumps({"id": identity, "version": 1, **value}))
        return path

    def test_bad_package_is_atomic_and_default_remains_strict(self):
        good = self.package("good")
        bad = self.package("bad", fetchers={"valid": ["python3"]}, tools="invalid")
        after = self.package("after")
        with self.assertRaises(ValueError):
            Packages([good, bad], include_builtin=False)
        packages = Packages(
            [good, bad, after, self.root / "missing"], include_builtin=False, strict=False
        )
        self.assertEqual(packages.fetchers, {})
        self.assertEqual(
            [r["id"] for r in packages.package_records if r["state"] == "registered"],
            ["good", "after"],
        )
        self.assertEqual(len(packages.load_errors), 2)
        self.assertNotIn(str(self.root), json.dumps(packages.package_records))

    def test_isolated_loader_reload_updates_failures_and_removed_providers(self):
        first = self.package("first", fetchers={"sample": ["python3"]})
        second = self.package("second")
        initial = Packages([first, second], include_builtin=False, strict=False)
        self.assertEqual([r["id"] for r in initial.package_records], ["first", "second"])
        (first / "package.json").write_text('{"id":"first","version":1,"tools":"invalid"}')
        reloaded = Packages([first, second], include_builtin=False, strict=False)
        self.assertEqual(reloaded.fetchers, {})
        self.assertEqual(len(reloaded.load_errors), 1)
        self.assertEqual(reloaded.package_records[1]["id"], "second")
        (first / "package.json").write_text('{"id":"first","version":1}')
        recovered = Packages([first, second], include_builtin=False, strict=False)
        self.assertFalse(recovered.load_errors)
        self.assertTrue(all(r["state"] == "registered" for r in recovered.package_records))
        removed = Packages([second], include_builtin=False, strict=False)
        self.assertEqual([r["id"] for r in removed.package_records], ["second"])

    def test_schema_and_host_reject_unsafe_general_declaration(self):
        declaration = {
            "recommendation_contract": 1,
            "scope": "general",
            "subject_kinds": ["table"],
            "task_type": "table.clean",
            "intent": ["clean"],
        }
        validate_recommendation(declaration)
        for invalid in (
            {"scope": "general"},
            {**declaration, "subject_kinds": []},
            {**declaration, "min_subjects": 4, "max_subjects": 2},
            {**declaration, "script": "arbitrary"},
            {**declaration, "recommendation_contract": True},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_recommendation(invalid)
        try:
            import jsonschema
        except ImportError:
            return
        schema = json.loads((ROOT / "docs/fbl-pack.schema.json").read_text())
        base = {
            "id": "fixture",
            "version": 1,
            "flows": {
                "inspect": {
                    "name": "Inspect",
                    "steps": [{"id": "read", "transform": "pick"}],
                    "recommendation": declaration,
                }
            },
        }
        jsonschema.Draft202012Validator(schema).validate(base)
        base["flows"]["inspect"]["recommendation"] = {
            "recommendation_contract": 1,
            "scope": "general",
        }
        self.assertTrue(list(jsonschema.Draft202012Validator(schema).iter_errors(base)))

    def test_legacy_projection_does_not_expand_page_scope(self):
        packages = Packages()
        identity = next(iter(packages.flows))
        record = packages.task_descriptor(identity)
        self.assertEqual(record["scope"], "page")
        self.assertTrue(record["adapter_ready"])
        packages.flows[identity]["recommendation"] = {
            "recommendation_contract": 1,
            "scope": "general",
            "subject_kinds": ["table"],
        }
        self.assertFalse(packages.task_descriptor(identity)["adapter_ready"])
        self.assertEqual(packages.matching_flows({"url": "https://unrelated.test"}), {})

    def test_preserves_explicit_running_results_even_when_stale(self):
        rows = [
            self.row("explicit", explicit=True, stale=True),
            self.row("running", status="executing", work_id="other"),
            self.row("result", status="completed", stale=True),
            self.row("stale", stale=True),
            self.row("other", work_id="other"),
        ]
        self.assertEqual([r["id"] for r in self.ranked(rows)], ["explicit", "running", "result"])
        self.assertNotIn("recommendation_rank", rows[0])

    def test_expiry_navigation_feedback_and_snapshot_scope(self):
        rows = [
            self.row("live", live_reference=True, document_id="old"),
            self.row("snapshot"),
            self.row("expired", expires_at=self.now),
            self.row("later"),
            self.row("ignored"),
        ]
        result = self.ranked(
            rows,
            page_context={"document_id": "new"},
            work_feedback=[
                {"id": "later", "kind": "later", "at": self.now, "until": self.now + 3600},
                {"id": "ignored", "kind": "irrelevant"},
            ],
        )
        self.assertEqual([r["id"] for r in result], ["snapshot"])

    def test_multi_provider_merges_only_compatible_contracts(self):
        rows = [
            self.row("a", descriptor_ref="plugin:a", compatibility_key="contract"),
            self.row("b", descriptor_ref="plugin:b", compatibility_key="contract"),
            self.row("c", descriptor_ref="plugin:c", compatibility_key="other"),
            self.row("d", descriptor_ref="plugin:d"),
        ]
        result = self.ranked(rows)
        self.assertEqual([r["id"] for r in result], ["a", "c", "d"])
        self.assertEqual(result[0]["providers"][0]["id"], "b")

    def test_ten_automatic_cards_share_one_recommendation_area(self):
        rows = [
            self.row(
                str(i),
                material_ids=[str(i)],
                task_type="page.summary" if i < 5 else "page." + str(i),
                missing_capabilities=["model"] if i > 10 else [],
            )
            for i in range(15)
        ]
        result = self.ranked(rows)
        self.assertEqual(len(result), 10)
        main = [r for r in result if r["recommendation_section"] == "main"]
        self.assertEqual(len(main), 10)
        self.assertTrue(all(r["recommendation_section"] == "main" for r in result))
        self.assertEqual([r["recommendation_rank"] for r in result], list(range(10)))
        self.assertEqual(result, self.ranked(list(reversed(rows))))

    def test_blocked_automatic_tasks_share_one_preparation_hint(self):
        rows = [self.row("local", task_type="table.clean", local_task=True)]
        rows += [
            self.row(
                f"blocked-{i}",
                task_type=f"page.task{i}",
                material_ids=[f"m{i}"],
                recommendation_state="blocked",
                missing_capabilities=["agent"],
            )
            for i in range(3)
        ]
        result = self.ranked(rows)
        self.assertEqual(
            [r["id"] for r in result if r["recommendation_section"] == "main"], ["local"]
        )
        prepared = [r for r in result if r["recommendation_section"] == "preparation"]
        self.assertEqual(len(prepared), 1)
        self.assertEqual(prepared[0]["recommendation_state"], "blocked")
        self.assertEqual(result, self.ranked(list(reversed(rows))))

    def test_type_diversity_is_applied_before_the_ten_card_cutoff(self):
        rows = [
            self.row(f"same-{i}", task_type="table.clean", material_ids=[f"m{i}"])
            for i in range(12)
        ]
        rows += [
            self.row(f"other-{i}", task_type=f"page.task{i}", material_ids=[f"other{i}"])
            for i in range(9)
        ]
        result = self.ranked(rows)
        self.assertEqual(len(result), 10)
        self.assertEqual(len({r["task_type"] for r in result}), 10)
        self.assertEqual(result, self.ranked(list(reversed(rows))))

    def test_verified_followup_and_missing_material_ranking(self):
        result = self.ranked(
            [
                self.row("fresh", evidence_at=self.now),
                self.row("follow", from_result=True, result_verified=True, material_ids=["other"]),
                self.row("missing", recommendation_state="needs_material", material_ids=["third"]),
            ]
        )
        self.assertEqual(result[0]["id"], "follow")
        self.assertIn(
            "parameters_required", next(r for r in result if r["id"] == "missing")["reason_codes"]
        )
        older = self.ranked([self.row("fresh", evidence_at=self.now - 61)])
        self.assertNotEqual(result[1]["ranking_input_digest"], older[0]["ranking_input_digest"])

    def test_browser_health_ttl_scope_implementation_and_disabled(self):
        packages = Packages()
        registry = Registry(packages, self.root, private_write, validate, clock=lambda: self.now)
        binding = {
            "id": "fixture",
            "type": "browser",
            "tool": "google-search",
            "link": "search",
            "page": "serp",
            "verified": True,
        }
        context = {"browser": "chrome", "instance": "browser", "epoch": 1}
        registry.health[binding["id"]] = {
            "status": "available",
            "checked_at": self.now,
            "scope": health_scope(context),
            "implementation_revision": binding_revision(binding),
        }
        self.assertEqual(registry.structural(binding, context), "available")
        self.assertEqual(
            registry.structural(binding, {**context, "browser": "edge"}), "needs_browser_check"
        )
        self.assertEqual(
            registry.structural({**binding, "batch_limit": 2}, context), "needs_browser_check"
        )
        registry.clock = lambda: self.now + 601
        self.assertEqual(registry.structural(binding, context), "needs_browser_check")
        registry.disable(binding, "login")
        self.assertEqual(registry.structural(binding, context), "disabled_today")

    def test_mcp_list_requires_all_pages_and_is_bounded(self):
        calls = []

        def probe(server, method, params=None):
            calls.append((method, params))
            return (
                {
                    "tools": [{"name": "one", "inputSchema": {"type": "object"}}],
                    "nextCursor": "next",
                }
                if params is None
                else {"tools": [{"name": "two", "inputSchema": {"type": "object"}}]}
            )

        self.assertEqual([t["name"] for t in mcp_tool_list({}, probe)["tools"]], ["one", "two"])
        self.assertEqual(calls, [("tools/list", None), ("tools/list", {"cursor": "next"})])
        for probe in (
            lambda *_: {"tools": [], "nextCursor": "loop"},
            lambda *_: {"tools": [{"name": "one"}], "nextCursor": "loop"},
        ):
            with self.assertRaises(ValueError):
                mcp_tool_list({}, probe)

    def test_mcp_confirmed_metadata_ttl_configuration_and_removed_tool(self):
        config = self.root / "config.json"
        config.write_text('{"token":"PRIVATE_SENTINEL"}')
        binding = {
            "id": "mcp-fixture",
            "type": "mcp",
            "config_path": str(config),
            "server": "fixture",
            "tool_name": "read",
        }
        source_id = discovery_digest([str(config), "fixture"])
        input_schema = {"type": "object"}
        contract = discovery_digest(input_schema)
        snapshot = {
            "sources": [
                {
                    "source_id": source_id,
                    "coverage": "complete",
                    "captured_at": self.now,
                    "config_digest": file_digest(config),
                }
            ],
            "mcp_tools": [
                {
                    "source_id": source_id,
                    "name": "read",
                    "contract_digest": contract,
                    "inputSchema": input_schema,
                }
            ],
            "candidates": [
                {
                    "source_id": source_id,
                    "source_ref": str(config),
                    "binding": binding,
                    "contract_digest": contract,
                }
            ],
        }
        target = self.root / "discovery-confirmed.json"
        target.write_text(json.dumps(snapshot))
        self.assertTrue(metadata_current(self.root, binding, self.now))
        self.assertFalse(metadata_current(self.root, binding, self.now + 601, ttl=600))
        draft = self.root / "discovery-draft.json"
        draft.write_text(
            json.dumps(
                {
                    "sources": [
                        {"source_id": source_id, "coverage": "failed", "captured_at": self.now + 1}
                    ]
                }
            )
        )
        self.assertFalse(metadata_current(self.root, binding, self.now + 1))
        draft.write_text(
            json.dumps(
                {
                    "sources": [
                        {
                            "source_id": source_id,
                            "coverage": "complete",
                            "captured_at": self.now + 1,
                            "metadata_digest": "changed",
                        }
                    ]
                }
            )
        )
        self.assertFalse(metadata_current(self.root, binding, self.now + 1))
        draft.unlink()
        self.assertFalse(metadata_current(self.root, binding, self.now + 86401))
        snapshot["mcp_tools"] = []
        target.write_text(json.dumps(snapshot))
        self.assertFalse(metadata_current(self.root, binding, self.now))
        snapshot["mcp_tools"] = [
            {"source_id": source_id, "name": "read", "contract_digest": "contract"}
        ]
        target.write_text(json.dumps(snapshot))
        config.write_text("changed")
        self.assertFalse(metadata_current(self.root, binding, self.now))

    def test_feedback_expiry_and_running_provider_suppress_duplicate(self):
        self.assertFalse(feedback_active({"kind": "later", "until": self.now}, self.now))
        self.assertTrue(feedback_active({"kind": "later"}, self.now, "work"))
        self.assertFalse(feedback_active({"kind": "ignore", "work_id": "other"}, self.now, "work"))
        result = self.ranked(
            [
                self.row(
                    "running",
                    status="executing",
                    descriptor_ref="one",
                    compatibility_key="equivalent",
                ),
                self.row("duplicate", descriptor_ref="two", compatibility_key="equivalent"),
                self.row("different", material_ids=["different"]),
            ]
        )
        self.assertEqual([r["id"] for r in result], ["running", "different"])

    def test_explicit_implementation_file_revision_changes(self):
        script = self.root / "run.py"
        script.write_text("print('one')")
        binding = {"id": "fixture", "type": "command", "argv": [sys.executable, str(script)]}
        before = binding_revision(binding)
        script.write_text("print('two')")
        self.assertNotEqual(before, binding_revision(binding))

    def test_schema_enum_and_fields_match_host_contract(self):
        from copilot_pack_contracts import RECOMMENDATION_KINDS, RECOMMENDATION_INTENTS

        schema = json.loads((ROOT / "docs/fbl-pack.schema.json").read_text())["$defs"][
            "recommendation"
        ]
        self.assertEqual(
            set(schema["properties"]["subject_kinds"]["items"]["enum"]), RECOMMENDATION_KINDS
        )
        self.assertEqual(
            set(schema["properties"]["intent"]["items"]["enum"]), RECOMMENDATION_INTENTS
        )
        self.assertEqual(schema["required"], ["recommendation_contract"])
        for field in schema["properties"]:
            if field == "recommendation_contract":
                continue
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_recommendation(
                    {"recommendation_contract": 1, field: {"unexpected": "type"}}
                )

    def test_inventory_is_redacted_partial_and_revision_stable(self):
        package = self.package("good")
        packages = Packages([package, self.root / "missing"], include_builtin=False, strict=False)
        registry = Registry(packages, self.root, private_write, validate)
        state = {
            "locale": "zh",
            "skill_candidates": [
                {"id": "skill", "name": "Skill", "capabilities": ["keyword.expand"]}
            ],
        }
        (self.root / "discovery-draft.json").write_text(
            json.dumps(
                {
                    "errors": [
                        {
                            "source": "mcp",
                            "code": "schema_unavailable",
                            "secret": "PRIVATE_SENTINEL",
                        }
                    ],
                    "sources": [{"source_id": "source", "kind": "mcp", "coverage": "failed"}],
                }
            )
        )
        app = SimpleNamespace(
            packages=packages,
            registry=registry,
            directory=self.root,
            clock=lambda: self.now,
            _state=lambda _: state,
            _tool_context=lambda _: {},
        )
        first = inventory(app, "browser")
        second = inventory(app, "browser")
        self.assertEqual(first["catalog_revision"], second["catalog_revision"])
        self.assertEqual(first["coverage"], "partial")
        self.assertFalse(first["coverage_complete"])
        self.assertFalse(first["all_ready"])
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(first))
        self.assertNotIn(str(self.root), json.dumps(first))
        packages.flows["new"] = {"name": "New", "steps": [{"id": "step", "transform": "pick"}]}
        self.assertEqual(
            inventory(app, "browser")["catalog_revision"], first["catalog_revision"] + 1
        )


if __name__ == "__main__":
    unittest.main()
