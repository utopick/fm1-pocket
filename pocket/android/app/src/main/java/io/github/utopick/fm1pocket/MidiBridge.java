package io.github.utopick.fm1pocket;

import android.content.Context;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * window.FM1Midi: Android's MIDI service for the page, which a WebView gives no Web MIDI. The page's
 * stand-in for navigator.requestMIDIAccess (pocket/src/app.html, "Web MIDI in the Android app") lists
 * the ports, sends bytes and gets what the devices send through window.__fm1MidiIn. SysEx passes as is.
 * Port ids are "<device id>:<i|o>:<port number>"; a Web MIDI input is a device's output port.
 */
final class MidiBridge {
    private final WebView web;
    private final MidiManager mm;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, MidiDevice> open = new HashMap<>(); // device id -> the device, once opened
    private final Map<String, MidiInputPort> sinks = new HashMap<>(); // a Web MIDI output id -> where its bytes go
    private final Map<String, List<byte[]>> waiting = new HashMap<>(); // bytes sent before the port was open
    private boolean started;

    MidiBridge(Context c, WebView web) {
        this.web = web;
        this.mm = c.getPackageManager().hasSystemFeature("android.software.midi") ? (MidiManager) c.getSystemService(Context.MIDI_SERVICE) : null;
    }

    private void js(String code) { main.post(() -> web.evaluateJavascript(code, null)); }

    private static String name(MidiDeviceInfo d, MidiDeviceInfo.PortInfo p, int ports) {
        Bundle b = d.getProperties();
        String n = b.getString(MidiDeviceInfo.PROPERTY_NAME);
        if (n == null || n.isEmpty()) n = b.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "MIDI device");
        String pn = p.getName();
        // as a computer names them: the device, then the port's own name, or its number when it has several
        if (pn != null && !pn.isEmpty() && !n.contains(pn)) return n + " " + pn;
        return ports > 1 ? n + " " + (p.getPortNumber() + 1) : n;
    }

    /** The ports now, as JSON: [{id, name, manufacturer, type: "input" | "output"}]. */
    @JavascriptInterface public synchronized String list() {
        JSONArray a = new JSONArray();
        if (mm == null) return a.toString();
        try {
            for (MidiDeviceInfo d : mm.getDevices()) {
                if (d.getType() == MidiDeviceInfo.TYPE_BLUETOOTH && !open.containsKey(d.getId())) continue; // needs pairing first, not handled
                int ins = d.getOutputPortCount(), outs = d.getInputPortCount();
                for (MidiDeviceInfo.PortInfo p : d.getPorts()) {
                    boolean in = p.getType() == MidiDeviceInfo.PortInfo.TYPE_OUTPUT;
                    a.put(new JSONObject().put("id", d.getId() + (in ? ":i:" : ":o:") + p.getPortNumber())
                        .put("name", name(d, p, in ? ins : outs))
                        .put("manufacturer", d.getProperties().getString(MidiDeviceInfo.PROPERTY_MANUFACTURER, ""))
                        .put("type", in ? "input" : "output"));
                }
            }
        } catch (Exception ignored) { }
        return a.toString();
    }

    /** Opens every device (and each one plugged in later) and tells the page when the list changes. */
    @JavascriptInterface public synchronized void start() {
        if (mm == null || started) return;
        started = true;
        mm.registerDeviceCallback(new MidiManager.DeviceCallback() {
            @Override public void onDeviceAdded(MidiDeviceInfo d) { openDevice(d); js("window.__fm1MidiChanged && __fm1MidiChanged()"); }
            @Override public void onDeviceRemoved(MidiDeviceInfo d) { closeDevice(d.getId()); js("window.__fm1MidiChanged && __fm1MidiChanged()"); }
        }, main);
        for (MidiDeviceInfo d : mm.getDevices()) openDevice(d);
    }

    private void openDevice(MidiDeviceInfo d) {
        if (d.getType() == MidiDeviceInfo.TYPE_BLUETOOTH) return;
        mm.openDevice(d, dev -> {
            if (dev == null) return;
            synchronized (this) {
                open.put(d.getId(), dev);
                for (MidiDeviceInfo.PortInfo p : d.getPorts()) {
                    int n = p.getPortNumber();
                    if (p.getType() == MidiDeviceInfo.PortInfo.TYPE_OUTPUT) {
                        MidiOutputPort o = dev.openOutputPort(n);
                        if (o == null) continue;
                        String id = d.getId() + ":i:" + n;
                        o.connect(new MidiReceiver() {
                            @Override public void onSend(byte[] msg, int off, int count, long ts) {
                                js("window.__fm1MidiIn && __fm1MidiIn('" + id + "','" + Base64.encodeToString(msg, off, count, Base64.NO_WRAP) + "')");
                            }
                        });
                    } else {
                        MidiInputPort i = dev.openInputPort(n);
                        if (i == null) continue;
                        String id = d.getId() + ":o:" + n;
                        sinks.put(id, i);
                        List<byte[]> w = waiting.remove(id);
                        if (w != null) for (byte[] b : w) try { i.send(b, 0, b.length); } catch (IOException ignored) { }
                    }
                }
            }
        }, main);
    }

    private synchronized void closeDevice(int id) {
        MidiDevice dev = open.remove(id);
        sinks.keySet().removeIf(k -> k.startsWith(id + ":"));
        waiting.keySet().removeIf(k -> k.startsWith(id + ":"));
        if (dev != null) try { dev.close(); } catch (IOException ignored) { }
    }

    /** Bytes to an output (base64: a SysEx can be long). Sent once the port is open if it is not yet. */
    @JavascriptInterface public synchronized void send(String id, String b64) {
        byte[] b = Base64.decode(b64, Base64.DEFAULT);
        MidiInputPort i = sinks.get(id);
        if (i == null) { // opening, or gone: keep a little, as a port that never opens must not hold everything
            List<byte[]> w = waiting.computeIfAbsent(id, k -> new ArrayList<>());
            if (w.size() < 256) w.add(b);
            return;
        }
        try { i.send(b, 0, b.length); } catch (IOException ignored) { }
    }

    synchronized void close() {
        for (Integer id : new ArrayList<>(open.keySet())) closeDevice(id);
    }
}
