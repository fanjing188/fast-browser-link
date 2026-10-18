"""按摘要升级受管模板，保留用户修改及既有配置。"""
import argparse
import json
import hashlib
import os
from pathlib import Path
from copilot import DEFAULTS, private_write


def setup(directory, source=None, overrides=None):
    directory = Path(directory)
    source = Path(source) if source else Path(__file__).parent / 'copilot-templates'
    manifest_path = directory / 'managed-templates.json'
    history_path = source / 'managed-history.json'
    for target in (manifest_path, manifest_path.with_suffix('.json.tmp')):
        if any(part.is_symlink() for part in (target, *target.parents)):
            raise ValueError('copilot setup refuses symlinks')
    history = json.loads(history_path.read_text()) if history_path.exists() else {}
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'version': 1, 'templates': {}}
    if manifest.get('version') != 1 or not isinstance(manifest.get('templates'), dict):
        raise ValueError('invalid managed template manifest')
    origins = sorted(path for path in source.rglob('*.json') if path != history_path)
    destinations = [(origin, directory / 'templates' / origin.name) for origin in origins]
    if len({target.name for _, target in destinations}) != len(destinations):
        raise ValueError('duplicate managed template name')
    targets = [manifest_path, directory / 'config.json', *[path for _, target in destinations for path in (target, target.with_suffix('.json.new'))]]
    for target in targets:
        if any(part.is_symlink() for part in (target, *target.parents)):
            raise ValueError('copilot setup refuses symlinks')
    records = manifest['templates']
    for origin, target in destinations:
        content = origin.read_text()
        digest = hashlib.sha256(content.encode()).hexdigest()
        json.loads(content)
        previous = records.get(target.name, {})
        current = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        managed = current == previous.get('sha256') if previous.get('sha256') else current in history.get(target.name, [])
        pending = target.with_suffix('.json.new')
        if current is None or current == digest or managed:
            if current != digest:
                private_write(target, content)
            # 中文注释：只移除清单确认的候选副本，用户修改过的 .new 继续保留。
            if pending.exists() and hashlib.sha256(pending.read_bytes()).hexdigest() in {previous.get('pending_sha256'), digest}:
                pending.unlink()
            records[target.name] = {'version': 'sha256:' + digest[:12], 'sha256': digest}
        else:
            private_write(pending, content)
            records[target.name] = {**previous, 'pending_version': 'sha256:' + digest[:12], 'pending_sha256': digest}
    temporary = manifest_path.with_suffix('.json.tmp')
    private_write(temporary, json.dumps(manifest, indent=2) + '\n')
    os.replace(temporary, manifest_path)
    config = directory / 'config.json'
    if not config.exists():
        private_write(config, json.dumps({**DEFAULTS, **(overrides or {})}, indent=2) + '\n')


def pending_templates(directory):
    return sorted(path.name.removesuffix('.new') for path in (Path(directory) / 'templates').glob('*.json.new'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--report-dir')
    parser.add_argument('--pool-command-json', help='JSON argv accepting stdin JSON keywords/csv_path/date; no implicit arguments')
    args = parser.parse_args()
    overrides = {}
    if args.report_dir:
        overrides['report_dir'] = args.report_dir
    if args.pool_command_json:
        overrides['pool_command'] = json.loads(args.pool_command_json)
    setup(args.directory, overrides=overrides)
