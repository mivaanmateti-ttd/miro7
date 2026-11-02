package app.miro;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

public class ProfilesActivity extends Activity {
    WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.addJavascriptInterface(new Store(), "MiroProfiles");
        web.loadUrl("file:///android_asset/profiles.html");
    }

    class Store {
        @JavascriptInterface
        public String load() {
            return getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).getString("profiles", "[]");
        }

        @JavascriptInterface
        public void save(String json) {
            SharedPreferences.Editor e = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit();
            e.putString("profiles", json).apply();
        }

        @JavascriptInterface
        public void close() {
            runOnUiThread(() -> finish());
        }
    }

    @Override
    public void onBackPressed() {
        finish();
    }
}
