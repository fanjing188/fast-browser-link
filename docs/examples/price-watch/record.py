"""读取合成可见页面；只向当前任务目录写入本地记录。"""

import argparse
import csv
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

if inputs["product_id"] != record["product_id"]:
    raise ValueError("unknown synthetic product")
path = Path("prices.csv")
rows = (
    list(csv.DictReader(path.open()))
    if path.exists()
    else [{"product_id": record["product_id"], "price": "29.00", "stock": "in stock"}]
)
previous = next(
    (float(row["price"]) for row in reversed(rows) if row["product_id"] == record["product_id"]),
    None,
)
record["price"] = float(record["price"])
rows.append(dict(record))
with path.open("w", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=["product_id", "price", "stock"])
    writer.writeheader()
    writer.writerows(rows)
record["change"] = record["price"] - previous if previous is not None else 0
print(json.dumps({"records": [record], "source": "synthetic visible page"}))
