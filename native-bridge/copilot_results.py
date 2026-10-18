"""按模板构造结果合同；确定性数字只从取数源合并，模型只提供判断。"""

import copy
import json
import re
from html import escape
from urllib.parse import urlsplit


def text(limit=500):
    return {"type": "string", "maxLength": limit}


def array(item, limit=1000):
    return {"type": "array", "items": item, "maxItems": limit}


def obj(properties, required=None):
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties) if required is None else required,
        "additionalProperties": False,
    }


NUMBER = {"type": "number"}
BOOL = {"type": "boolean"}
LEVEL = {"type": "string", "enum": ["go", "test", "skip", "info"]}
ACTIONS = [
    "seo.keyword_check",
    "seo.longtail",
    "seo.competitor_keywords",
    "seo.serp_breakdown",
    "seo.save_pool",
    "seo.trends",
    "seo.ranking_sites",
    "seo.domain_rating",
    "seo.top_pages",
    "browser.open",
    "general.task",
]
COMMON = {
    "verdict": text(30),
    "level": LEVEL,
    "metrics": array(obj({"label": text(30), "value": text(80)}), 3),
    "missing": array(obj({"field": text(80), "reason": text(300)}), 20),
    "process": array(text(600), 30),
    "next": array(obj({"action": {"type": "string", "enum": ACTIONS}, "object": text(2000)}), 2),
}
SERP = obj(
    {"rank": {"type": "integer"}, "domain": text(300), "page_type": text(60), "small_site": BOOL}
)
WORD = obj(
    {
        "keyword": text(2000),
        "vol": NUMBER,
        "kd": NUMBER,
        "cpc": NUMBER,
        "source": text(500),
        "position": NUMBER,
        "url": text(2000),
        "opportunity": BOOL,
        "field_sources": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    ["keyword"],
)
UNIFIED = obj(
    {
        **WORD["properties"],
        "domain": text(300),
        "traffic": NUMBER,
        "authority": NUMBER,
        "authority_kind": text(100),
        "reg_date": text(40),
        "weak": BOOL,
        "intent": text(300),
        "intent_tool": {"type": "integer"},
        "excluded": {"type": "integer"},
        "host": text(300),
        "host_duplicate": {"type": "integer"},
        "trend12": array(NUMBER, 400),
        "serp_json": array({"type": "object", "properties": {}, "additionalProperties": True}, 20),
        "tier": text(100),
        "verdict": text(500),
        "reason": text(1000),
        "group": text(100),
        "already_checked": BOOL,
        "is_home": {"type": "integer"},
        "rank": {"type": "integer"},
        "page_type": text(60),
        "small_site": BOOL,
        "title": text(500),
        "kd_source": text(100),
        "trend_source": text(100),
        "metric_quality": {"type": "object", "properties": {}, "additionalProperties": True},
        "measurement": text(30),
        "field_sources": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    [],
)
GROUP = obj({"name": text(100), "intent": text(300), "recommended": BOOL, "keywords": array(WORD)})
CHECK = obj(
    {
        "keyword": text(2000),
        "tier": text(30),
        "vol": NUMBER,
        "kd": NUMBER,
        "cpc": NUMBER,
        "source": text(500),
        "field_sources": {"type": "object", "properties": {}, "additionalProperties": True},
        "intent": text(300),
        "serp": array(SERP, 10),
        "reasons": array(text(500), 10),
    },
    ["keyword", "tier", "intent", "serp", "reasons"],
)
POINT = obj({"date": text(40), "value": NUMBER})
SERIES = obj(
    {"keyword": text(2000), "region": text(20), "period": text(30), "points": array(POINT, 400)}
)
COMPETITOR = obj(
    {
        "domain": text(300),
        "keywords": array(WORD),
        "top_pages": array(
            obj({"url": text(2000), "traffic": NUMBER, "keywords": NUMBER}, ["url"]), 30
        ),
    }
)
BODIES = {
    "workflow.run": {
        "records": array(UNIFIED, 1000),
        "steps": array(
            obj(
                {
                    "label": text(300),
                    "status": text(40),
                    "source": text(500),
                    "count": {"type": "integer"},
                }
            ),
            50,
        ),
        "artifacts": array(obj({"label": text(100), "path": text(2000)}), 50),
    },
    "seo.trends": {
        "series": array(SERIES, 200),
        "pattern": {
            "type": "string",
            "enum": ["rising", "stable", "seasonal", "falling", "unknown"],
        },
        "peak_months": array(text(40), 24),
    },
    "seo.ranking_sites": {
        "query": text(2000),
        "sites": array(COMPETITOR, 3),
        "reasons": array(text(500), 10),
    },
    "seo.domain_rating": {
        "domain": text(300),
        "rating": {"type": ["number", "null"]},
        "source": text(500),
    },
    "seo.top_pages": {
        "domain": text(300),
        "top_pages": array(
            obj({"url": text(2000), "traffic": NUMBER, "keywords": NUMBER}, ["url"]), 30
        ),
    },
    "browser.open": {
        "bullets": array(text(1000), 30),
        "links": array(obj({"label": text(100), "url": text(2000)}), 30),
        "artifacts": array(obj({"label": text(100), "path": text(2000)}), 30),
    },
    "seo.keyword_check": {**CHECK["properties"], "checks": array(CHECK)},
    "seo.longtail": {"groups": array(GROUP, 30)},
    "seo.competitor_keywords": {
        "domain": text(300),
        "top_pages": array(
            obj({"url": text(2000), "traffic": NUMBER, "keywords": NUMBER}, ["url"]), 30
        ),
        "keywords": array(WORD),
    },
    "seo.serp_breakdown": {
        "query": text(2000),
        "results": array(SERP, 10),
        "gaps": array(text(500), 10),
    },
    "seo.save_pool": {
        "written": {"type": ["integer", "null"]},
        "skipped": array(obj({"keyword": text(2000), "reason": text(300)})),
    },
    "general.task": {
        "bullets": array(text(1000), 30),
        "links": array(obj({"label": text(100), "url": text(2000)}), 30),
        "artifacts": array(obj({"label": text(100), "path": text(2000)}), 30),
    },
}


def result_schema(action):
    required = list(COMMON) + (
        ["keyword", "tier", "intent", "serp", "reasons"]
        if action == "seo.keyword_check"
        else list(BODIES[action])
    )
    return obj({**COMMON, **BODIES[action]}, required)


def decision_schema(action):
    common = {key: COMMON[key] for key in ("verdict", "level", "process", "next")}
    if action == "seo.keyword_check":
        body = {
            "tier": text(30),
            "intent": text(300),
            "reasons": array(text(500), 10),
            "serp_judgments": array(
                obj({"domain": text(300), "page_type": text(60), "small_site": BOOL}), 10
            ),
            "checks": array(
                obj(
                    {
                        "keyword": text(2000),
                        "tier": text(30),
                        "intent": text(300),
                        "reasons": array(text(500), 10),
                        "serp_judgments": array(
                            obj({"domain": text(300), "page_type": text(60), "small_site": BOOL}),
                            10,
                        ),
                    },
                    ["keyword", "tier", "intent", "reasons"],
                )
            ),
        }
    elif action == "seo.trends":
        body = {
            "pattern": {
                "type": "string",
                "enum": ["rising", "stable", "seasonal", "falling", "unknown"],
            },
            "peak_months": array(text(40), 24),
        }
    elif action == "seo.ranking_sites":
        body = {
            "reasons": array(text(500), 10),
            "opportunities": array(
                obj(
                    {
                        "domain": text(300),
                        "keywords": array(obj({"keyword": text(2000), "opportunity": BOOL})),
                    }
                ),
                3,
            ),
        }
    elif action in {"seo.domain_rating", "seo.top_pages"}:
        body = {}
    elif action == "seo.longtail":
        body = {
            "groups": array(
                obj(
                    {
                        "name": text(100),
                        "intent": text(300),
                        "recommended": BOOL,
                        "keywords": array(obj({"keyword": text(2000)})),
                    }
                ),
                30,
            )
        }
    elif action == "seo.competitor_keywords":
        body = {"keywords": array(obj({"keyword": text(2000), "opportunity": BOOL}))}
    elif action == "seo.serp_breakdown":
        body = {
            "gaps": array(text(500), 10),
            "judgments": array(
                obj({"domain": text(300), "page_type": text(60), "small_site": BOOL}), 10
            ),
        }
    else:
        body = BODIES[action]
    return obj(
        {**common, **body},
        list(common)
        + (
            {
                "seo.keyword_check": ["tier", "intent", "reasons"],
                "seo.serp_breakdown": ["gaps", "judgments"],
            }.get(action, list(body))
        ),
    )


def words(result):
    if result.get("records") is not None:
        return [row for row in result["records"] if row.get("keyword")]
    if result.get("groups") is not None:
        return [word for group in result["groups"] for word in group.get("keywords", [])]
    if result.get("checks") is not None:
        return result["checks"]
    if result.get("keyword") and "tier" in result:
        return [
            {key: result[key] for key in ("keyword", "vol", "kd", "cpc", "tier") if key in result}
        ]
    return result.get("keywords", [])


def export_rows(result):
    if result.get("groups") is not None:
        return [
            {**word, "group": group["name"]}
            for group in result["groups"]
            for word in group["keywords"]
        ]
    return words(result)


def key(word):
    return " ".join(str(word).strip().casefold().split())


def source_words(fetched):
    found = {}
    for name, source in fetched.get("data", {}).items():
        if not isinstance(source, dict):
            continue
        for row in source.get("keywords", []):
            clean = {
                k: row[k] for k in ("keyword", "vol", "kd", "cpc", "position", "url") if k in row
            }
            clean["source"] = str(row.get("source") or source.get("source") or name)[:500]
            clean["field_sources"] = row.get("field_sources") or {
                field: clean["source"] for field in clean if field not in {"source", "keyword"}
            }
            found.setdefault(key(row["keyword"]), {}).update(clean)
    return found


def missing_metrics(result):
    rows = words(result)
    absent = [field for field in ("vol", "kd") if rows and not any(field in word for word in rows)]
    if absent and not any(
        set(absent) <= set(item["field"].split(",")) for item in result["missing"]
    ):
        result["missing"].append(
            {"field": ",".join(absent), "reason": "取数源未提供；需登录数据工具或配置对应取数命令"}
        )
    return result


def compose(action, params, decision, fetched, validate):
    validate(decision, decision_schema(action))
    if re.search(r"校验通过|JSON|完成.*(?:查询|次调用)", decision["verdict"], re.I):
        raise ValueError("verdict must describe a judgment")
    raw = source_words(fetched)
    result = {key: copy.deepcopy(decision[key]) for key in ("verdict", "level", "process", "next")}
    result.update(
        metrics=[],
        missing=[
            {"field": "data", "reason": reason[:300]} for reason in fetched.get("missing", [])
        ],
    )
    if action == "seo.trends":
        source = fetched.get("data", {}).get("google_trends", {})
        series = source.get("series", [])
        result["process"] = result["process"][:29] + [
            str(source.get("source", "曲线来源未取得"))[:600]
        ]
        wanted = {key(word) for word in params.get("keywords") or [params["keyword"]]}
        if any(key(row["keyword"]) not in wanted for row in series):
            raise ValueError("unrequested trend series")
        for row in series:
            if (
                row["region"] not in {"US", "WORLD"}
                or row["period"] not in {"12m", "5y"}
                or any(not 0 <= point["value"] <= 100 for point in row["points"])
            ):
                raise ValueError("invalid trends data")
        observed = {
            (key(row["keyword"]), row["region"], row["period"]) for row in series if row["points"]
        }
        expected = {
            (word, region, period)
            for word in wanted
            for region in ("US", "WORLD")
            for period in ("12m", "5y")
        }
        complete = expected <= observed
        result.update(
            series=series,
            pattern=decision["pattern"] if observed else "unknown",
            peak_months=decision["peak_months"] if observed else [],
        )
        if not complete:
            result["missing"].append(
                {"field": "series", "reason": "趋势曲线未完整取得；不得据此推断零热度或完整趋势"}
            )
        if not observed:
            result.update(verdict="趋势数据不足，暂不判断", level="info")
        result["metrics"] = [{"label": "曲线", "value": str(len(observed))}]
    elif action == "seo.ranking_sites":
        sites = fetched.get("data", {}).get("ranking_sites", {}).get("sites", [])
        decisions = {
            row["domain"]: {key(word["keyword"]): word["opportunity"] for word in row["keywords"]}
            for row in decision["opportunities"]
        }
        if set(decisions) - {row["domain"] for row in sites}:
            raise ValueError("unknown ranking domain")
        for site in sites:
            known = {key(word["keyword"]) for word in site["keywords"]}
            if set(decisions.get(site["domain"], {})) - known:
                raise ValueError("unknown ranking keyword")
        result.update(
            query=params["keyword"],
            sites=[
                {
                    **site,
                    "keywords": [
                        {
                            **word,
                            "opportunity": decisions.get(site["domain"], {}).get(
                                key(word["keyword"]), False
                            ),
                        }
                        for word in site["keywords"]
                    ],
                }
                for site in sites
            ],
            reasons=decision["reasons"],
        )
        result["metrics"] = [{"label": "站点", "value": str(len(sites))}]
    elif action in {"seo.top_pages", "seo.domain_rating"}:
        field = "rating" if action == "seo.domain_rating" else "pages"
        source = next(
            (
                item
                for item in fetched.get("data", {}).values()
                if isinstance(item, dict) and field in item
            ),
            {},
        )
        domain = urlsplit(params["url"]).hostname or params["url"]
        if action == "seo.domain_rating":
            result.update(
                domain=domain, rating=source.get("rating"), source=source.get("source", "")
            )
            if source.get("rating") is None:
                result["missing"].append({"field": "rating", "reason": "取数源未提供已核实评分"})
        else:
            result.update(
                domain=domain,
                top_pages=[
                    {"url": page} if isinstance(page, str) else page
                    for page in source.get("pages", [])
                ],
            )
    elif action == "seo.longtail":
        groups = []
        seen = set()
        for group in decision["groups"]:
            entries = []
            for word in group["keywords"]:
                identity = key(word["keyword"])
                if identity not in raw:
                    raise ValueError("unknown keyword in judgment")
                if identity not in seen:
                    entries.append(dict(raw[identity]))
                    seen.add(identity)
            groups.append({**group, "keywords": entries})
        remaining = [value for identity, value in raw.items() if identity not in seen]
        if remaining:
            groups.append(
                {"name": "未分组", "intent": "待判断", "recommended": False, "keywords": remaining}
            )
        result["groups"] = groups
        result["metrics"] = [
            {"label": "候选词", "value": str(len(raw))},
            {"label": "分组", "value": str(len(groups))},
        ]
    elif action == "seo.keyword_check":
        targets = params.get("keywords") or [params["keyword"]]
        judgments = {key(item["keyword"]): item for item in decision.get("checks", [])}
        if len(targets) > 1 and set(judgments) != {key(target) for target in targets}:
            raise ValueError("batch judgment must cover every selected keyword")
        checks = []
        for target in targets:
            judgment = judgments.get(key(target), decision if len(targets) == 1 else {})
            known = raw.get(key(target), {"keyword": target})
            checks.append(
                {
                    **{
                        k: v
                        for k, v in known.items()
                        if k in ("keyword", "vol", "kd", "cpc", "source", "field_sources")
                    },
                    "tier": judgment.get("tier", "待判断"),
                    "intent": judgment.get("intent", "待判断"),
                    "reasons": judgment.get("reasons", []),
                    "serp": serp_data(fetched, target if len(targets) > 1 else None),
                }
            )
        for check in checks:
            judgment = judgments.get(key(check["keyword"]), decision if len(targets) == 1 else {})
            labels = {row["domain"]: row for row in judgment.get("serp_judgments", [])}
            for entry in check["serp"]:
                if entry["domain"] in labels:
                    entry.update(
                        {k: labels[entry["domain"]][k] for k in ("page_type", "small_site")}
                    )
        if any(not check["serp"] for check in checks):
            result["missing"].append(
                {"field": "serp", "reason": "取数源未提供对应关键词的前十数据"}
            )
        result.update(checks[0])
        result["checks"] = checks
        notes = [
            check["keyword"]
            + " · "
            + ", ".join(
                field + ": " + str(source)
                for field, source in check.get("field_sources", {}).items()
            )
            for check in checks
        ]
        result["process"] = (result["process"][:20] + [note[:600] for note in notes[:10]])[-30:]
        result["metrics"] = [
            {"label": label, "value": str(checks[0][field])}
            for field, label in [("vol", "月量"), ("kd", "KD"), ("cpc", "CPC")]
            if len(checks) == 1 and field in checks[0]
        ]
        if len(checks) > 1:
            result["keyword"] = f"批量 {len(checks)} 词"
            result["metrics"] = [{"label": "查词", "value": str(len(checks))}]
    elif action == "seo.competitor_keywords":
        decisions = {key(row["keyword"]): row["opportunity"] for row in decision["keywords"]}
        if set(decisions) - set(raw):
            raise ValueError("unknown competitor keyword")
        source = fetched.get("data", {}).get("competitor_keywords", {})
        result.update(
            domain=urlsplit(
                params["url"] if "://" in params["url"] else "https://" + params["url"]
            ).hostname
            or params["url"],
            keywords=[
                {**row, "opportunity": decisions.get(identity, False)}
                for identity, row in raw.items()
            ],
            top_pages=[
                {"url": page} if isinstance(page, str) else page for page in source.get("pages", [])
            ],
        )
        result["metrics"] = [
            {"label": "流量词", "value": str(len(raw))},
            {"label": "可做", "value": str(sum(decisions.values()))},
        ]
    elif action == "seo.serp_breakdown":
        rows = serp_data(fetched)
        judgments = {row["domain"]: row for row in decision["judgments"]}
        result.update(
            query=params["url"],
            results=[
                {
                    **row,
                    **{
                        k: judgments.get(row["domain"], {}).get(k, row[k])
                        for k in ("page_type", "small_site")
                    },
                }
                for row in rows
            ],
            gaps=decision["gaps"],
        )
        result["metrics"] = [{"label": "结果", "value": str(len(rows))}]
        if not rows:
            result["missing"].append({"field": "serp", "reason": "快照没有可核实的排名域名"})
    else:
        result.update({k: decision[k] for k in BODIES[action]})
    missing_metrics(result)
    validate(result, result_schema(action))
    return result


def serp_data(fetched, keyword=None):
    data = fetched.get("data", {})
    rows = data.get("serp_top10", {}).get("results", [])
    if keyword is not None:
        rows = next(
            (
                query["results"]
                for query in data.get("serp_top10", {}).get("queries", [])
                if key(query["keyword"]) == key(keyword)
            ),
            [],
        )
        if not rows:
            return []
    if not rows:
        snapshot = data.get("snapshot", {})
        domains = []
        for item in snapshot.get("items", []):
            for domain in re.findall(
                r"(?<![\w@])(?:[a-z0-9-]+\.)+[a-z]{2,20}\b", item.get("name", ""), re.I
            ):
                if domain not in domains:
                    domains.append(domain)
        rows = [{"url": "https://" + domain} for domain in domains[:10]]
    return [
        {
            "rank": i + 1,
            "domain": urlsplit(row["url"]).hostname or "",
            "page_type": row.get("page_type", "待判断"),
            "small_site": row.get("small_site", False),
        }
        for i, row in enumerate(rows[:10])
    ]


def legacy(action, value, params=None):
    if "verdict" in value:
        return copy.deepcopy(value)
    params = params or {}
    entries = copy.deepcopy(value.get("keywords", []))
    groups = []
    details = value.get("details", "")
    if isinstance(details, str):
        try:
            structured = json.loads(details)
        except (ValueError, TypeError):
            structured = {}
    else:
        structured = details if isinstance(details, dict) else {}
    source_groups = structured.get("groups", []) if isinstance(structured, dict) else []
    if isinstance(source_groups, dict):
        source_groups = [{"name": name, "keywords": items} for name, items in source_groups.items()]
    for group in source_groups if isinstance(source_groups, list) else []:
        if not isinstance(group, dict):
            continue
        items = group.get("keywords", group.get("words", []))
        items = [
            {"keyword": word} if isinstance(word, str) else word
            for word in items
            if isinstance(word, (str, dict))
        ]
        groups.append(
            {
                "name": str(group.get("name", "未分组"))[:100],
                "intent": str(group.get("intent", "待判断"))[:300],
                "recommended": group.get("recommended") is True,
                "keywords": items,
            }
        )
    if not groups and isinstance(details, str):
        for block in re.split(r"\n\n(?=[一二三四五六七八九十]+、)", details):
            title = re.match(r"[一二三四五六七八九十]+、([^。\n]+)", block)
            listing = re.search(r"词：(.*?)(?:。|$)", block, re.S)
            if not title or not listing:
                continue
            names = [part.split("（")[0].strip() for part in listing.group(1).split("；")]
            members = [
                word
                for word in entries
                if key(word.get("keyword", "")) in {key(name) for name in names}
            ]
            if members:
                groups.append(
                    {
                        "name": title.group(1)[:100],
                        "intent": title.group(1)[:100],
                        "recommended": False,
                        "keywords": members,
                    }
                )
    if not groups and entries:
        for name in dict.fromkeys(word.get("group", "未分组") for word in entries):
            groups.append(
                {
                    "name": name,
                    "intent": "待判断",
                    "recommended": False,
                    "keywords": [
                        {k: v for k, v in word.items() if k != "group"}
                        for word in entries
                        if word.get("group", "未分组") == name
                    ],
                }
            )
    for group in groups:
        group["keywords"] = [
            {
                **{k: v for k, v in word.items() if k in WORD["properties"]},
                "source": word.get("source", "旧版报告，具体来源待核对"),
            }
            for word in group["keywords"]
            if isinstance(word.get("keyword"), str)
        ]
    count = sum(len(group["keywords"]) for group in groups)
    summary = str(value.get("summary", ""))
    result = {
        "verdict": summary[:30]
        if summary and len(summary) <= 30 and not re.search(r"完成|查询|校验|JSON", summary, re.I)
        else f"整理出{count}个候选，待核对判断",
        "level": "info",
        "metrics": [
            {"label": "候选词", "value": str(count)},
            {"label": "分组", "value": str(len(groups))},
        ]
        if count
        else [],
        "missing": [
            {"field": "data", "reason": str(reason)[:300]}
            for reason in value.get("missing_data", [])
        ],
        "process": ["旧版结果转换；未补造分组、指标或档位"],
        "next": [],
        "bullets": [],
        "links": [],
        "artifacts": [],
    }
    if details and not structured and isinstance(details, str):
        result["bullets"] = (
            ["旧过程结构无法直接展示，请打开报告核对"]
            if details.lstrip().startswith(("{", "["))
            else [line[:1000] for line in details.splitlines()[:20] if line.strip()]
        )
    if isinstance(details, str) and not structured and not details.lstrip().startswith(("{", "[")):
        paragraphs = details.split("\n\n")
        evidence = paragraphs[:2] + [
            paragraph
            for paragraph in paragraphs[2:]
            if "个性化" in paragraph or "不能当纯美国" in paragraph
        ]
        result["process"] += [
            re.sub(r"/Users/[^\s]+", "本机路径已省略", paragraph)[:600]
            for paragraph in evidence
            if paragraph.strip()
        ]
    if action == "seo.longtail":
        if "不宜全部塞进一页" in summary:
            result["verdict"] = "意图混杂，建议按任务拆分验证"
        result = {k: v for k, v in result.items() if k in COMMON}
        result["groups"] = groups
    elif action == "seo.keyword_check":
        result = {k: v for k, v in result.items() if k in COMMON}
        word = entries[0] if entries else {"keyword": params.get("keyword", "待核对")}
        result.update(
            {k: v for k, v in word.items() if k in ("keyword", "vol", "kd", "cpc")},
            tier="待判断",
            intent="待判断",
            serp=[],
            reasons=[],
        )
    elif action == "seo.competitor_keywords":
        result = {k: v for k, v in result.items() if k in COMMON}
        result.update(
            domain=params.get("url", "待核对"),
            top_pages=[],
            keywords=[
                {k: v for k, v in word.items() if k in WORD["properties"]} for word in entries
            ],
        )
    elif action == "seo.serp_breakdown":
        result = {k: v for k, v in result.items() if k in COMMON}
        result.update(query=params.get("url", "待核对"), results=[], gaps=[])
    return missing_metrics(result)


def report(result, title):
    def md(value):
        return (
            re.sub(r"([\\`*_\[\]()!#])", r"\\\1", escape(str(value)))
            .replace("|", "\\|")
            .replace("\n", " ")
        )

    lines = ["# " + md(title), "", md(result["verdict"]), "", "档位：" + result["level"]]
    lines += ["- " + md(item["label"]) + "：" + md(item["value"]) for item in result["metrics"]]
    for item in result["missing"]:
        lines.append("- 缺 " + md(item["field"]) + "：" + md(item["reason"]))

    def table(rows):
        if not rows:
            return
        columns = [
            ("keyword", "关键词"),
            ("vol", "量"),
            ("kd", "KD"),
            ("group", "分组"),
            ("source", "来源"),
        ]
        lines.extend(
            [
                "",
                "| " + " | ".join(label for _, label in columns) + " |",
                "| " + " | ".join("---" for _ in columns) + " |",
            ]
        )
        for row in rows:
            lines.append("| " + " | ".join(md(row.get(field, "")) for field, _ in columns) + " |")

    if result.get("records") is not None:
        rows = result["records"]
        columns = [
            field
            for field in ("keyword", "domain", "url", "vol", "kd", "tier", "source")
            if any(field in row for row in rows)
        ]
        if not columns:
            columns = list(dict.fromkeys(field for row in rows for field in row))[:100]
        if columns:
            lines += [
                "",
                "| " + " | ".join(columns) + " |",
                "| " + " | ".join("---" for _ in columns) + " |",
            ]
            lines += [
                "| " + " | ".join(md(row.get(field, "")) for field in columns) + " |"
                for row in rows
            ]
        for step in result.get("steps", []):
            lines.append(
                "- "
                + md(step["label"])
                + " · "
                + md(step["status"])
                + " · "
                + str(step["count"])
                + " · "
                + md(step["source"])
            )
    elif result.get("groups") is not None:
        for group in result["groups"]:
            lines += ["", "## " + md(group["name"]), md(group["intent"])]
            table(group["keywords"])
    else:
        table(words(result))
    for item in result.get("reasons", result.get("gaps", result.get("bullets", []))):
        lines.append("- " + md(item))
    for link in result.get("links", []):
        lines.append("- " + md(link["label"]) + "：" + md(link["url"]))
    for item in result.get("artifacts", []):
        lines.append("- " + md(item["label"]) + "：" + md(item["path"]))
    if result.get("process"):
        lines += ["", "## 过程与来源"] + ["- " + md(line) for line in result["process"]]
    return "\n".join(lines) + "\n"
