"""安装时填充缺失配置和模板；既有用户文件不覆盖。"""
import argparse
import json
from pathlib import Path
from copilot import DEFAULTS, private_write


def setup(directory, source=None, overrides=None):
    directory = Path(directory)
    source = Path(source) if source else Path(__file__).parent / 'copilot-templates'
    destinations = [(source / 'seo' / (action + '.json'), directory / 'templates' / (action + '.json'))
                    for action in ('seo.keyword_check', 'seo.competitor_keywords', 'seo.longtail', 'seo.serp_breakdown', 'seo.save_pool')]
    destinations.append((None, directory / 'config.json'))
    for _, target in destinations:
        if any(part.is_symlink() for part in (target, *target.parents)):
            raise ValueError('copilot setup refuses symlinks')
    for origin, target in destinations:
        if target.exists():
            continue
        text = origin.read_text() if origin else json.dumps({**DEFAULTS, **(overrides or {})}, indent=2) + '\n'
        private_write(target, text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--report-dir')
    parser.add_argument('--pool-command-json', help='JSON argv ending with ingest; csv/link/date are added by host')
    args = parser.parse_args()
    overrides = {}
    if args.report_dir:
        overrides['report_dir'] = args.report_dir
    if args.pool_command_json:
        overrides['pool_command'] = json.loads(args.pool_command_json)
    setup(args.directory, overrides=overrides)
