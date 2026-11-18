// Shared, offline MIDI device wireframes and per-device assignments. Kept identical in all Pocket apps.
// The drawings are original line sketches of each controller's layout (not manufacturer images), made in code.
// Pads (MIDI channel 10) and knobs (CC numbers, in order) light up by themselves; LEARN pins a drawn control to
// the real one and to a Pocket function.
(function () {
  "use strict";
  // shape = which layout to draw; keys / pads / knobs = how many; base = lowest key's note number;
  // padNotes = the notes of the pads, one list per pad bank, in pad order (the Play mk3 sends a drum kit: 36 38 42 46 on the lower row), and ccs = the CC of each knob in order, when a model does not count them one by one (both read from a real MPK mini Play mk3)
  // cc0 = the CC number of knob 1 when the model is known (its knobs are cc0, cc0 + 1 ...); without it knobs go by rank
  const PROFILES = {
    synido: { title: "Synido Scale Pocket", shape: "mini", keys: 25, base: 48, pads: 0, knobs: 1, source: "https://www.synido.com/products/scale-pocket-portable-mini-piano-midi-controller-learn-scales-play-music" },
    akai: { title: "Akai MPK mini Play mk3 · internal sounds", shape: "mpk", keys: 25, base: 48, pads: 8, knobs: 8, cc0: 2, expr: 11, padNotes: [[36, 38, 42, 46, 48, 45, 51, 49], [60, 62, 63, 64, 58, 75, 56, 77]], ccs: [74, 71, 91, 93, 73, 72, 6], source: "https://www.akaipro.com/mpk-mini-play-mk3/" },
    // the standard layout: FAVORITE + pad 5 (GARAGEBAND). Read from a real MPK mini Play mk3: 8 knobs on CC 70 to 77, 16 pads on channel 10 (36 to 43, 44 to 51)
    akaigb: { title: "Akai MPK mini Play mk3 · standard (FAVORITE + pad 5)", shape: "mpk", keys: 25, base: 48, pads: 8, knobs: 8, cc0: 0, expr: 11, padNotes: [[36, 37, 38, 39, 40, 41, 42, 43], [44, 45, 46, 47, 48, 49, 50, 51]], ccs: [70, 71, 72, 73, 74, 75, 76, 77], source: "https://www.akaipro.com/mpk-mini-play-mk3/" },
    korgpad: { title: "Korg nanoPAD2 · pads", shape: "pads", keys: 0, base: 36, pads: 16, padCh: 0, knobs: 0, source: "https://www.korg.com/us/products/computergear/nanopad2/" },
    korgkey: { title: "Korg nanoKEY2 · 25 keys", shape: "nkey", keys: 25, base: 48, pads: 0, knobs: 0, source: "https://www.korg.com/us/products/computergear/nanokey2/" },
    casio: { title: "Casio PX-S1100", shape: "piano", keys: 88, base: 21, pads: 0, knobs: 0, source: "https://www.casio.com/us/electronic-musical-instruments/product.PX-S1100BK/" },
    novation25: { title: "Novation Launchkey · 25 keys", shape: "lk", keys: 25, base: 48, pads: 16, knobs: 8, cc0: 21, source: "https://novationmusic.com/launchkey" },
    novation37: { title: "Novation Launchkey · 37 keys", shape: "lk", keys: 37, base: 48, pads: 16, knobs: 8, cc0: 21, fold: 8, lights: "novation", ccs: [21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38], padNotes: [[40, 41, 42, 43, 48, 49, 50, 51, 36, 37, 38, 39, 44, 45, 46, 47]], source: "https://novationmusic.com/launchkey" },
    novation49: { title: "Novation Launchkey · 49 keys", shape: "lk", keys: 49, base: 36, pads: 16, knobs: 8, cc0: 21, source: "https://novationmusic.com/launchkey" },
    novation61: { title: "Novation Launchkey · 61 keys", shape: "lk", keys: 61, base: 36, pads: 16, knobs: 8, cc0: 21, source: "https://novationmusic.com/launchkey" },
    novation88: { title: "Novation Launchkey · 88 keys", shape: "lk", keys: 88, base: 21, pads: 16, knobs: 8, cc0: 21, source: "https://novationmusic.com/launchkey" },
    // read from a real unit on the stock firmware: 27 keys F3 to G5 (53 to 79), channel 1, fixed velocity 90, note-off; its knobs and buttons send nothing
    fm1: { title: "M-VAVE FM-1 · 27 keys", shape: "fm1", keys: 27, base: 53, pads: 0, knobs: 0, source: "" },
    generic: { title: "MIDI keyboard · generic", shape: "mpk", keys: 25, base: 48, pads: 8, knobs: 8, source: "" },
  };
  const css = `#mdPanel{position:fixed;inset:0;z-index:96;background:#000b;display:flex;align-items:center;justify-content:center;padding:12px;color:#eaf0f5;font:12px/1.45 system-ui}
#mdPanel *{box-sizing:border-box}#mdPanel .mdCard{width:min(900px,100%);max-height:94vh;overflow:auto;background:#1a2029;border:1px solid #54606e;border-radius:14px;padding:16px}
#mdPanel header{display:flex;align-items:center;justify-content:space-between;gap:10px}#mdPanel h2{margin:0;font-size:19px}#mdPanel button,#mdPanel select{background:#303b49;color:#fff;border:1px solid #647486;border-radius:6px;padding:8px;min-height:36px;font:inherit}
#mdPanel button{cursor:pointer}#mdPanel button:focus-visible,#mdPanel select:focus-visible{outline:2px solid #69ccfa}#mdPanel .mdRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}#mdPanel label{display:grid;gap:3px}#mdPanel small{color:#b4c4d1}#mdPanel a{color:#8bd5fc}
#mdPanel .mdDevice{margin:12px 0}#mdPanel .mdDevice svg{width:100%;height:auto;display:block}
#mdPanel .body{fill:#141a22;stroke:#8aa0b6;stroke-width:2}#mdPanel .sh,#mdPanel .dc{fill:none;stroke:#9fb2c6;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#mdPanel .dc{stroke:#5f7186}#mdPanel .tk{fill:none;stroke:#47576a;stroke-width:1.3;stroke-dasharray:1.5 5}#mdPanel .hit{fill:transparent;stroke:none}
#mdPanel .nm{fill:#8196ab;font:600 11px system-ui;text-anchor:middle;pointer-events:none}#mdPanel .mdc{cursor:pointer;outline:none}#mdPanel .mdc:focus-visible .sh{stroke:#69ccfa}
#mdPanel .mdc.lit .sh{fill:#38d5fb55;stroke:#38d5fb}#mdPanel .mdc.lit{filter:drop-shadow(0 0 6px #38d5fb)}#mdPanel .mdc.chosen .sh{stroke:#ffbf52;stroke-width:3}
#mdPanel .mdKey{fill:#1b232d;stroke:#9fb2c6;stroke-width:1;cursor:pointer;outline:none}#mdPanel .mdBlack{fill:#090d12}#mdPanel .mdKey:focus-visible{stroke:#69ccfa;stroke-width:2}
#mdPanel .mdKey.lit{fill:#38d5fb;filter:drop-shadow(0 0 5px #38d5fb)}#mdPanel .mdKey.chosen{stroke:#ffbf52;stroke-width:3}
#mdPanel .mdMap{border-top:1px solid #647486;padding-top:10px}#mdPanel .mdMap select{max-width:100%;min-width:200px}#mdPanel .mdHint{min-height:1.5em;color:#ffce84}
#mdPanel .mdBody,#mdPanel .mdSide{display:contents}#mdPanel .mdSide>.mdRow:nth-child(1){order:1}#mdPanel .mdSide>.mdRow:nth-child(2){order:2}#mdPanel #mdWiz{order:3}#mdPanel #mdLive{order:4}#mdPanel .mdDevWrap{order:5}#mdPanel .mdSide>.mdMap{order:6}
#mdPanel .mdCard{display:flex;flex-direction:column}#mdPanel .mdDevice{overflow:hidden}
/* an upright phone: the card turns sideways, so the diagram has the whole width. A short window: controls on the right, the diagram fills the rest, no scrolling */
#mdPanel.rot .mdCard{position:fixed;top:0;left:100vw;width:100vh;height:100vw;max-height:none;transform-origin:0 0;transform:rotate(90deg)}
#mdPanel.cmp .mdCard{padding:8px 12px;overflow:hidden}#mdPanel.cmp h2{font-size:15px}#mdPanel.cmp .mdCard>header{flex:none}
#mdPanel.cmp .mdBody{display:flex;flex-direction:row;gap:10px;flex:1;min-height:0}#mdPanel.cmp .mdSide{display:flex;flex-direction:column;width:300px;flex:none;overflow:auto;min-height:0}
#mdPanel.cmp .mdSide>*{order:0!important}#mdPanel.cmp .mdSide>.mdMap{order:9!important}#mdPanel.cmp .mdRow{margin:4px 0;gap:5px}#mdPanel.cmp button,#mdPanel.cmp select{min-height:30px;padding:4px 7px}
#mdPanel.cmp .mdDevWrap{order:0;flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}#mdPanel.cmp .mdDevWrap small,#mdPanel.cmp .mdMap small,#mdPanel.cmp .mdMap p{display:none}
#mdPanel.cmp .mdDevice{margin:0}#mdPanel.cmp .mdDevice svg{max-height:calc(var(--mdH) - 60px);margin:auto}
#mdPanel .tg path{fill:none;stroke:#ffbf52;stroke-width:1.1;opacity:.75}#mdPanel .tg rect{fill:#1a2029;stroke:#ffbf52;stroke-width:1.2}#mdPanel .tg text{fill:#ffd28a;font:700 11.5px system-ui;text-anchor:middle;pointer-events:none}
#mdPanel .mdCard{position:relative}
#mdPanel .mdList{position:absolute;inset:0;z-index:5;background:#0d1218f5;border-radius:14px;padding:12px;overflow:auto;display:flex;flex-direction:column;gap:8px}
#mdPanel .mdList h3{margin:0;font-size:13px;letter-spacing:1px;color:#ffce84}#mdPanel .mdOpts{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
#mdPanel .mdList button{min-height:46px;text-align:left;font-size:14px}#mdPanel .mdList button.on{background:#ffbf52;border-color:#ffbf52;color:#1a1204;font-weight:700}
/* a short window: the drawing takes the room, the controls are one row under it, and what a chosen control does comes up over that row */
#mdPanel.cmp .mdBody{flex-direction:column}#mdPanel.cmp .mdDevWrap{order:1!important;flex:1;min-height:0}
#mdPanel.cmp .mdSide{order:2!important;flex:none;width:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px;overflow:visible}
#mdPanel.cmp .mdSide>.mdRow{margin:0;flex-wrap:nowrap}#mdPanel.cmp .mdRow label{display:flex;gap:4px;align-items:center;font-size:10px}
#mdPanel.cmp #mdLive{display:none}#mdPanel.cmp .mdMap{display:none!important}
#mdPanel.cmp.sel .mdMap{display:block!important;position:absolute;left:8px;right:8px;bottom:8px;z-index:4;background:#1a2029;border:2px solid #ffbf52;border-radius:12px;padding:8px 10px;box-shadow:0 0 40px #000}
#mdPanel.cmp .mdSide>.mdMap{order:0!important}
#mdPanel.cmp .mdCard{height:calc(var(--mdH) - 24px);max-height:none}#mdPanel.cmp .tg{display:none}#mdPanel.cmp .mdDevWrap .mdDevice{flex:1;min-height:0;display:flex;margin:0}#mdPanel.cmp .mdDevWrap .mdDevice{position:relative}#mdPanel.cmp .mdDevWrap .mdDevice svg{position:absolute;inset:0;width:100%;height:100%;max-height:none;margin:0}
#mdPanel #mdWiz{border:2px solid #ffbf52;border-radius:10px;padding:10px;margin:10px 0}#mdPanel #mdWiz[hidden]{display:none}#mdPanel #mdWiz h3{margin:0 0 4px;font-size:15px;color:#ffce84}#mdPanel #mdWiz .mdSt{min-height:1.5em;color:#8bd5fc;font-weight:700}
#mdPanel #mdLive{color:#9fb2c6;font:12px/1.4 ui-monospace,monospace;min-height:1.4em;overflow-wrap:anywhere}
#mdPanel .mdc .sh{fill:#141a22}#mdPanel .tg.info path{stroke:#647486}#mdPanel .tg.info rect{stroke:#647486}#mdPanel .tg.info text{fill:#9fb2c6}`;
  const storageKey = "pocket.midi.devices.v1." + location.pathname.split("/").filter(Boolean)[0];
  // the hardware's own measures (what MAP found), shared by the Pocket apps: one mapping serves all of them
  const hwKey = "pocket.midi.hw.v1";
  const loadHw = () => { try { return JSON.parse(localStorage.getItem(hwKey) || "{}"); } catch { return {}; } };
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const TOK = /^(?:[nc](?:1[0-5]|\d):(?:1[0-2]\d|\d{1,2})|rt:25[0-2]|mmc:\d{1,3})$/; // a function button: a note, a CC, a realtime byte or an MMC command
  // checks what is read from a file: only known fields, only values in range
  const vetHw = (o) => {
    if (!o || typeof o !== "object") return null;
    const c = {};
    if (int(o.keys, 1, 128)) c.keys = o.keys;
    if (Array.isArray(o.padNotes) && o.padNotes.length <= 8 && o.padNotes.every((b) => Array.isArray(b) && b.length <= 64 && b.every((n) => int(n, 0, 127))) && int(o.pads, 1, 64)) { c.padNotes = o.padNotes; c.pads = o.pads; c.padCh = int(o.padCh, 0, 15) ? o.padCh : 9; }
    if (Array.isArray(o.ccs) && o.ccs.length && o.ccs.length <= 32 && o.ccs.every((n) => int(n, 0, 127))) { c.ccs = o.ccs; c.knobs = o.ccs.length; c.cc0 = 0; }
    if (int(o.sus, 0, 127)) c.sus = o.sus;
    if (int(o.bend, 0, 15)) c.bend = o.bend;
    if (int(o.mod, 0, 127)) c.mod = o.mod;
    if (int(o.expr, 0, 127)) c.expr = o.expr;
    if (typeof o.modKey === "string" && /^[nc]/.test(o.modKey) && TOK.test(o.modKey)) c.modKey = o.modKey; // the key or pedal that turns the pads and knobs into a second set while held
    if (o.fn && typeof o.fn === "object") { const f = {}; for (const [k, v] of Object.entries(o.fn)) if (/^(?:play|stop|rec|f\d{1,2})$/.test(k) && TOK.test(v)) f[k] = v; if (Object.keys(f).length) c.fn = f; }
    return Object.keys(c).length ? c : null;
  };
  const load = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const guess = (s) => {
    if (/scale pocket|synido/i.test(s)) return "synido";
    if (/\bfm-?1\b|felucca|gr!?mm/i.test(s)) return "fm1"; // (firmwares built on Felucca name their port after it)
    if (/mpk|akai/i.test(s)) return "akai";
    if (/nanokey/i.test(s)) return "korgkey";
    if (/nanopad|korg/i.test(s)) return "korgpad";
    if (/casio|privia|px-s|cdp/i.test(s)) return "casio";
    if (/launchkey|novation/i.test(s)) { const n = (s.match(/\b(25|37|49|61|88)\b/) || [])[1]; return "novation" + (n || 25); }
    return "generic";
  };
  const noteName = (n) => ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][n % 12] + (Math.floor(n / 12) - 1);
  // Pads send notes on MIDI channel 10 (36 and up); with more pads than the bank, banks wrap round.
  const padIndex = (pads, note, banks) => {
    for (const b of banks || []) if (b.includes(note)) return b.indexOf(note);
    return (((note - 36) % pads) + pads) % pads;
  };
  // Knobs are matched in the order of their CC numbers (mod wheel, sustain and the like are not knobs).
  const NOT_KNOB = new Set([0, 1, 32, 64, 98, 99, 100, 101]);
  const knobRank = (seen, cc, cc0, ccs, fold) => { const r = (ccs ? ccs.indexOf(cc) : cc0 != null ? (cc >= cc0 ? cc - cc0 : -1) : NOT_KNOB.has(cc) || cc >= 120 ? -1 : [...(seen || [])].filter((x) => !NOT_KNOB.has(x) && x < 120).sort((a, b) => a - b).indexOf(cc)); return fold && r >= 0 ? r % fold : r; }; // fold: a second bank of the same knobs (Launchkey MK4: CC 21-28, then 31-38) counts as the same knobs

  // ---------- the wireframes (SVG, 840 wide)
  const W = 840;
  const num = (n) => Math.round(n * 10) / 10;
  const g = (id, label, inner) => `<g class="mdc" data-control="${id}" tabindex="0" role="button" aria-label="${esc(label)}">${inner}</g>`;
  const knob = (id, x, y, r, label) => g(id, label, `<circle class="hit" cx="${x}" cy="${y}" r="${r + 8}"/><circle class="tk" cx="${x}" cy="${y}" r="${r + 5}"/><circle class="sh" cx="${x}" cy="${y}" r="${r}"/><line class="sh" x1="${x}" y1="${y}" x2="${x}" y2="${num(y - r + 4)}" transform="rotate(40 ${x} ${y})"/>`);
  const pad = (id, x, y, s, n) => g(id, "Pad " + n, `<rect class="sh" x="${x}" y="${y}" width="${s}" height="${s}" rx="6"/><rect class="dc" x="${num(x + 5)}" y="${num(y + 5)}" width="${s - 10}" height="${s - 10}" rx="3"/><text class="nm" x="${num(x + s / 2)}" y="${num(y + s / 2 + 4)}">${n}</text>`);
  // flip: pad 1 is on the bottom row (the MPK numbers its pads from the bottom left)
  const padGrid = (x, y, cols, count, s, gap, flip) => Array.from({ length: count }, (_, i) => { const r = Math.floor(i / cols), rows = Math.ceil(count / cols); return pad("p" + i, x + (i % cols) * (s + gap), y + (flip ? rows - 1 - r : r) * (s + gap), s, i + 1); }).join("");
  const knobGrid = (x, y, cols, count, dx, dy, r) => Array.from({ length: count }, (_, i) => knob("c" + i, x + (i % cols) * dx, y + Math.floor(i / cols) * dy, r, "Knob " + (i + 1))).join("");
  const wheel = (x, y, w, h) => `<rect class="dc" x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}"/>` + [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => `<line class="dc" x1="${x + 4}" x2="${x + w - 4}" y1="${num(y + h * f)}" y2="${num(y + h * f)}"/>`).join("");
  // the joystick is a control of its own ("j"): pitch bend and the mod wheel CC 1 light it, never a knob
  const joystick = (x, y, r) => g("j", "Joystick", `<circle class="hit" cx="${x}" cy="${y}" r="${r + 6}"/><circle class="sh" cx="${x}" cy="${y}" r="${r}"/><circle class="dc" cx="${x}" cy="${y}" r="${num(r * 0.5)}"/><path class="dc" d="M${x - r} ${y}h${2 * r}M${x} ${y - r}v${2 * r}"/>`);
  const btn = (x, y, w, h) => `<rect class="dc" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>`;
  const btnRow = (x, y, n, w, h, gap) => Array.from({ length: n }, (_, i) => btn(x + i * (w + gap), y, w, h)).join("");
  const screen = (x, y, w, h) => `<rect class="dc" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/><path class="dc" d="M${x + 8} ${y + h * 0.35}h${w * 0.5}M${x + 8} ${y + h * 0.65}h${w * 0.3}"/>`;
  const speaker = (x, y, w, h) => Array.from({ length: Math.floor(h / 10) }, (_, i) => `<line class="dc" x1="${x}" x2="${x + w}" y1="${y + i * 10}" y2="${y + i * 10}" stroke-dasharray="6 5"/>`).join("");
  function keysSvg(x, y, w, h, n, base) {
    const black = (m) => [1, 3, 6, 8, 10].includes(m % 12);
    let whites = 0;
    for (let i = 0; i < n; i++) if (!black(base + i)) whites++;
    const kw = w / Math.max(1, whites), bw = kw * 0.62;
    let wi = 0, out = "", blk = "";
    for (let i = 0; i < n; i++) {
      const m = base + i, lab = `data-control="k${m}" data-note="${m}" tabindex="0" role="button" aria-label="${noteName(m)}"`;
      if (black(m)) {
        const cx = Math.min(Math.max(x + wi * kw, x + bw / 2), x + w - bw / 2);
        blk += `<rect class="mdKey mdBlack" ${lab} x="${num(cx - bw / 2)}" y="${y}" width="${num(bw)}" height="${num(h * 0.6)}" rx="2"><title>${noteName(m)}</title></rect>`;
      } else {
        out += `<rect class="mdKey mdWhite" ${lab} x="${num(x + wi * kw)}" y="${y}" width="${num(kw)}" height="${h}" rx="3"><title>${noteName(m)}</title></rect>`;
        if (m % 12 === 0 && kw >= 11) out += `<text class="nm" x="${num(x + wi * kw + kw / 2)}" y="${y + h - 7}" style="font-size:${kw > 24 ? 11 : 8}px">${noteName(m)}</text>`;
        wi++;
      }
    }
    return out + blk;
  }
  function schematic(p, base) {
    let h = 0, inner = "";
    const keys = (y, kh, x0 = 22) => keysSvg(x0, y, W - 2 * x0, kh, p.keys, base);
    switch (p.shape) {
      case "mpk": // joystick, 4x2 pads, screen, 4x2 knobs, speaker; the keys along the bottom
        h = 290;
        inner = joystick(62, 78, 32) + padGrid(120, 22, 4, p.pads, 54, 8, true) + screen(392, 34, 96, 50) + btnRow(392, 102, 3, 26, 22, 8) + knobGrid(546, 48, 4, p.knobs, 60, 64, 19) + speaker(776, 30, 38, 110) + keys(170, 100);
        break;
      case "lk": // wheels, screen and buttons, a row of 8 knobs over 2x8 pads, a fader; the keys at the bottom
        h = 330;
        inner = wheel(24, 24, 26, 150) + wheel(60, 24, 26, 150) + screen(112, 30, 170, 54) + btnRow(112, 104, 3, 52, 26, 8) + btnRow(112, 142, 3, 52, 26, 8) + knobGrid(352, 44, 8, p.knobs, 50, 0, 16) + padGrid(334, 86, 8, p.pads, 42, 8) + btn(772, 30, 14, 146) + btn(764, 70, 30, 22) + keys(200, 112);
        break;
      case "mini": // a small keyboard: one knob, a display, scale buttons
        h = 230;
        inner = knob("c0", 58, 52, 20, "Knob 1") + screen(112, 28, 130, 50) + btnRow(272, 34, 6, 42, 32, 10) + keys(112, 100);
        break;
      case "fm1": // the FM-1: a screen over 27 keys (its knobs and buttons send no MIDI on the stock firmware)
        h = 190;
        inner = screen(24, 26, 150, 56) + keys(100, 70);
        break;
      case "piano": // 88 keys under a slim panel
        h = 210;
        inner = `<circle class="dc" cx="38" cy="38" r="10"/>` + `<rect class="dc" x="92" y="33" width="130" height="10" rx="5"/><rect class="dc" x="150" y="27" width="14" height="22" rx="4"/>` + btnRow(270, 24, 6, 40, 28, 10) + keys(80, 114, 14);
        break;
      case "pads": // nanoPAD2: the X-Y touch pad, six buttons over a 4x4 pad grid, no keys
        h = 370;
        inner = g("xy", "X-Y pad", `<rect class="sh" x="70" y="40" width="290" height="290" rx="10"/><path class="dc" d="M215 40v290M70 185h290"/><circle class="dc" cx="215" cy="185" r="16"/>`) + btnRow(430, 28, 6, 36, 20, 8) + padGrid(430, 64, 4, p.pads, 62, 8, true);
        break;
      case "nkey": // nanoKEY2: octave shift, pitch bend, mod and sustain buttons over 25 slim keys
        h = 260;
        inner = [["o-", "OCT −"], ["o+", "OCT +"], ["b-", "PITCH −"], ["b+", "PITCH +"], ["m", "MOD"], ["s", "SUSTAIN"]].map(([id, t], i) => g(id, t, `<rect class="sh" x="${40 + i * 70}" y="30" width="56" height="34" rx="6"/><text class="nm" x="${68 + i * 70}" y="52">${t}</text>`)).join("") + keys(110, 130);
        break;
    }
    return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(p.title)} wireframe"><rect class="body" x="1" y="1" width="${W - 2}" height="${h - 2}" rx="16"/>${inner}</svg>`;
  }

  function createMidiPanel(MI, run, send) {
    const saved = load(), hw = loadHw();
    let el, device = "", profile = "", selected = "", learning = false, base = 48;
    const flash = new Map(), seenCC = {};
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved));
    const persistHw = () => localStorage.setItem(hwKey, JSON.stringify(hw));
    const record = () => (saved[device] = saved[device] || { profile: guess(device), map: {}, controls: {} });
    // the model's profile with the device's own measures on top (what MAP found)
    const withMap = (p, name) => (hw[name] ? { ...p, ...hw[name] } : p);
    const layer = {}; // device -> is its mod key held
    const MODP = "pocket.midi.modpedal"; // "0": the mod key (the sustain pedal, or the one MAP found) is off
    const modPedalOn = () => { try { return localStorage.getItem(MODP) !== "0"; } catch { return true; } };
    const profById = (id) => (typeof id === "string" && Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : PROFILES.generic);
    const prof = () => withMap(profById(profile), device);
    // ---- the starting assignment: what a control does before anyone assigns it (the app lists it in MI.defaults)
    const defs = () => (typeof MI.defaults === "function" ? MI.defaults() : MI.defaults) || {};
    const profOf = (from) => withMap(profById(saved[from]?.profile || guess(from)), from);
    const shortName = (id) => String((MI.actions().find((x) => x.id === id) || { name: id }).name).replace("VOLUME ", "VOL ").slice(0, 12);
    // [action id, label] a model gives control id (a pad "p3", a knob "c1"), or null. Knobs need a known first CC.
    function factory(p, id) {
      const d = defs(), i = +id.slice(1);
      if (id[0] === "p" && p.pads) return (p.pads >= 16 && d.pads16 ? d.pads16 : d.pads)?.[i] || (d.padText ? ["", d.padText + " " + (i + 1)] : null);
      if (id[0] === "c" && p.knobs && p.cc0 != null) return d.knobs?.[i] || null;
      return null;
    }
    function effective(dev, p, id) {
      const r = saved[dev], c = r?.controls?.[id];
      if (c && "action" in c) return c.action ? [c.action, shortName(c.action)] : null; // the user's own choice
      if (r?.defaults === false) return null;
      const f = factory(p, id);
      if (!f) return null;
      const taken = f[0] && (Object.values(r?.map || {}).includes(f[0]) || Object.values(MI.map || {}).includes(f[0]) || Object.entries(r?.controls || {}).some(([k, v]) => k !== id && v.action === f[0]));
      return taken ? null : f; // an action the user put on another control is not also on this one
    }
    function controlOf(from, key) {
      const p = profOf(from), bound = Object.entries(saved[from]?.controls || {}).find(([, v]) => v.key === key)?.[0];
      if (bound) return bound;
      const [, t, ch, n] = key.match(/^([nc])(\d+):(\d+)$/) || [];
      if (t === "n") return +ch === (p.padCh ?? 9) && p.pads ? "p" + (padIndex(p.pads, +n, p.padNotes) + (layer[from] ? p.pads : 0)) : "";
      const r = t === "c" ? knobRank(seenCC[from], +n, p.cc0, p.ccs, p.fold) : -1;
      return p.cc0 != null && r >= 0 && r < p.knobs ? "c" + (r + (layer[from] ? p.knobs : 0)) : "";
    }
    // the pads of a device as [{ch, note, action}] in pad order: what to light on its output (a pad MAP learned keeps its own note)
    function padList(from) {
      const p = profOf(from);
      return Array.from({ length: p.pads || 0 }, (_, i) => {
        const id = "p" + i, m = (saved[from]?.controls?.[id]?.key || "").match(/^n(\d+):(\d+)$/), e = effective(from, p, id);
        return { ch: m ? +m[1] : p.padCh ?? 9, note: m ? +m[2] : p.padNotes?.flat()[i], action: e && e[0] };
      }).filter((x) => x.note != null);
    }
    const downAs = {};
    // a control nobody assigned, doing what its model's starting assignment says
    function fallback(from, key, cc, on, value) {
      if (!cc && MI.holdDefaults && MI.holdDefaults()) return false; // the app is using the pads and keys for something on screen (a knob keeps its starting function)
      const dk = from + "|" + key, id = !cc && !on && downAs[dk] != null ? downAs[dk] : controlOf(from, key);
      if (!cc) { if (on) downAs[dk] = id; else delete downAs[dk]; } // a note let go after the MOD key still ends the function it started
      const e = effective(from, profOf(from), id), action = e && e[0] && MI.actions().find((a) => a.id === e[0]);
      if (!action) return false;
      run(action, from + "/" + key, cc, on, value);
      return true;
    }
    function defaultsOff() {
      MI.names.forEach((n) => { saved[n] = saved[n] || { profile: guess(n), map: {}, controls: {} }; saved[n].defaults = false; });
      persist();
      if (el) { drawDevice(); select(selected); }
    }
    // a tag with a line to each control that has a function, above the drawing (two rows when there are many)
    function tags(svg) {
      const p = prof(), items = [], d = defs();
      svg.querySelectorAll('[data-control^="p"],[data-control^="c"]').forEach((n) => {
        const e = effective(device, p, n.dataset.control);
        if (!e || !e[1]) return;
        const b = n.getBBox();
        items.push({ x: b.x + b.width / 2, y: b.y, t: e[1], on: !!e[0] });
      });
      items.sort((a, b) => a.x - b.x || a.y - b.y);
      const h = svg.viewBox.baseVal.height, rows = items.length > 8 ? 2 : 1, T = items.length ? rows * 26 + 10 : 0, B = p.keys && d.keys ? 38 : 0;
      if (!T && !B) return;
      let out = "";
      const tag = (x, y, t, wmax) => { const w = Math.min(t.length * 7 + 14, wmax); return `<rect x="${num(x - w / 2)}" y="${y}" width="${num(w)}" height="19" rx="9"/><text x="${num(x)}" y="${y + 13.5}">${esc(t)}</text>`; };
      items.forEach((it, i) => {
        const sx = items.length > 1 ? 50 + (i * (W - 100)) / (items.length - 1) : W / 2, ty = -T + 6 + (rows === 2 ? (i % 2) * 26 : 0), ym = ty + 19 + 8;
        out += `<g class="tg${it.on ? "" : " info"}"><path d="M${num(it.x)} ${num(it.y)}V${num(Math.max(ym, ty + 20))}L${num(sx)} ${ty + 19}"/>${tag(sx, ty, it.t.slice(0, 12), 2 * ((W - 100) / Math.max(1, items.length - 1)) - 6)}</g>`;
      });
      if (B) out += `<g class="tg info"><path d="M${W / 2} ${h - 2}V${h + 10}"/>${tag(W / 2, h + 10, "KEYS · " + d.keys, 260)}</g>`;
      svg.setAttribute("viewBox", `0 ${-T} ${W} ${h + T + B}`);
      svg.querySelector(".body").insertAdjacentHTML("afterend", out);
    }
    // ---- what each input sent: channels, velocity, CCs, clock, transport ... (the live line and COPY REPORT)
    const stats = {};
    let liveT = 0;
    function tally(d, from) {
      const T = stats[from] || (stats[from] = { ch: new Set(), notes: 0, nlo: 127, nhi: 0, vlo: 127, vhi: 0, o80: 0, o90: 0, cc: {}, pb: 0, cat: 0, pat: 0, pc: 0, clock: 0, tt: [], bpm: 0, tr: new Set(), sx: 0, log: [], t0: performance.now() }),
        st = d[0], cmd = st & 0xf0, now = performance.now();
      if (T.log.length < 400 && st !== 0xf8 && st !== 0xfe) T.log.push([Math.round(now - T.t0), ...d]);
      if (st >= 0xf0) {
        if (st === 0xf8) { T.clock++; T.tt.push(now); if (T.tt.length > 49) T.tt.shift(); if (T.tt.length >= 25) T.bpm = 60000 / (((T.tt[T.tt.length - 1] - T.tt[0]) / (T.tt.length - 1)) * 24); }
        else if (st >= 0xfa && st <= 0xfc) T.tr.add({ 250: "start", 251: "continue", 252: "stop" }[st]);
        else if (st === 0xf0) T.sx++;
      } else {
        T.ch.add((st & 15) + 1);
        if (cmd === 0x90 && d[2] > 0) { T.notes++; T.nlo = Math.min(T.nlo, d[1]); T.nhi = Math.max(T.nhi, d[1]); T.vlo = Math.min(T.vlo, d[2]); T.vhi = Math.max(T.vhi, d[2]); }
        else if (cmd === 0x80) T.o80++;
        else if (cmd === 0x90) T.o90++;
        else if (cmd === 0xb0) { const k = (T.cc[d[1]] = T.cc[d[1]] || { lo: 127, hi: 0, n: 0 }); k.n++; k.lo = Math.min(k.lo, d[2]); k.hi = Math.max(k.hi, d[2]); }
        else if (cmd === 0xe0) T.pb++;
        else if (cmd === 0xd0) T.cat++;
        else if (cmd === 0xa0) T.pat++;
        else if (cmd === 0xc0) T.pc++;
      }
      if (!liveT) liveT = setTimeout(() => { liveT = 0; live(); }, 150); // a steady clock must not redraw all the time
    }
    function liveText(T) {
      if (!T) return "";
      const x = [];
      if (T.clock) x.push(`clock ${T.bpm ? T.bpm.toFixed(1) + " BPM" : "…"}`);
      if (T.tr.size) x.push([...T.tr].join("/"));
      if (T.sx) x.push(`sysex ${T.sx}`);
      if (T.ch.size) x.push("ch " + [...T.ch].sort((a, b) => a - b).join(","));
      if (T.vhi) x.push(`vel ${T.vlo}–${T.vhi}`);
      if (T.pb) x.push("bend");
      if (T.cat || T.pat) x.push("aftertouch");
      const last = T.log[T.log.length - 1];
      if (last) x.push("last " + last.slice(1).map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join(" ").slice(0, 40));
      return x.join(" · ");
    }
    function live() { const e = el?.querySelector("#mdLive"); if (e) e.textContent = liveText(stats[device]); }
    function report() {
      const T = stats[device], nm = (n) => noteName(n), ccs = T ? Object.entries(T.cc) : [];
      const rows = [
        "Device: " + device + " — " + prof().title,
        T ? `Notes: ${T.notes} presses${T.notes ? `, ${nm(T.nlo)} to ${nm(T.nhi)}` : ""}` : "Notes: none yet",
        "Channels: " + (T && T.ch.size ? [...T.ch].sort((a, b) => a - b).join(", ") : "—"),
        "Velocity: " + (T && T.vhi ? `${T.vlo} to ${T.vhi}` : "—"),
        "Note off: " + (T && (T.o80 || T.o90) ? (T.o80 && T.o90 ? "both kinds" : T.o80 ? "note-off messages" : "note-on with velocity 0") : "—"),
        "CC: " + (ccs.length ? ccs.map(([n, k]) => `${n} (${k.lo}–${k.hi}, ${k.n}x)`).join(", ") : "—"),
        `Pitch bend: ${T ? T.pb : 0} · Aftertouch: ${T ? T.cat + T.pat : 0} · Program change: ${T ? T.pc : 0}`,
        "Clock: " + (T && T.clock ? `${T.clock} ticks, ${T.bpm ? T.bpm.toFixed(1) + " BPM" : "BPM not measured"}` : "—") + " · Transport: " + (T && T.tr.size ? [...T.tr].join(", ") : "—") + " · Sysex: " + (T ? T.sx : 0),
        "Map: " + JSON.stringify(hw[device] || null),
        "",
        "first messages [ms, bytes...]:",
        JSON.stringify(T ? T.log : []),
      ];
      return rows.join("\n");
    }
    function copyReport() {
      (navigator.clipboard ? navigator.clipboard.writeText(report()) : Promise.reject()).then(() => hint("Report copied: paste it in an issue or a message.")).catch(() => hint("Could not copy here."));
    }
    // the device's map as a file: the same shape the import reads (and what a new compatible device is added from)
    function exportHw() {
      const o = { format: "pocket-device", v: 1, name: device, model: record().profile, map: hw[device] || null };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: "application/json" }));
      a.download = "pocket-device-" + (device.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "midi") + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      hint(hw[device] ? "Exported " + a.download : "Exported the model only: run MAP DEVICE first to include your own map.");
    }
    function importHw(text) {
      let o; try { o = JSON.parse(text); } catch { return hint("That file is not a device map."); }
      if (!o || o.format !== "pocket-device") return hint("That file is not a device map.");
      const c = vetHw(o.map);
      if (!c && o.map) return hint("Nothing usable in that map.");
      if (c) hw[device] = c; else delete hw[device];
      persistHw();
      if (typeof o.model === "string" && Object.prototype.hasOwnProperty.call(PROFILES, o.model)) { record().profile = o.model; persist(); }
      draw();
      hint("Map imported for " + device + (c ? "" : " (model only)") + ".");
    }
    // lights and the other way: notes sent to the device's output with the same name (pads with LEDs light up)
    function lightTest() {
      let out; try { out = MI.acc && [...MI.acc.outputs.values()].find((o) => o.name === device && o.state !== "disconnected"); } catch {}
      if (!out) return hint("No MIDI output named " + device + ": the device does not take messages from the computer, or the browser did not open it.");
      const p = prof(), ch = p.padCh ?? 9, notes = (p.padNotes ? p.padNotes.flat() : Array.from({ length: p.pads || 8 }, (_, i) => 36 + i)).slice(0, 32);
      try { notes.forEach((n, i) => { setTimeout(() => out.send([0x90 | ch, n, 127]), i * 120); setTimeout(() => out.send([0x80 | ch, n, 0]), i * 120 + 220); }); } catch (e) { return hint("The output would not take it: " + e.message); }
      hint(`Sent ${notes.length} notes to ${out.name}. If its pads light up, it takes lights from here. Whatever it sends back shows in the line below.`);
    }
    // ---- MAP: a step-by-step mapper like an emulator's. A connection check, the lowest and the highest key, every pad in order, every knob
    // in order, the sustain, the bend, the mod, the transport buttons and any other function button. A list ends with the highest key and
    // then the lowest key (or NEXT). The keys only give the NUMBER of physical keys (leftmost to rightmost, whatever octave is selected).
    let wiz = null;
    const STEP = {
      hello: ["CONNECTION", "Press any key, pad or knob once, to check that the connection works."],
      lo: ["LEFTMOST KEY", "Press the leftmost key of the keyboard, whatever octave is selected (and do not change the octave until MAP ends). No keys? NEXT."],
      hi: ["RIGHTMOST KEY", "Press the rightmost key of the keyboard."],
      modkey: ["MOD KEY (optional)", "Want a MOD key? While it is held, the pads and knobs become a second set (knob 1 acts as knob 9, and so on), so a few controls can do double duty. The sustain pedal is a good choice: it keeps its own job too. Press the pedal or a key (not the leftmost or the rightmost one), or NEXT for none."],
      pads: ["PADS", "Press every pad one by one, from the TOP LEFT pad to the BOTTOM RIGHT pad: left to right, then top to bottom (all the banks, if there are some). That order is the pad numbering the apps use. To finish: the rightmost key, then the leftmost key, or NEXT."],
      knobs: ["KNOBS", "Turn every knob a little, in order. To finish: the rightmost key, then the leftmost key, or NEXT."],
      sus: ["SUSTAIN", "Press the sustain pedal or button. To skip: the rightmost key, then the leftmost key, or NEXT."],
      stick: ["STICK AND WHEELS", "Move the stick or the wheels through their full range: left, right, up and down (and an expression pedal, if any), then let go. Everything that moves is listed. NEXT when done (or skip: the rightmost key, then the leftmost key)."],
      play: ["PLAY", "Press the PLAY button. To skip: the rightmost key, then the leftmost key, or NEXT."],
      stop: ["STOP", "Press the STOP button. To skip: the rightmost key, then the leftmost key, or NEXT."],
      rec: ["RECORD", "Press the RECORD button. To skip: the rightmost key, then the leftmost key, or NEXT."],
      fn: ["OTHER FUNCTION BUTTONS", "Press any other function button (loop, rewind, forward, octave, preset...), one at a time. To finish: the rightmost key, then the leftmost key, or FINISH."],
    };
    const ORDER = Object.keys(STEP);
    function wizShow() {
      const box = el?.querySelector("#mdWiz");
      if (!box) return;
      box.hidden = !wiz;
      if (!wiz) return;
      const [t, d] = STEP[wiz.step];
      setTimeout(fitPanel, 0);
      box.innerHTML = `<h3>MAP · ${ORDER.indexOf(wiz.step) + 1} / ${ORDER.length} · ${t}</h3><div>${d}</div><div class="mdSt" id="mdWizSt" aria-live="polite">${esc(wiz.msg || "")}</div><div class="mdRow"><button data-do="wizBack"${wiz.step === "hello" ? " disabled" : ""}>BACK</button><button data-do="wizNext">${wiz.step === "fn" ? "FINISH" : "NEXT"}</button><button data-do="wizCancel">CANCEL</button></div>`;
    }
    const wizSay = (m) => { wiz.msg = m; const e = el?.querySelector("#mdWizSt"); if (e) e.textContent = m; };
    function wizStart() {
      learning = false;
      wiz = { step: "hello", lo: null, hi: null, loCh: null, padCh: null, pads: [], ccs: [], sus: null, bend: null, modKey: null, sk: {}, fn: {}, extra: 0, last: [], msg: "Listening to " + device + "..." };
      wizShow();
    }
    function wizGo(step) { wiz.step = step; wiz.last = []; wiz.msg = ""; wizShow(); }
    // NEXT: the next step; with no keys told yet, the two key steps go together
    function wizNext() {
      if (!wiz) return;
      let i = ORDER.indexOf(wiz.step) + 1;
      if (wiz.step === "lo") i = ORDER.indexOf("modkey");
      if (i >= ORDER.length) return wizEnd();
      wizGo(ORDER[i]);
    }
    // BACK: one step back, forgetting what that step (and the one being left) had recorded, so it can be done again
    function wizClear(step) {
      const w = wiz;
      if (step === "lo") w.lo = w.hi = w.loCh = null;
      else if (step === "hi") w.hi = null;
      else if (step === "pads") { w.pads = []; w.padCh = null; }
      else if (step === "modkey") w.modKey = null;
      else if (step === "knobs") w.ccs = [];
      else if (step === "sus") w.sus = null;
      else if (step === "stick") { w.bend = null; w.sk = {}; }
      else if (step === "fn") { for (const k of Object.keys(w.fn)) if (/^f\d/.test(k)) delete w.fn[k]; w.extra = 0; }
      else delete w.fn[step];
    }
    function wizBack() {
      if (!wiz || wiz.step === "hello") return;
      let i = ORDER.indexOf(wiz.step) - 1;
      if (ORDER[i] === "hi" && wiz.lo == null) i--; // the key steps were skipped together
      wizClear(wiz.step); wizClear(ORDER[i]);
      wizGo(ORDER[i]);
    }
    // the CCs of the stick and the wheels in the order they appeared: CC 1 is the mod and CC 11 the expression, else the first two that moved
    function stickRoles(w) {
      const l = Object.keys(w.sk).map(Number), mod = l.includes(1) ? 1 : l.find((n) => n !== 11), expr = l.includes(11) ? 11 : l.find((n) => n !== mod);
      return { mod, expr };
    }
    function wizEnd() {
      const w = wiz, c = {}, p = profOf(device), bits = [];
      wiz = null;
      if (w.lo != null && w.hi != null) { c.keys = w.hi - w.lo + 1; bits.push(`${c.keys} keys`); }
      if (w.pads.length) {
        const n = w.pads.length, banked = p.padNotes && p.pads && n > p.pads && n % p.pads === 0; // a model with pad banks: the pads in rows of its bank
        c.padCh = w.padCh;
        c.pads = banked ? p.pads : n;
        c.padNotes = banked ? Array.from({ length: n / p.pads }, (_, i) => w.pads.slice(i * p.pads, (i + 1) * p.pads)) : [w.pads];
        bits.push(`${n} pads${banked ? " in " + n / p.pads + " banks" : ""}`);
      }
      if (w.ccs.length) { c.knobs = w.ccs.length; c.ccs = w.ccs; c.cc0 = 0; bits.push(`${w.ccs.length} knobs (CC ${w.ccs.join(", ")})`); }
      if (w.sus != null) { c.sus = w.sus; bits.push("sustain CC " + w.sus); }
      if (w.modKey) { c.modKey = w.modKey; bits.push("mod key " + w.modKey); }
      const roles = stickRoles(w); // what the stick and the wheels sent: the bend, and which CC is the mod and which the expression
      if (w.bend != null) { c.bend = w.bend.ch; bits.push("bend"); }
      if (roles.mod != null) { c.mod = roles.mod; bits.push("mod CC " + roles.mod); }
      if (roles.expr != null) { c.expr = roles.expr; bits.push("expression CC " + roles.expr); }
      if (Object.keys(w.fn).length) { c.fn = w.fn; bits.push(Object.keys(w.fn).length + " function buttons"); }
      if (Object.keys(c).length) { hw[device] = { ...(hw[device] || {}), ...c }; persistHw(); }
      wizShow(); draw();
      hint(bits.length ? "Mapped: " + bits.join(", ") + ". EXPORT keeps it in a file." : "Nothing was mapped.");
    }
    // a function button as text: a note, a CC pressed, a realtime byte (start, continue, stop) or an MMC command
    function fnToken(d) {
      const st = d[0], cmd = st & 0xf0, ch = st & 15;
      if (st === 0xf0 && d[1] === 0x7f && d[3] === 6 && d.length > 4) return "mmc:" + d[4];
      if (st >= 0xfa && st <= 0xfc) return "rt:" + st;
      if (cmd === 0x90 && d[2] > 0) return "n" + ch + ":" + d[1];
      if (cmd === 0xb0 && d[2] > 0) return "c" + ch + ":" + d[1];
      return null;
    }
    function wizMsg(d) {
      const w = wiz, [st, a, b] = d, cmd = st & 0xf0, ch = st & 15, on = cmd === 0x90 && b > 0, cc = cmd === 0xb0;
      if (st === 0xf8 || st === 0xfe) return;
      // the rightmost key then the leftmost key ends a list (or skips a step)
      const finish = () => {
        if (!on || w.lo == null || w.hi == null || ch !== w.loCh) return false;
        w.last = [...w.last, a].slice(-2);
        return w.last[0] === w.hi && w.last[1] === w.lo;
      };
      const gestureKey = on && w.lo != null && ch === w.loCh && (a === w.hi || a === w.lo); // never a pad or a function
      if (w.step === "hello") { if (on || cc || cmd === 0xe0) { wizSay("Connection OK."); wizGo("lo"); } return; }
      if (w.step === "lo") { if (on) { w.lo = a; w.loCh = ch; wizGo("hi"); } return; }
      if (w.step === "hi") { if (!on) return; if (a === w.lo) return wizSay("That is the same key. Press the rightmost key."); w.hi = a; if (w.hi < w.lo) [w.lo, w.hi] = [w.hi, w.lo]; return wizGo("modkey"); }
      if (w.step === "modkey") {
        if (finish()) return wizNext();
        if (gestureKey) return wizSay("Not the leftmost or the rightmost key: pick another one, or the pedal.");
        if ((on && !(w.lo != null && ch === w.loCh && (a === w.lo || a === w.hi))) || (cc && b >= 64 && ![0, 32, 98, 99, 100, 101].includes(a))) { w.modKey = (cc ? "c" : "n") + ch + ":" + a; wizSay("MOD key: " + w.modKey); wizNext(); }
        return;
      }
      if (w.step === "pads") {
        if (!on) return;
        if (w.lo != null && ch === w.loCh) return finish() ? wizNext() : wizSay("That is a key. Press the pads (they must not send on the same channel as the keys).");
        if (w.padCh == null) w.padCh = ch;
        if (ch !== w.padCh) return;
        if (!w.pads.includes(a)) w.pads.push(a);
        return wizSay(`${w.pads.length} pads · last: note ${a}, channel ${ch + 1}`);
      }
      if (finish()) return wizNext();
      if (w.step === "knobs") {
        if (cc && !NOT_KNOB.has(a) && !w.ccs.includes(a) && w.ccs.length < 32) { w.ccs.push(a); wizSay(`${w.ccs.length} knobs · last: CC ${a}`); }
        return;
      }
      if (w.step === "sus") { if (cc && b >= 64 && ![0, 32, 98, 99, 100, 101].includes(a)) { w.sus = a; wizSay("Sustain: CC " + a); wizNext(); } return; }
      if (w.step === "stick") {
        if (cmd === 0xe0) { const v = a | (b << 7), k = w.bend || (w.bend = { ch, lo: v, hi: v }); k.lo = Math.min(k.lo, v); k.hi = Math.max(k.hi, v); }
        else if (cc && ![0, 32, 98, 99, 100, 101].includes(a) && !w.ccs.includes(a) && a !== w.sus && Object.keys(w.sk).length < 6) { const k = w.sk[a] || (w.sk[a] = { lo: b, hi: b }); k.lo = Math.min(k.lo, b); k.hi = Math.max(k.hi, b); }
        else return;
        const r = stickRoles(w);
        return wizSay([w.bend ? `bend ${w.bend.lo}–${w.bend.hi} of 0–16383` : "", ...Object.entries(w.sk).map(([n, k]) => `CC ${n}${+n === r.mod ? " (mod)" : +n === r.expr ? " (expression)" : ""} ${k.lo}–${k.hi}`)].filter(Boolean).join(" · "));
      }
      // the function buttons: not a gesture key, not a knob, not the sustain
      const tok = fnToken(d);
      if (!tok || gestureKey || tok === w.modKey || (cc && (w.ccs.includes(a) || a === w.sus || a in w.sk))) return;
      if (Object.values(w.fn).includes(tok)) return;
      if (w.step === "fn") { if (w.extra < 16) { w.fn["f" + ++w.extra] = tok; wizSay(`F${w.extra} = ${tok}`); } return; }
      w.fn[w.step] = tok; wizSay(`${STEP[w.step][0]} = ${tok}`); wizNext();
    }
    function sourceOptions() {
      if (!el) return;
      const sel = el.querySelector("#mdSource");
      sel.innerHTML = MI.names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      if (!MI.names.includes(device)) device = MI.names[0] || "";
      sel.value = device;
    }
    // a list as big buttons over the panel, in place of the browser's own dropdown (which is cramped on a phone)
    function listPick(sel) {
      if (el.querySelector(".mdList")) return;
      const box = document.createElement("div"); box.className = "mdList";
      const head = (t) => Object.assign(document.createElement("h3"), { textContent: t });
      const grid = () => Object.assign(document.createElement("div"), { className: "mdOpts" });
      const add = (g, o) => { const b = document.createElement("button"); b.textContent = o.textContent; if (o.value === sel.value) b.className = "on"; b.onclick = () => { sel.value = o.value; box.remove(); sel.dispatchEvent(new Event("change")); }; g.append(b); };
      const cancel = document.createElement("button"); cancel.textContent = "CANCEL"; cancel.onclick = () => box.remove();
      box.append(head((sel.closest("label")?.firstChild?.textContent || "Choose").trim().toUpperCase()));
      let loose = null;
      for (const n of sel.children) {
        if (n.tagName === "OPTGROUP") { loose = null; const g = grid(); for (const o of n.children) add(g, o); box.append(head(n.label), g); }
        else { if (!loose) { loose = grid(); box.append(loose); } add(loose, n); }
      }
      box.append(cancel);
      el.querySelector(".mdCard").append(box);
    }
    function open(o) {
      if (!MI.names.length) return;
      if (el?.dataset.inline) el = null; // the inline view gives way to the full panel
      if (el) return o?.map && wizStart();
      device = MI.names[0];
      const style = document.createElement("style"); style.textContent = css; style.id = "mdStyle"; document.head.appendChild(style);
      el = document.createElement("div"); el.id = "mdPanel";
      el.innerHTML = `<div class="mdCard" role="dialog" aria-modal="true" aria-label="MIDI device diagram"><header><h2>MIDI DEVICE · LIVE DIAGRAM</h2><button data-do="close">DONE</button></header><div class="mdBody"><div class="mdSide"><div class="mdRow"><label>Input port<select id="mdSource"></select></label><label>Diagram<select id="mdProfile"></select></label></div><div class="mdRow"><button data-do="map" title="Step by step: the connection, the lowest and highest key, every pad, every knob, the sustain pedal, the bend, mod and transport buttons. The panel learns your device.">MAP DEVICE</button><button data-do="unmap" id="mdUnmap" title="Forget what MAP found and go back to the model's own">RESET MAP</button><button data-do="export" title="Save the device's map as a file (to keep it, to share it, to add the device to the Pocket apps)">EXPORT</button><button data-do="import" title="Read a device map from a file">IMPORT</button><button data-do="report" title="Copy a report of everything this device sent, to paste in an issue or a message">COPY REPORT</button><button data-do="lights" title="Send notes to the device: pads with lights light up if the device takes lights from the computer">LIGHT TEST</button><input type="file" id="mdFile" accept=".json,application/json" hidden></div><div id="mdWiz" hidden></div><div id="mdLive" aria-live="off"></div><div class="mdMap"><div class="mdRow"><strong id="mdSelected">Select a key, pad or knob</strong><button data-do="deselect" title="Close">✕</button><label>Pocket function<select id="mdAction"></select></label><button data-do="learn">LEARN FROM HARDWARE</button><button data-do="clear">CLEAR CONTROL</button><button data-do="defaults" id="mdDefaults" title="The functions the app gives the knobs and pads before you assign anything"></button></div><div class="mdHint" id="mdHint"></div><small>Choose a diagram control and a Pocket function, then press or turn its real counterpart. Assignments are saved for this input port and this Pocket app. Unassigned keys still play normally. Click a drawn key to preview it.</small><p><a id="mdSourceLink" target="_blank" rel="noopener noreferrer">Manufacturer reference ↗</a></p></div></div><div class="mdDevWrap"><small>A line sketch of the layout, not to scale. Pick the model that matches yours. Keys, pads and knobs light up as you use them; knobs are matched in the order of their CC numbers. LEARN pins a drawn control to the real one.</small><div class="mdDevice"></div></div></div></div>`;
      document.body.appendChild(el);
      sourceOptions();
      addEventListener("resize", fitPanel);
      fitPanel();
      el.querySelector("#mdSource").onchange = (e) => { device = e.target.value; learning = false; wiz = null; wizShow(); selected = ""; draw(); };
      el.querySelector("#mdProfile").onchange = (e) => { profile = e.target.value; record().profile = profile; persist(); selected = ""; draw(); };
      el.querySelector("#mdFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f && f.size < 100000) f.text().then(importHw).catch(() => hint("Could not read that file.")); };
      el.querySelector("#mdAction").onchange = () => { if (selected) setAssignment(selected, el.querySelector("#mdAction").value); };
      for (const id of ["#mdSource", "#mdProfile", "#mdAction"]) {
        const sl = el.querySelector(id);
        sl.addEventListener("mousedown", (e) => e.preventDefault());
        sl.addEventListener("click", (e) => { e.preventDefault(); if (!sl.disabled) listPick(sl); });
        sl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!sl.disabled) listPick(sl); } });
      }
      const pick = (control) => { select(control.dataset.control); if (control.dataset.control.startsWith("k")) preview(+control.dataset.control.slice(1)); };
      el.onclick = (e) => {
        const control = e.target.closest("[data-control]");
        if (control) return pick(control);
        const action = e.target.closest("[data-do]")?.dataset.do;
        if (action === "close") close();
        if (action === "deselect") select("");
        if (action === "map") wizStart();
        if (action === "wizNext") wizNext();
        if (action === "wizBack") wizBack();
        if (action === "wizCancel") { wiz = null; wizShow(); hint("Mapping cancelled."); }
        if (action === "unmap") { delete hw[device]; persistHw(); draw(); hint("Back to the model's own measures."); }
        if (action === "export") exportHw();
        if (action === "import") el.querySelector("#mdFile").click();
        if (action === "report") copyReport();
        if (action === "lights") lightTest();
        if (action === "learn" && selected) { learning = true; hint("Now press the matching hardware control on " + device + "."); }
        if (action === "clear" && selected) { clearAssignment(selected); hint("Assignment removed."); }
        if (action === "defaults") { const r = record(); r.defaults = r.defaults === false; persist(); drawDevice(); select(selected); }
      };
      el.onkeydown = (e) => {
        const control = (e.key === "Enter" || e.key === " ") && e.target.closest?.("[data-control]");
        if (control) { e.preventDefault(); pick(control); }
      };
      draw();
      if (o?.map) wizStart();
    }
    // an upright phone turns the card sideways; a window shorter than 560 px (a phone on its side too) puts the controls beside the diagram
    function fitPanel() {
      if (!el) return;
      const rot = innerWidth < 600 && innerHeight > innerWidth * 1.1, h = rot ? innerWidth : innerHeight;
      el.classList.toggle("rot", rot);
      el.style.setProperty("--mdH", h + "px");
      el.classList.toggle("cmp", h < 560);
      const card = el.querySelector(".mdCard");
      if (!el.classList.contains("cmp") && card.scrollHeight > card.clientHeight + 1) el.classList.add("cmp"); // too tall as one column: controls beside the diagram
    }
    function close() { learning = false; wiz = null; removeEventListener("resize", fitPanel); el?.remove(); el = null; document.getElementById("mdStyle")?.remove(); if (inl) embed(inl); }
    // the diagram alone, drawn into a box of the app's own page and lit as the device plays; null (or no device) takes it away
    let inl = null;
    function embed(box) {
      if (el && !el.dataset.inline) return inl = box || null; // the full panel is open: it comes back on close
      if (el) el = null;
      inl = box || null;
      if (!box || !MI.names.length) return box?.replaceChildren();
      if (!document.getElementById("mdEmbStyle")) { const st = document.createElement("style"); st.id = "mdEmbStyle"; st.textContent = css.replace(/#mdPanel /g, ".mdEmb "); document.head.appendChild(st); }
      if (!MI.names.includes(device)) device = MI.names[0];
      profile = record().profile || guess(device); base = prof().base;
      box.className = "mdEmb"; box.dataset.inline = "1"; box.innerHTML = '<div class="mdDevice"></div>';
      el = box;
      drawDevice();
    }
    function hint(text) { const h = el?.querySelector("#mdHint"); if (h) h.textContent = text; }
    function draw() {
      if (!el) return;
      profile = record().profile || guess(device);
      const p = prof(); base = p.base;
      const sel = el.querySelector("#mdProfile");
      sel.innerHTML = Object.entries(PROFILES).map(([id, x]) => `<option value="${id}">${esc(x.title)}</option>`).join(""); sel.value = profile;
      const link = el.querySelector("#mdSourceLink"); link.hidden = !p.source; link.href = p.source;
      drawDevice(); select("");
      hint("Listening to " + device + ". Press a key, a pad or turn a knob to see it light up.");
      fitPanel();
    }
    function drawDevice() {
      if (!el) return;
      const box = el.querySelector(".mdDevice");
      box.innerHTML = schematic(prof(), base);
      if (!el.dataset.inline) tags(box.querySelector("svg")); // the inline view has no room for the tags
      const um = el.querySelector("#mdUnmap"); if (um) um.hidden = !hw[device];
      const b = el.querySelector("#mdDefaults");
      if (b) b.textContent = "DEFAULTS " + (record().defaults === false ? "OFF" : "ON");
    }
    function select(id) {
      selected = id; if (!el) return;
      el.classList.toggle("sel", !!id);
      el.querySelectorAll(".chosen").forEach((x) => x.classList.remove("chosen"));
      el.querySelector(`[data-control="${id}"]`)?.classList.add("chosen");
      const CTL = { j: "Joystick", xy: "X-Y pad", "o-": "Octave −", "o+": "Octave +", "b-": "Pitch −", "b+": "Pitch +", m: "Mod", s: "Sustain" };
      el.querySelector("#mdSelected").textContent = id ? (CTL[id] || (id[0] === "k" ? noteName(+id.slice(1)) : id[0] === "p" ? `Pad ${+id.slice(1) + 1}` : `Knob ${+id.slice(1) + 1}`)) : "Select a key, pad or knob";
      const actions = MI.actions(), groups = [...new Set(actions.map((a) => a.group))];
      const action = el.querySelector("#mdAction");
      action.innerHTML = `<option value="">Unassigned · normal key</option>` + groups.map((gr) => `<optgroup label="${esc(gr)}">${actions.filter((a) => a.group === gr).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</optgroup>`).join("");
      action.value = id ? (effective(device, prof(), id)?.[0] || "") : "";
      action.disabled = !id;
      const binding = id && record().controls[id]?.key;
      hint(binding ? `Hardware: ${binding} · ${action.value ? "assigned" : "normal"}` : id ? "Choose a function and press LEARN to bind the real control." : "Select a drawn control to assign it.");
    }
    function setAssignment(id, action) {
      const r = record(), c = r.controls[id] || (r.controls[id] = {});
      c.action = action;
      if (c.key) { if (action) r.map[c.key] = action; else delete r.map[c.key]; }
      persist(); select(id);
    }
    function clearAssignment(id) {
      const r = record(), c = r.controls[id];
      if (c?.key) delete r.map[c.key];
      delete r.controls[id]; persist(); select(id);
    }
    function preview(n) {
      send([0x90, n, 90], device);
      setTimeout(() => send([0x80, n, 0], device), 170);
    }
    const lit = (id, on) => el?.querySelector(`[data-control="${id}"]`)?.classList.toggle("lit", on);
    const blink = (id) => { lit(id, true); clearTimeout(flash.get(id)); flash.set(id, setTimeout(() => lit(id, false), 180)); };
    // the controls that are neither keys, pads nor knobs: [control, text] for a message, or null
    function special(p, cmd, cc, a, b, bound) {
      if (bound) return null;
      if (p.shape === "mpk" && (cmd === 0xe0 || (cc && (a === (p.mod ?? 1) || a === p.expr)))) return ["j", cmd === 0xe0 ? "Joystick · pitch bend" : a === p.expr ? `Joystick · expression (CC ${a}) = ${b}` : `Joystick · mod (CC ${a}) = ${b}`];
      if (p.shape === "pads" && cc) return ["xy", `X-Y pad · CC ${a} = ${b}`];
      if (p.shape === "nkey") {
        if (cmd === 0xe0) return [b >= 64 ? "b+" : "b-", "Pitch bend button"];
        if (cc && a === 1) return ["m", `Mod button · CC 1 = ${b}`];
        if (cc && a === 64) return ["s", `Sustain button · CC 64 = ${b}`];
      }
      return null;
    }
    // The Play mk3 sends one of two layouts depending on its program (FAVORITE + pad 5 = the standard one). A message that only one layout has says which one it is.
    const GB_NOTES = new Set([37, 39, 40, 41, 43, 44, 47, 50]), INT_NOTES = new Set([60, 62, 63, 64, 58, 75, 56, 77]);
    function sniffLayout(from, d) {
      if (guess(from) !== "akai") return;
      const st = d[0], a = d[1], cmd = st & 0xf0;
      const l = cmd === 0xb0 ? ([70, 75, 76, 77].includes(a) ? "akaigb" : [91, 93, 6].includes(a) ? "akai" : "") : cmd === 0x90 && (st & 15) === 9 && d[2] > 0 ? (GB_NOTES.has(a) ? "akaigb" : INT_NOTES.has(a) ? "akai" : "") : "";
      if (!l) return;
      const r = (saved[from] = saved[from] || { profile: guess(from), map: {}, controls: {} });
      if (r.profile !== l && (r.profile === "akai" || r.profile === "akaigb")) {
        r.profile = l; persist();
        if (el && from === device) { draw(); hint(`This MPK is sending its ${l === "akai" ? "internal-sounds" : "standard"} layout.`); }
      }
      if (l === "akai" && !hw[from]) layoutTip();
    }
    // a dialog, once: how to get the standard layout (the apps work with the internal one too, but its knobs are fewer and shared)
    function layoutTip() {
      let seen = ""; try { seen = sessionStorage.getItem("pocket.midi.tip") || localStorage.getItem("pocket.midi.tip.off") || ""; } catch {}
      if (seen || typeof document === "undefined" || document.getElementById("mdTip")) return;
      try { sessionStorage.setItem("pocket.midi.tip", "1"); } catch {}
      const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]'), app = ((meta && meta.content) || "").slice(0, 4).toLowerCase();
      let l = ""; try { l = localStorage.getItem(app + (document.title.startsWith("TEST") ? "-test" : "") + ".lang") || ""; } catch {}
      const es = (l || navigator.language || "en").toLowerCase().startsWith("es");
      const T = es
        ? ["Tu MPK mini Play usa su disposición de sonidos internos", "Esta disposición tiene menos potes separados y otras notas en los pads. Para la disposición estándar (8 potes y 16 pads): mantén FAVORITE y pulsa el pad 5. La pantalla dirá «FAV: Garageband».", "ENTENDIDO", "NO MOSTRAR MÁS"]
        : ["Your MPK mini Play is on its internal-sounds layout", "This layout has fewer separate knobs and other notes on the pads. For the standard layout (8 knobs and 16 pads): hold FAVORITE and press pad 5. The screen will read FAV: Garageband.", "GOT IT", "DON'T SHOW AGAIN"];
      const box = document.createElement("div");
      box.id = "mdTip"; box.setAttribute("role", "alertdialog");
      box.style.cssText = "position:fixed;inset:0;z-index:9050;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:12px";
      box.innerHTML = '<div style="width:min(100%,460px);display:flex;flex-direction:column;gap:10px;padding:16px;background:var(--panel,#161a20);color:var(--text,#e8ecf1);border:2px solid var(--hot,#ffbf52);border-radius:var(--r,10px);font:14px/1.4 system-ui,sans-serif"><h3 style="margin:0;font-size:16px;color:var(--hot,#ffbf52)"></h3><p style="margin:0"></p><div style="display:flex;gap:8px"><button type="button" data-t="ok" style="flex:1;min-height:48px;font-weight:800"></button><button type="button" data-t="off" style="flex:1;min-height:48px;font-weight:800"></button></div></div>';
      box.querySelector("h3").textContent = T[0]; box.querySelector("p").textContent = T[1];
      box.querySelector('[data-t="ok"]').textContent = T[2]; box.querySelector('[data-t="off"]').textContent = T[3];
      box.onclick = (e) => {
        const t = e.target.closest("[data-t]")?.dataset.t;
        if (t === "off") { try { localStorage.setItem("pocket.midi.tip.off", "1"); } catch {} }
        if (t || e.target === box) box.remove();
      };
      document.body.appendChild(box);
    }
    // the mod key: a note (down and up) or a CC (64 and up is down). The key itself still does its normal job.
    function modTrack(from, d) {
      const st = d[0], cmd = st & 0xf0;
      if (cmd !== 0x90 && cmd !== 0x80 && cmd !== 0xb0) return;
      const mk = profOf(from).modKey, tok = (cmd === 0xb0 ? "c" : "n") + (st & 15) + ":" + d[1], down = cmd === 0xb0 ? d[2] >= 64 : cmd === 0x90 && d[2] > 0;
      if (!modPedalOn()) { layer[from] = false; return; }
      if ((mk ? tok === mk : cmd === 0xb0 && d[1] === 64) && !!layer[from] !== down) { layer[from] = down; if (el && from === device) hint(down ? "MOD held: the pads and knobs are the second set." : "MOD released."); }
    }
    function observe(data, from) {
      const [st, a, b] = data, cmd = st & 0xf0;
      if (from) { tally(data, from); modTrack(from, data); if (!(wiz && el && from === device)) sniffLayout(from, data); }
      if (wiz && el && from === device) { wizMsg(data); return true; } // MAP is listening: the app must not react
      if (st >= 0xf0 || !from) return;
      const noteOn = cmd === 0x90 && b > 0, noteOff = cmd === 0x80 || (cmd === 0x90 && b === 0), cc = cmd === 0xb0;
      const key = (cc ? "c" : "n") + (st & 15) + ":" + a;
      if (learning && el && from === device && (noteOn || cc && b > 0)) {
        const r = record(), c = r.controls[selected] || (r.controls[selected] = {});
        if (c.key) delete r.map[c.key];
        for (const [id, other] of Object.entries(r.controls)) if (id !== selected && other.key === key) delete other.key;
        delete r.map[key];
        c.key = key; if (c.action) r.map[key] = c.action;
        persist(); learning = false; select(selected);
      }
      if (cc) (seenCC[from] = seenCC[from] || new Set()).add(a);
      if (!el || from !== device) return;
      const p = prof(), bound = Object.entries(record().controls).find(([, v]) => v.key === key)?.[0];
      if (noteOn || noteOff) {
        // a learned pad, else any note on channel 10 is a pad; everything else is a key
        const id = bound && !bound.startsWith("k") ? bound : !bound && (st & 15) === (p.padCh ?? 9) && p.pads ? "p" + padIndex(p.pads, a, p.padNotes) : "";
        if (id) {
          lit(id, noteOn);
          if (noteOn) hint(`Pad ${+id.slice(1) + 1} · note ${a} · channel ${(st & 15) + 1}`);
          return;
        }
        if (!p.keys) return;
        if (a < base || a >= base + p.keys) { base = Math.max(0, Math.min(127 - p.keys, Math.floor(a / 12) * 12)); drawDevice(); }
        lit("k" + a, noteOn);
      } else if (special(p, cmd, cc, a, b, bound)) {
        const [id, text] = special(p, cmd, cc, a, b, bound);
        blink(id);
        hint(text);
      } else if (cc) {
        const r = bound && !bound.startsWith("k") ? bound : knobRank(seenCC[from], a, p.cc0, p.ccs, p.fold);
        const id = typeof r === "string" ? r : r >= 0 && r < p.knobs ? "c" + r : "";
        if (id) { blink(id); hint(id === "j" ? `Joystick · CC ${a} = ${b}` : `Knob ${+id.slice(1) + 1} · CC ${a} = ${b}`); }
      }
    }
    function route(from, key, cc, on, value) {
      const id = saved[from]?.map?.[key], action = id && MI.actions().find((a) => a.id === id);
      if (!action) return false;
      run(action, from + "/" + key, cc, on, value);
      return true;
    }
    // is this note-on from one of the controller's pads (its pad channel) and not from a key?
    const isPad = (from, ch) => { const p = profOf(from); return !!p.pads && ch === (p.padCh ?? 9); };
    // the number (from 0) of the pad that sent this note: a drum-kit controller like the MPK Play mk3 does not number its pads from 36
    const padNo = (from, n) => { const p = profOf(from); return padIndex(p.pads || 8, n, p.padNotes) + (layer[from] ? p.pads || 8 : 0); };
    // susCc: the CC of this device's sustain (64 unless MAP found another)
    const susCc = (from) => profOf(from).sus ?? 64;
    // the MOD switch (MIDI options): on by default; off, and the pads and knobs stay the first set
    const modPedal = (on) => { if (on !== undefined) { try { localStorage.setItem(MODP, on ? "1" : "0"); } catch {} for (const k in layer) layer[k] = false; } return modPedalOn(); };
    // is this control ("c0:64", "n0:60") the mod key of this device?
    const isMod = (from, tok) => { const mk = profOf(from).modKey; return modPedalOn() && (mk ? tok === mk : /^c\d+:64$/.test(tok)); };
    return { open, close, embed, observe, route, fallback, padList, lightsOf: (from) => profOf(from).lights, defaultsOff, isPad, padNo, susCc, modPedal, layerOf: (from) => !!layer[from], isMod };
  }
  window.createMidiPanel = createMidiPanel;
  window.pocketMidiHelpers = { padIndex, knobRank, guess, vetHw };
})();
    