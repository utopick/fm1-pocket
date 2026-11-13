#!/usr/bin/env python3
"""Builds pocket/index.html, the whole emulator in one file, from src/app.html and vendor/.

    python3 pocket/build.py

src/app.html is the page you edit. The build puts into it the fm1-emu core (vendor/fm1_web.wasm, as base64),
its audio worklet (vendor/worklet.js), the firmware list (vendor/firmwares.json), the Pocket apps' MIDI device
panel (vendor/midi-device.js). No dependencies.
"""
import base64, hashlib, os
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p, mode="r": open(os.path.join(here, p), mode, **({} if "b" in mode else {"encoding": "utf-8"})).read()
b64 = lambda p: base64.b64encode(read(p, "rb")).decode()
sha = lambda p: hashlib.sha256(read(p, "rb")).hexdigest()
page = read("src/app.html")
parts = {"/*@WORKLET@*/": read("vendor/worklet.js"), "/*@FIRMWARES@*/": read("vendor/firmwares.json"),
         "/*@MIDIDEVICE@*/": read("vendor/midi-device.js"),  # the Pocket apps' MIDI device panel, the same file as theirs
         "/*@LICENSE_EMU@*/": read("vendor/LICENSE-fm1-emu").replace("&", "&amp;").replace("<", "&lt;"),
         "/*@REALFM1@*/": read("vendor/real-fm1.js"),  # USB MIDI protocol for a real FM-1 (tested by tests/real-fm1.test.js)
         "/*@MBOOT_STAGE@*/": b64("vendor/mboot/fm1-stage.fwsc"), "/*@MBOOT_UBOOT@*/": b64("vendor/mboot/fm1-uboot.fwsc"),  # m-bootloader v2.4 (MIT)
         "/*@MBOOT_STAGE_SHA@*/": sha("vendor/mboot/fm1-stage.fwsc"), "/*@MBOOT_UBOOT_SHA@*/": sha("vendor/mboot/fm1-uboot.fwsc"),
         "/*@WASM@*/": base64.b64encode(read("vendor/fm1_web.wasm", "rb")).decode()}
for mark, text in parts.items():
    assert page.count(mark) == 1, mark
    assert "</script" not in text.lower(), mark  # it would end the script tag that holds it
    page = page.replace(mark, text)
open(os.path.join(here, "index.html"), "w", encoding="utf-8").write(page)
print("index.html: %.1f MB" % (len(page) / 1e6))
