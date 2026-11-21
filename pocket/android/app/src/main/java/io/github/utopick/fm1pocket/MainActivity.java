package io.github.utopick.fm1pocket;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.util.Locale;

/**
 * The FM1.Pocket page in a WebView; the emulator and the sound are native (Native, AudioThread). While a firmware runs,
 * the play screen is native too (FaceView): MENU (or back) shows the page, back shows the play screen again.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private WebView web;
    private AudioThread audio;
    private FaceView face;
    private boolean running; // a firmware is on (the page booted one and has not turned it off)
    /** The native play screen (FaceView) while a firmware runs. Off: with it, 386DX lagged on a Galaxy S23 where the page alone keeps up at 240 MHz. */
    private static final boolean FACE = false;

    /** window.FM1Native: the page's way to the native core. Its methods run on a WebView binder thread. */
    private final class Bridge {
        @JavascriptInterface public void post(String json) {
            Native.post(json);
            if (json.contains("\"cancel-boot\"")) runOnUiThread(() -> { running = false; setAwake(false); showFace(false); }); // the page's power off
        }
        @JavascriptInterface public void boot(String json, String packageB64, String sectorsB64, String syxB64) {
            // core 1 on its own thread (used once the firmware releases core 1; 386DX and Bubba Machine do): on unless switched off
            int threads = getSharedPreferences("fm1", MODE_PRIVATE).getInt("threads", 2);
            if (threads > 1 && !json.contains("\"threads\"") && json.startsWith("{")) json = "{\"threads\":" + threads + "," + json.substring(1);
            Native.boot(json, decode(packageB64), decode(sectorsB64), decode(syxB64));
            startAudio();
            runOnUiThread(() -> { running = true; setAwake(true); showFace(true); });
        }
        /** Hidden switch (from the page's console: FM1Native.threads(1)): 1 runs both FM-1 cores on one thread, 2 (the default) gives core 1 its own. Takes effect at the next boot. */
        @JavascriptInterface public void threads(int n) { getSharedPreferences("fm1", MODE_PRIVATE).edit().putInt("threads", n > 1 ? 2 : 1).apply(); }
        @JavascriptInterface public String version() { return Native.version(); }
        /** The page has something to say or ask (a lower clock, an error): show it over the native play screen. */
        @JavascriptInterface public void page() { runOnUiThread(() -> showFace(false)); }
    }

    private static byte[] decode(String b64) { return b64 == null || b64.isEmpty() ? null : Base64.decode(b64, Base64.DEFAULT); }

    private synchronized void startAudio() {
        if (audio != null) return;
        audio = new AudioThread(this);
        audio.start();
    }

    private void setAwake(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** The native play screen or the page. The page polls the core slowly while it is hidden (it still keeps the saves). */
    private void showFace(boolean show) {
        show &= FACE;
        if (show == (face.getVisibility() == View.VISIBLE)) return;
        face.setVisibility(show ? View.VISIBLE : View.GONE);
        web.setVisibility(show ? View.GONE : View.VISIBLE);
        web.evaluateJavascript("window.nativeSlow && nativeSlow(" + show + ")", null);
    }

    private boolean hinted;
    private void menu() {
        showFace(false);
        if (hinted) return;
        hinted = true;
        boolean es = "es".equals(Locale.getDefault().getLanguage());
        Toast.makeText(this, es ? "Atrás vuelve a la pantalla rápida del FM-1" : "Back returns to the FM-1's fast screen", Toast.LENGTH_LONG).show();
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        face = new FaceView(this, this::menu);
        face.setVisibility(View.GONE);
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(face);
        setContentView(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // IndexedDB comes with it
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost()) && "/native/poll".equals(u.getPath())) {
                    return new WebResourceResponse("application/octet-stream", null, new ByteArrayInputStream(Native.poll()));
                }
                return loader.shouldInterceptRequest(u);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Web MIDI with SysEx (the real FM-1: Tether, backups, installing): a WebView refuses it unless the app grants it.
            // Only that, and only to the app's own page.
            @Override public void onPermissionRequest(PermissionRequest r) {
                boolean ours = HOST.equals(r.getOrigin().getHost());
                for (String res : r.getResources()) {
                    if (!ours || !PermissionRequest.RESOURCE_MIDI_SYSEX.equals(res)) { r.deny(); return; }
                }
                r.grant(new String[] {PermissionRequest.RESOURCE_MIDI_SYSEX});
            }
        });
        web.addJavascriptInterface(new Bridge(), "FM1Native");
        web.loadUrl("https://" + HOST + "/assets/index.html");
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override protected void onPause() { super.onPause(); if (audio != null) audio.setPaused(true); }
    @Override protected void onResume() { super.onResume(); if (audio != null) audio.setPaused(false); }
    @Override protected void onDestroy() {
        if (audio != null) audio.finish();
        web.destroy();
        super.onDestroy();
    }
    @Override public void onBackPressed() {
        if (face.getVisibility() == View.VISIBLE) menu();
        else if (FACE && running) showFace(true);
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
