#!/usr/bin/env python3
"""Brings the firmware list built into the page up to date, then rebuilds index.html.

    python3 pocket/update-firmwares.py            # fetch, merge, write vendor/firmwares.json, run build.py
    python3 pocket/update-firmwares.py --check    # only say what would change

Sources (both read as they are, nothing is scraped):
  1. fm1-emu's firmwares.json (Joakim Eriksson's list, which says which firmwares crash the emulator: those stay out)
  2. the Firmware Hub's catalog.json (https://thefirmwarehub.com/catalog.json), which has firmwares the first one lacks
A hub entry becomes {id, name, version, author, license, about, package, repo, date, chip}; "chip" is the hub's reading of the
package: "new" saves on FM-1s with the newer flash chip (0xB36014), "any" does not check the chip, "old" knows only the first FM-1s.
Each firmware that RemoteFM1FW's release (or, failing that, TP/fm1-rfm1/out, our own converter's builds) (https://github.com/Quixotic7/RemoteFM1FW) has as an .rfm1 also gets "rfm1",
that file's name: the firmware's own code built for a computer as WebAssembly, which the page runs instead of emulating the chip.
The hub's package and version replace fm1-emu's pinned ones, because the hub removes old files. Then it runs the mirror's
own script (TP/fm1-firmwares/update.py, next to this repo), which downloads the new packages there and commits; the page
downloads from that mirror first. Push it afterwards with python3 ../fm1-firmwares/update.py --push. Standard library only.
"""
import json, os, re, subprocess, sys, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
JOAKIM = "https://joakimeriksson.github.io/fm1-emu/firmwares.json"
HUB = "https://thefirmwarehub.com/"
OUT = os.path.join(here, "vendor", "firmwares.json")
MIRROR = os.path.join(here, "..", "..", "fm1-firmwares", "update.py")
# licences the lists leave out or only point at, read in each repository's LICENSE (2026-11-26)
# shortcut: kept by hand; when the hub or fm1-emu list a licence for one of these, theirs wins and this entry can go
# firmwares neither list has, downloaded from their makers' own sites (the mirror doesn't copy them: not open licences);
# "extra" tells the page to keep them when it refreshes the list from those two
# shortcut: kept by hand, versions included; when the hub lists one, its entry wins and this one is dropped
EXTRA = [{"id": "shrub", "name": "SHRUB", "version": "1.39", "author": "Steve Duda (Xfer Records)", "license": "Free, all rights reserved (Xfer Inc.)",
          "about": "A stripped-down version of Serum: two wavetable oscillators, Serum's filters, envelopes and LFOs, a 16-slot modulation matrix, an effects rack, an arpeggiator and a motion sequencer. Its guide and editor are at shrub.audio.",
          "package": "https://shrub.audio/editor/firmware/SHRUB.fwsc", "date": "2026-11-26", "extra": True}]
RFM1 = "https://api.github.com/repos/Quixotic7/RemoteFM1FW/releases/latest"
OWN_RFM1 = os.path.join(here, "..", "..", "fm1-rfm1", "out")  # our own builds (TP/fm1-rfm1's convert.py), for firmwares the release lacks
LICENCE = {"emb": "GPL-3.0", "tangram": "GPL-2.0-or-later", "fm1chimeravocal": "MIT + MPL-2.0 + BSD (CMUdict)", "vesper": "GPL-3.0 + SDK exception"}


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


def rfm1s(out):
    """Sets "rfm1" on each firmware the release has a build of, matched by id, or by name when the ids differ (arcticscream: arctic), or with "fm1" before or after it."""
    try: names = [a["name"] for a in get(RFM1)["assets"] if a["name"].endswith(".rfm1")]
    except Exception as e: return print("rfm1: the release list did not download (%s), so the old matches stay" % e)
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    by = {**{norm(g["name"]): g for g in out}, **{g["id"]: g for g in out}}
    for g in out: g.pop("rfm1", None)
    for n in names:
        m = re.match(r"(.+?)-(\d[\w.-]*)\.rfm1$", n)
        g = m and next((by[k] for k in (m[1], norm(m[1]), "fm1" + norm(m[1]), norm(m[1]) + "fm1") if k in by), None)  # chimeravocal: fm1chimeravocal
        if g and re.fullmatch(r"[\w.-]{1,80}\.rfm1", n): g["rfm1"] = n
    print("rfm1: %d of the release's %d builds match a firmware on the list" % (sum("rfm1" in g for g in out), len(names)))
    own = sorted(os.listdir(OWN_RFM1)) if os.path.isdir(OWN_RFM1) else []
    ids, n = {g["id"]: g for g in out}, 0
    for name in own:  # <id>-<version>.rfm1; the release's build wins where both exist
        m = re.match(r"(.+?)-(\d[\w.-]*)\.rfm1$", name)
        g = m and ids.get(m[1])
        if g and "rfm1" not in g and re.fullmatch(r"[\w.-]{1,80}\.rfm1", name): g["rfm1"] = name; n += 1
    if own: print("rfm1: %d more from our own builds (%s)" % (n, os.path.normpath(OWN_RFM1)))


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
    out += [e for e in EXTRA if not any(e["id"] in (g["id"], g.get("hub")) for g in out)]
    for g in out:
        if g["id"] in LICENCE and not re.match(r"^(GPL|LGPL|MPL|MIT|Apache|BSD)", g.get("license") or ""): g["license"] = LICENCE[g["id"]]
    rfm1s(out)
    before = json.load(open(OUT)) if os.path.exists(OUT) else []
    print("fm1-emu list: %d · hub catalogue: %d · built in before: %d · now: %d" % (len(joakim["firmwares"]), len(hubs), len(before), len(out)))
    print("added from the hub (%d): %s" % (len(added), ", ".join(added) or "none"))
    if skipped: print("held back by fm1-emu: " + ", ".join(sorted(skipped)))
    if check: return
    with open(OUT, "w", encoding="utf-8") as fh: json.dump(out, fh, ensure_ascii=False, indent=1); fh.write("\n")
    subprocess.run([sys.executable, os.path.join(here, "build.py")], check=True)
    if os.path.exists(MIRROR): subprocess.run([sys.executable, MIRROR], check=True)  # commits there; push it with its --push
    else: print("mirror: skipped, no fm1-firmwares repo at " + os.path.normpath(os.path.dirname(MIRROR)))


main()
