"""表格本机导出：原文、解析数值、链接分列；xlsx只用标准库。"""

import csv
from datetime import datetime
import io
import json
import math
import re
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED


def number(text):
    raw = str(text).strip()
    if "," in raw and not re.fullmatch(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?[KkMm%]?", raw):
        return None
    value = raw.replace(",", "")
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([KkMm%]?)", value)
    if not match:
        return None
    result = float(match[1]) * {"k": 1000, "m": 1000000, "%": 0.01, "": 1}[match[2].lower()]
    return result if math.isfinite(result) else None


def expanded(headers, rows):
    numeric = [
        i
        for i in range(len(headers))
        if any(number(row[i].get("text", "")) is not None for row in rows)
    ]
    links = [i for i in range(len(headers)) if any(row[i].get("links") for row in rows)]
    names = (
        list(headers)
        + [headers[i] + "（数值）" for i in numeric]
        + [headers[i] + "（链接）" for i in links]
    )
    values = []
    for row in rows:
        values.append(
            [cell["text"] for cell in row]
            + [number(row[i]["text"]) for i in numeric]
            + ["\n".join(row[i].get("links", [])) for i in links]
        )
    return names, values


def column(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def csv_bytes(headers, rows):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        # 中文注释：外部网页的公式样式文本按文字保护；数值列仍为数值。
        writer.writerow(
            [
                "'" + v
                if isinstance(v, str)
                and v.lstrip().startswith(("=", "+", "-", "@"))
                and number(v) is None
                else v
                for v in row
            ]
        )
    return b"\xef\xbb\xbf" + output.getvalue().encode("utf-8")


def xlsx_bytes(headers, rows):
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    lines = [
        f'<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>'
    ]
    for ri, row in enumerate([headers, *rows], 1):
        cells = []
        for ci, value in enumerate(row, 1):
            ref = column(ci) + str(ri)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
            else:
                clean = re.sub(
                    "[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value) if value is not None else ""
                )
                cells.append(
                    f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(clean)}</t></is></c>'
                )
        lines.append(f'<row r="{ri}">' + "".join(cells) + "</row>")
    lines.append(
        '</sheetData><autoFilter ref="A1:'
        + column(len(headers))
        + str(len(rows) + 1)
        + '"/></worksheet>'
    )
    output = io.BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as book:
        book.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        )
        book.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        )
        book.writestr(
            "xl/workbook.xml",
            f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="表格" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        book.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        book.writestr("xl/worksheets/sheet1.xml", "".join(lines))
    return output.getvalue()


def validate_table(table):
    if not isinstance(table, dict) or set(table) - {
        "name",
        "site",
        "headers",
        "rows",
        "pages",
        "reason",
        "partial",
        "unit",
    }:
        raise ValueError("invalid table")
    headers = table.get("headers")
    rows = table.get("rows")
    if (
        not isinstance(headers, list)
        or not 2 <= len(headers) <= 100
        or not all(isinstance(h, str) and len(h) <= 500 for h in headers)
    ):
        raise ValueError("invalid headers")
    if not isinstance(rows, list) or len(rows) > 50000:
        raise ValueError("table row limit")
    for row in rows:
        if not isinstance(row, list) or len(row) != len(headers):
            raise ValueError("column mismatch")
        for cell in row:
            if (
                not isinstance(cell, dict)
                or set(cell) - {"text", "links"}
                or not isinstance(cell.get("text"), str)
                or len(cell["text"]) > 10000
            ):
                raise ValueError("invalid cell")
            if not isinstance(cell.get("links", []), list) or any(
                not isinstance(link, str) or not re.match(r"^https?://", link) or len(link) > 4096
                for link in cell.get("links", [])
            ):
                raise ValueError("invalid links")


def export(table, directory, formats=("xlsx", "csv")):
    validate_table(table)
    root = Path(directory).expanduser()
    if any(part.is_symlink() for part in (root, *root.parents)):
        raise ValueError("export directory symlink")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stem = "_".join(
        re.sub(r"[^\w.-]+", "_", str(part))[:70]
        for part in [
            table.get("site", "site"),
            table.get("name", "table"),
            datetime.now().strftime("%Y%m%d_%H%M%S_%f"),
        ]
    )
    headers, rows = expanded(table["headers"], table["rows"])
    paths = []
    for fmt in formats:
        if fmt not in {"xlsx", "csv"}:
            raise ValueError("invalid format")
        path = root / (stem + "." + fmt)
        with path.open("xb") as handle:
            handle.write(xlsx_bytes(headers, rows) if fmt == "xlsx" else csv_bytes(headers, rows))
        path.chmod(0o600)
        paths.append(str(path))
    return paths


class TableStore:
    def __init__(self, directory, config, write):
        self.root = Path(directory) / "tables"
        if any(part.is_symlink() for part in (self.root, *self.root.parents)):
            raise ValueError("table directory symlink")
        self.config = config
        self.write = write
        self.datasets = {}
        self.files = {}
        path = self.root / "confirmed.json"
        if path.is_symlink():
            raise ValueError("confirmed tables symlink")
        self.confirmed = json.loads(path.read_text()) if path.exists() else {}

    def confirmed_table(self, identity):
        if (
            not isinstance(identity, str)
            or not re.fullmatch(r"[a-f0-9]{32}", identity)
            or self.confirmed.get(identity) is not True
        ):
            raise ValueError("confirmed export required")
        path = self.root / (identity + ".json")
        if path.is_symlink():
            raise ValueError("table path symlink")
        table = json.loads(path.read_text())
        validate_table(table)
        return table

    def export_saved(self, instance, name, headers, rows):
        value = self.request(
            instance, "table_begin", {"name": name, "site": "basket", "headers": headers}
        )
        batch = []
        size = 0
        for row in rows:
            cost = len(json.dumps(row, ensure_ascii=False).encode())
            if batch and size + cost > 200000:
                self.request(instance, "table_append", {"id": value["id"], "rows": batch})
                batch = []
                size = 0
            batch.append(row)
            size += cost
        if batch:
            self.request(instance, "table_append", {"id": value["id"], "rows": batch})
        return self.request(instance, "table_finish", {"id": value["id"], "format": "both"})

    def request(self, instance, method, params):
        import uuid

        if method == "table_begin":
            if set(params) - {"name", "site", "headers"}:
                raise ValueError("invalid table metadata")
            table = {**params, "rows": []}
            validate_table(table)
            identity = uuid.uuid4().hex
            self.datasets[identity] = {"owner": instance, "table": table}
            return {"id": identity}
        identity = params.get("id")
        record = self.datasets.get(identity)
        if not record or record["owner"] != instance:
            raise ValueError("table unavailable")
        table = record["table"]
        if method == "table_append":
            if (
                set(params) != {"id", "rows"}
                or len(json.dumps(params, ensure_ascii=False).encode()) > 262144
            ):
                raise ValueError("table chunk limit")
            validate_table({**table, "rows": params["rows"]})
            if len(table["rows"]) + len(params["rows"]) > 50000:
                raise ValueError("table row limit")
            table["rows"].extend(params["rows"])
            return {"rows": len(table["rows"])}
        if method == "table_finish":
            if set(params) - {"id", "format", "pages", "reason", "partial", "unit"}:
                raise ValueError("invalid export")
            table.update(
                unit="批" if params.get("unit", table.get("unit")) == "批" else "页",
                pages=params.get("pages", 1),
                reason=str(params.get("reason", ""))[:300],
                partial=params.get("partial", False) is True,
            )
            self.write(self.root / (identity + ".json"), json.dumps(table, ensure_ascii=False))
            formats = (
                ("xlsx", "csv")
                if params.get("format") == "both"
                else (params.get("format", "xlsx"),)
            )
            try:
                paths = export(table, self.config["table_export_dir"], formats)
            except OSError:
                return {
                    "id": identity,
                    "rows": len(table["rows"]),
                    "pages": table["pages"],
                    "partial": True,
                    "reason": "导出目录不可写；已保留本机临时表格，请修正目录后重试",
                    "files": [],
                    "error": "export_directory_unavailable",
                }
            record["format"] = params.get("format", "xlsx")
            files = []
            for path in paths:
                file_id = uuid.uuid4().hex
                self.files[file_id] = {"owner": instance, "path": path}
                files.append({"id": file_id, "path": path})
            self.confirmed[identity] = True
            self.write(self.root / "confirmed.json", json.dumps(self.confirmed))
            return {
                "id": identity,
                "rows": len(table["rows"]),
                "pages": table["pages"],
                "unit": table["unit"],
                "reason": table["reason"],
                "partial": table["partial"],
                "files": files,
            }
        if method == "table_read":
            if set(params) - {"id", "offset", "limit"}:
                raise ValueError("invalid table read")
            offset = params.get("offset", 0)
            limit = params.get("limit", 200)
            if (
                type(offset) is not int
                or type(limit) is not int
                or offset < 0
                or not 1 <= limit <= 1000
            ):
                raise ValueError("invalid row window")
            return {
                **{k: v for k, v in table.items() if k != "rows"},
                "rows": table["rows"][offset : offset + limit],
                "total": len(table["rows"]),
            }
        if method == "table_column":
            if (
                set(params) != {"id", "column"}
                or type(params["column"]) is not int
                or not 0 <= params["column"] < len(table["headers"])
            ):
                raise ValueError("invalid column")
            selected = list(
                dict.fromkeys(
                    row[params["column"]]["text"]
                    for row in table["rows"]
                    if row[params["column"]]["text"]
                )
            )
            if len(selected) > 1000 or len(json.dumps(selected).encode()) > 200000:
                raise ValueError("keyword batch limit; select at most 1000 words")
            return {"keywords": selected}
        raise ValueError("unknown table method")

    def open(self, instance, identity, folder=False):
        import subprocess, sys

        record = self.files.get(identity)
        if not record or record["owner"] != instance:
            raise ValueError("export unavailable")
        path = Path(record["path"])
        if not path.is_file() or any(part.is_symlink() for part in (path, *path.parents)):
            raise ValueError("unsafe export path")
        subprocess.run(
            [
                "open" if sys.platform == "darwin" else "xdg-open",
                str(path.parent if folder else path),
            ],
            check=True,
            timeout=5,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
