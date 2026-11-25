#!/usr/bin/env python3
"""Brings the firmware list built into the page up to date, then rebuilds index.html.

    python3 pocket/update-firmwares.py            # fetch, merge, write vendor/firmwares.json, run build.py
    python3 pocket/update-firmwares.py --check    # only say what would change

Sources (both read as they are, nothing is scraped):
  1. fm1-emu's firmwares.json (Joakim Eriksson's list, which says which firmwares crash the emulator: those stay out)
  2. the Firmware Hub's catalog.json (https://thefirmwarehub.com/catalog.json), which has firmwares the first one lacks
A hub entry becomes {id, name, version, author, license, about, package, repo, date, chip}; "chip" is the hub's reading of the
package: "new" saves on FM-1s with the newer flash chip (0xB36014), "any" does not check the chip, "old" knows only the first FM-1s.
The hub's package and version replace fm1-emu's pinned ones, because the hub removes old files. Then it runs the mirror's
own script (TP/fm1-firmwares/update.py, next to this repo), which downloads the new packages there and commits; the page
downloads from that mirror first. Push it afterwards with python3 ../fm1-firmwares/update.py --push. Standard library only.
"""
import json, os, subprocess, sys, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
JOAKIM = "https://joakimeriksson.github.io/fm1-emu/firmwares.json"
HUB = "https://thefirmwarehub.com/"
OUT = os.path.join(here, "vendor", "firmwares.json")
MIRROR = os.path.join(here, "..", "..", "fm1-firmwares", "update.py")


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fm1-pocket-update"}), timeout=60) as r:
        return json.load(r)


def from_hub(h):
    repo = h.get("site") or ("https://github.com/" + h["repo"] if h.get("repo") else "")
    return {k: v for k, v in {
        "id": h["id"], "name": h["name"], "version": str(h.get("version") or ""), "author": h.get("author") or "",
        "license": h.get("lic") or "", "about": h.get("what") or "", "package": h["pkg"] if h["pkg"].startswith("https://") else HUB + h["pkg"], "repo": repo,
        "date": str(h.get("date") or "")[:10], "chip": h.get("chip") if h.get("chip") in ("new", "any", "old") else "",
    }.items() if v != ""}


def main():
    check = "--check" in sys.argv
    joakim, hub = get(JOAKIM), get(HUB + "catalog.json")
    skipped = set((joakim.get("skipped") or {}))
    mine = {f["id"]: f for f in joakim["firmwares"]}
    hubs = {h["id"]: h for h in hub["firmwares"] if h.get("pkg")}
    out, added = [], []
    for f in joakim["firmwares"]:
        h = hubs.get(f.get("hub") or f["id"])
        g = dict(f)
        if h:  # what the hub knows of the same firmware: its chip and date
            g.update({k: v for k, v in from_hub(h).items() if k in ("chip", "date", "package", "version")})
        out.append(g)
    for i, h in hubs.items():
        if i not in mine and i not in skipped and not any(f.get("hub") == i for f in joakim["firmwares"]):
            out.append(from_hub(h)); added.append(i)
    before = json.load(open(OUT)) if os.path.exists(OUT) else []
    print("fm1-emu list: %d · hub catalogue: %d · built in before: %d · now: %d" % (len(joakim["firmwares"]), len(hubs), len(before), len(out)))
    print("added from the hub (%d): %s" % (len(added), ", ".join(added) or "none"))
    if skipped: print("held back by fm1-emu: " + ", ".join(sorted(skipped)))
    if not any("shrub" in (f["id"] + f["name"]).lower() for f in out): print("note: no Shrub in either list yet (when the hub adds it, run this again)")
    if check: return
    with open(OUT, "w", encoding="utf-8") as fh: json.dump(out, fh, ensure_ascii=False, indent=1); fh.write("\n")
    subprocess.run([sys.executable, os.path.join(here, "build.py")], check=True)
    if os.path.exists(MIRROR): subprocess.run([sys.executable, MIRROR], check=True)  # commits there; push it with its --push
    else: print("mirror: skipped, no fm1-firmwares repo at " + os.path.normpath(os.path.dirname(MIRROR)))


main()
