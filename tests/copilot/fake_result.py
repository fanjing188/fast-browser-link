"""纯判断替身：不输出原始指标。"""


def judgment(brief):
    if brief["action"] == "workflow.judgment":
        return {
            "verdict": "合成意图分组",
            "notes": [
                {
                    "key": row.get("keyword") or row.get("url") or row.get("domain"),
                    "intent_tool": 1,
                    "excluded": 0,
                    "reason": "Synthetic intent",
                    "group": "fixture",
                }
                for row in brief["fetched"]["records"]
            ],
        }
    if brief["action"] == "tool.draft":
        import re

        params = brief["params"]
        return {
            "id": "draft-example-tool",
            "hosts": [params["host"]],
            "name": {"zh": "新工具草稿", "en": "New tool draft"},
            "links": {},
            "pages": [
                {
                    "id": "report",
                    "paths": ["^" + re.escape(params["path"]) + "$"],
                    "columns": {"keyword": ["Keyword"]},
                    "actions": ["keyword.metrics"],
                    "flows": ["pool_links"],
                }
            ],
        }
    value = {
        "verdict": "先验证一个任务方向",
        "level": "test",
        "process": ["Synthetic execution result"],
        "next": [],
    }
    action = brief["action"]
    raw = []
    for source in brief.get("fetched", {}).get("data", {}).values():
        if isinstance(source, dict):
            raw.extend(source.get("keywords", []))
    if action == "seo.trends":
        value.update(pattern="seasonal", peak_months=["January"])
    elif action == "seo.ranking_sites":
        value.update(
            reasons=["Synthetic combined judgment"],
            opportunities=[
                {
                    "domain": site["domain"],
                    "keywords": [
                        {"keyword": word["keyword"], "opportunity": True}
                        for word in site["keywords"]
                    ],
                }
                for site in brief.get("fetched", {})
                .get("data", {})
                .get("ranking_sites", {})
                .get("sites", [])
            ],
        )
    elif action == "seo.longtail":
        value["groups"] = (
            [
                {
                    "name": "用途",
                    "intent": "合成任务意图",
                    "recommended": True,
                    "keywords": [{"keyword": word["keyword"]} for word in raw],
                }
            ]
            if raw
            else []
        )
    elif action == "seo.keyword_check":
        value.update(
            tier="测一页",
            intent="工具",
            reasons=["合成判断"],
            checks=[
                {"keyword": word, "tier": "测一页", "intent": "工具", "reasons": ["合成判断"]}
                for word in brief["params"].get("keywords", [])
            ],
        )
    elif action == "seo.competitor_keywords":
        value["keywords"] = [{"keyword": word["keyword"], "opportunity": True} for word in raw]
    elif action == "seo.serp_breakdown":
        value.update(gaps=["合成缺口"], judgments=[])
    else:
        value.update(bullets=["Synthetic execution result"], links=[], artifacts=[])
    return value
