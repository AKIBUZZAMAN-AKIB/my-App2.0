#!/usr/bin/env python3
"""Splice the module sources in tools/agent-html-src into www/agent.html.

Each NN-name.js goes before `const app = new App(` and each NN-name.css before
the first `</style>`, between @@BEGIN/@@END markers, so re-running replaces
them in place. `install` lines go after `FilesManager.install(app);`.
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[2]
src = pathlib.Path(__file__).resolve().parent
html_path = root / 'www' / 'agent.html'
s = html_path.read_text()

def splice(s, name, kind, body, anchor, before=True):
    begin = f'/* @@BEGIN {kind}:{name} */'
    end = f'/* @@END {kind}:{name} */'
    block = f'{begin}\n{body.rstrip()}\n{end}\n'
    pat = re.compile(re.escape(begin) + r'.*?' + re.escape(end) + r'\n', re.S)
    if pat.search(s):
        return pat.sub(lambda m: block, s, count=1)
    i = s.index(anchor)
    if not before:
        i += len(anchor)
    return s[:i] + block + s[i:]

mods = sorted(p.stem for p in src.glob('[0-9][0-9]-*.js'))
for name in mods:
    js = (src / f'{name}.js').read_text()
    s = splice(s, name, 'js', js, 'const app = new App(')
    css_p = src / f'{name}.css'
    if css_p.exists():
        s = splice(s, name, 'css', css_p.read_text(), '</style>')
installs = []
for name in mods:
    m = re.search(r'^const (\w+) = \(\(\) => \{', (src / f'{name}.js').read_text(), re.M)
    if m and re.search(r'function install\(', (src / f'{name}.js').read_text()):
        installs.append(f'{m.group(1)}.install(app);')
installs.append("if (typeof window !== 'undefined') window.__app = app;")
s = splice(s, 'installs', 'js', '\n'.join(installs), 'FilesManager.install(app);\n', before=False)
html_path.write_text(s)
print('spliced', ', '.join(mods), '->', html_path, len(s), 'bytes')
