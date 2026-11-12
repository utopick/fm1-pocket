#!/usr/bin/env python3
"""Builds pocket/index.html, the whole emulator in one file, from src/app.html and vendor/.

    python3 pocket/build.py

src/app.html is the page you edit. The build puts into it the fm1-emu core (vendor/fm1_web.wasm, as base64),
its audio worklet (vendor/worklet.js) and the firmware list (vendor/firmwares.json). No dependencies.
"""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p, mode="r": open(os.path.join(here, p), mode, **({} if "b" in mode else {"encoding": "utf-8"})).read()
page = read("src/app.html")
parts = {"/*@WORKLET@*/": read("vendor/worklet.js"), "/*@FIRMWARES@*/": read("vendor/firmwares.json"),
         "/*@WASM@*/": base64.b64encode(read("vendor/fm1_web.wasm", "rb")).decode()}
for mark, text in parts.items():
    assert page.count(mark) == 1, mark
    assert "</script" not in text.lower(), mark  # it would end the script tag that holds it
    page = page.replace(mark, text)
open(os.path.join(here, "index.html"), "w", encoding="utf-8").write(page)
print("index.html: %.1f MB" % (len(page) / 1e6))
