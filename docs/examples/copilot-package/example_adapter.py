"""示例接口，不调用供应商、不编造指标。"""

import json
import sys

params = json.load(sys.stdin)
words = params.get("keywords") or ([params["keyword"]] if params.get("keyword") else [])
print(
    json.dumps(
        {
            "records": [{"keyword": word} for word in words],
            "source": "example-seo-tool unconfigured adapter",
            "missing": ["Bind an observed provider before measuring metrics"],
        }
    )
)
