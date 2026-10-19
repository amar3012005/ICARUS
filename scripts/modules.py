#!/usr/bin/env python3
"""Manage independent, ignored optional source checkouts. Never starts services."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    'agent-bus': 'https://github.com/amar3012005/SINGULANCE-agent-bus.git',
    'computer-use': 'https://github.com/amar3012005/HIVEMIND-Computer-use.git',
}

def git(*args):
    return subprocess.check_output(['git', *args], text=True, cwd=ROOT).strip()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'setup'])
    parser.add_argument('module', choices=list(SOURCES), nargs='?')
    args = parser.parse_args()
    if args.action == 'setup' and not args.module:
        parser.error('setup requires one explicitly selected module')
    names = [args.module] if args.module else list(SOURCES)
    rows = []
    for name in names:
        target = ROOT / 'modules' / name
        # Private sources must remain outside flagship tracking before any clone.
        subprocess.run(['git', 'check-ignore', '-q', str(target) + '/'], cwd=ROOT, check=True)
        if args.action == 'setup' and not target.exists():
            target.parent.mkdir(exist_ok=True)
            subprocess.run(['git', 'clone', '--', SOURCES[name], str(target)], check=True)
        present = (target / '.git').exists()
        if present and git('-C', str(target), 'rev-parse', '--show-toplevel') != str(target):
            raise SystemExit(f'{name}: expected an independent source repository')
        rows.append({'module': name, 'path': str(target), 'source_present': present,
                     'sha': git('-C', str(target), 'rev-parse', 'HEAD') if present else None,
                     'experimental': True, 'integrated_bridge': False,
                     'visibility': 'private' if name == 'agent-bus' else 'public'})
    print(json.dumps(rows, indent=2))

if __name__ == '__main__':
    main()
