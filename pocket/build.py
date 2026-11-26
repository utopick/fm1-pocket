#!/usr/bin/env python3
"""Builds pocket/index.html, the whole emulator in one file, from src/app.html and vendor/.

    python3 pocket/build.py

src/app.html is the page you edit. The build puts into it the fm1-emu core (vendor/fm1_web.wasm, as base64),
its audio worklet (vendor/worklet.js), the ?worker=1 trial's Worker (vendor/emu-worker.js), the firmware list (vendor/firmwares.json), the pedals and live FX of the FX and PEDALS screens (vendor/fx.js), the Pocket apps' MIDI device
panel (vendor/midi-device.js). No dependencies.
"""
import base64, hashlib, os
here = os.path.dirname(os.path.abspath(__file__))
read = lambda p, mode="r": open(os.path.join(here, p), mode, **({} if "b" in mode else {"encoding": "utf-8"})).read()
b64 = lambda p: base64.b64encode(read(p, "rb")).decode()
sha = lambda p: hashlib.sha256(read(p, "rb")).hexdigest()
page = read("src/app.html")
parts = {"/*@WORKLET@*/": read("vendor/rfm1.js") + read("vendor/worklet.js"),  # rfm1.js: Jake Handy's loader of the fast builds (MIT), for worklet.js's Rfm1Proc
         "/*@CORE1WORKER@*/": read("vendor/core1-worker.js"), "/*@EMUWORKER@*/": read("vendor/emu-worker.js"), "/*@FIRMWARES@*/": read("vendor/firmwares.json"),
         "/*@FX@*/": read("vendor/fx.js"),  # the FX and PEDALS screens' sound: PLAY.Pocket's pedals, amps, cabs and live FX, adapted (tests/fx.py)
         "/*@MIDIDEVICE@*/": read("vendor/midi-device.js"),  # the Pocket apps' MIDI device panel, the same file as theirs
         "/*@LICENSE_EMU@*/": read("vendor/LICENSE-fm1-emu").replace("&", "&amp;").replace("<", "&lt;"),
         "/*@LICENSE_SIM@*/": read("vendor/LICENSE-fm1-browser-simulator").replace("&", "&amp;").replace("<", "&lt;"),
         "/*@LICENSE_MBOOT@*/": read("vendor/mboot/LICENSE-m-bootloader").replace("&", "&amp;").replace("<", "&lt;"),
         "/*@TETHER@*/": read("vendor/tether.js"),  # the Tether firmware's protocol: a real FM-1 as the panel of the emulator (tests/tether.test.js)
         "/*@REALFM1@*/": read("vendor/real-fm1.js"),  # USB MIDI protocol for a real FM-1 (tested by tests/real-fm1.test.js)
         "/*@MBOOT_STAGE@*/": b64("vendor/mboot/fm1-stage.fwsc"), "/*@MBOOT_UBOOT@*/": b64("vendor/mboot/fm1-uboot.fwsc"),  # m-bootloader v2.4 (MIT)
         "/*@TETHER_FWSC@*/": b64("vendor/tether.fwsc"), "/*@TETHER_SHA@*/": sha("vendor/tether.fwsc"),  # built by firmware/autobuild.sh
         "/*@MBOOT_STAGE_SHA@*/": sha("vendor/mboot/fm1-stage.fwsc"), "/*@MBOOT_UBOOT_SHA@*/": sha("vendor/mboot/fm1-uboot.fwsc"),
         "/*@WASM@*/": base64.b64encode(read("vendor/fm1_web.wasm", "rb")).decode()}
for mark, text in parts.items():
    assert page.count(mark) == 1, mark
    assert "</script" not in text.lower(), mark  # it would end the script tag that holds it
    page = page.replace(mark, text)
open(os.path.join(here, "index.html"), "w", encoding="utf-8").write(page)
print("index.html: %.1f MB" % (len(page) / 1e6))
