#!/usr/bin/env python3
"""Regenerates hooks/listener-src.ts from bin/listen.swift and bin/Info.plist. Run after editing either."""
import hashlib, json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
swift = (root / 'bin/listen.swift').read_text()
plist = (root / 'bin/Info.plist').read_text()
digest = hashlib.sha1((swift + plist).encode()).hexdigest()[:12]
(root / 'hooks/listener-src.ts').write_text(
    '// Generated from bin/listen.swift and bin/Info.plist by scripts/embed-listener.py. Do not edit by hand.\n'
    '/** Changes whenever the listener\'s source changes, so a stale binary is rebuilt. */\n'
    f'export const LISTENER_VERSION = {json.dumps(digest)}\n\n'
    f'export const LISTENER_SWIFT = {json.dumps(swift)}\n\n'
    f'export const LISTENER_PLIST = {json.dumps(plist)}\n')
print('listener version', digest)
