"""读取合成可见页面；只向当前任务目录写入本地记录。"""

import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
import sys


class VisibleFields(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = {}
        self.field = None

    def handle_starttag(self, tag, attrs):
        self.field = dict(attrs).get("data-field")

    def handle_endtag(self, tag):
        self.field = None

    def handle_data(self, data):
        if self.field:
            self.fields[self.field] = data.strip()


parser = argparse.ArgumentParser(
    description="Record bundled synthetic visible data locally; no network"
)
parser.parse_args()
inputs = json.load(sys.stdin)
page = VisibleFields()
page.feed(Path(__file__).with_name("visible-page.html").read_text())
record = page.fields

if inputs["job_id"] != record["job_id"]:
    raise ValueError("unknown synthetic job")
path = Path("jobs.json")
rows = json.loads(path.read_text()) if path.exists() else []
by_id = {row["job_id"]: row for row in rows}
record["status"] = "saved"
by_id.setdefault(record["job_id"], record)
path.write_text(json.dumps(list(by_id.values()), indent=2))
print(json.dumps({"records": list(by_id.values()), "source": "synthetic visible page"}))
