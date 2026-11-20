package app.groupdigest;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.os.Parcelable;
import android.provider.CalendarContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the Group Digest web app in a WebView. The bundled files in assets/www are
 * served from https://appassets.androidplatform.net (a domain reserved for this),
 * so the page gets a normal secure origin: IndexedDB, crypto and CORS calls to the
 * AI providers all work as they do in a browser.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingShare = null;
    private boolean pageReady = false;

    private static final Map<String, String> MIME = new HashMap<String, String>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("ico", "image/x-icon");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("wasm", "application/wasm");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        boolean night = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int bar = Color.parseColor(night ? "#171329" : "#EEF7F3");
        w.setStatusBarColor(bar);
        w.setNavigationBarColor(bar);
        if (!night) {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (android.os.Build.VERSION.SDK_INT >= 26) flags |= 0x00000010; // SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            w.getDecorView().setSystemUiVisibility(flags);
        }

        web = new WebView(this);
        web.setBackgroundColor(bar);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE); // local Ollama over http
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return serveAsset(u.getPath());
            }

            @Override
            @SuppressWarnings("deprecation") // still called on every Android version
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                String scheme = Uri.parse(url).getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false; // sign-in pages stay in the app
                openExternal(url);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = url != null && url.contains(HOST);
                if (pageReady && pendingShare != null) notifyShare();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"text/plain", "application/zip", "application/x-zip-compressed", "application/octet-stream"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose a WhatsApp export"), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        setContentView(web);
        handleIntent(getIntent());
        web.loadUrl(START_URL);
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        String file = "www" + path;
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-cache");
        try {
            InputStream in = getAssets().open(file);
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, in);
        } catch (IOException e) {
            // Unknown paths (for example the OpenRouter sign-in callback "/") get the app.
            try {
                InputStream in = getAssets().open("www/index.html");
                return new WebResourceResponse("text/html", "UTF-8", 200, "OK", headers, in);
            } catch (IOException e2) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers, null);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) web.evaluateJavascript("window.dispatchEvent(new Event('groupdigest-resume'))", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** WhatsApp > Export chat > Group Digest arrives here as ACTION_SEND. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri stream = null;
        if (Intent.ACTION_SEND.equals(action)) {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) stream = (Uri) p;
            if (stream == null) {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text != null && text.length() > 0) {
                    setPending("shared.txt", "text/plain", text.toString().getBytes());
                    return;
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) {
                // An export with media: pick the chat text (or zip) and ignore the photos.
                for (Parcelable p : list) {
                    if (!(p instanceof Uri)) continue;
                    String name = displayName((Uri) p).toLowerCase();
                    if (name.endsWith(".txt") || name.endsWith(".zip")) { stream = (Uri) p; break; }
                }
            }
        } else if (Intent.ACTION_VIEW.equals(action)) {
            stream = intent.getData();
        }
        if (stream == null) return;
        try {
            ContentResolver cr = getContentResolver();
            InputStream in = cr.openInputStream(stream);
            if (in == null) return;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            String mime = cr.getType(stream);
            setPending(displayName(stream), mime == null ? "" : mime, out.toByteArray());
        } catch (Exception e) {
            Toast.makeText(this, "Could not read the shared file", Toast.LENGTH_LONG).show();
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        try {
            Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null) {
                if (c.moveToFirst()) name = c.getString(0);
                c.close();
            }
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "shared.txt" : name;
    }

    private void setPending(String name, String mime, byte[] bytes) {
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("mime", mime);
            o.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            pendingShare = o.toString();
        } catch (Exception e) {
            pendingShare = null;
        }
        if (pageReady) notifyShare();
    }

    private void notifyShare() {
        web.evaluateJavascript("window.dispatchEvent(new Event('groupdigest-share'))", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE || fileCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    /** Methods the web app calls as window.AndroidBridge.*. They run on a background thread. */
    class Bridge {
        @JavascriptInterface
        public String takePendingShare() {
            String s = pendingShare;
            pendingShare = null;
            return s == null ? "" : s;
        }

        @JavascriptInterface
        public void addToCalendar(final String title, final double begin, final double end, final boolean allDay, final String location, final String description) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, (long) begin)
                            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, (long) end)
                            .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
                            .putExtra(CalendarContract.Events.TITLE, title)
                            .putExtra(CalendarContract.Events.EVENT_LOCATION, location)
                            .putExtra(CalendarContract.Events.DESCRIPTION, description);
                    try {
                        startActivity(i);
                    } catch (ActivityNotFoundException e) {
                        Toast.makeText(MainActivity.this, "No calendar app found", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void shareText(final String text) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "Share summary"));
                }
            });
        }

        @JavascriptInterface
        public void shareFile(final String name, final String mime, final String content) {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        File dir = new File(getCacheDir(), "share");
                        dir.mkdirs();
                        String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                        File f = new File(dir, safe);
                        FileOutputStream out = new FileOutputStream(f);
                        out.write(content.getBytes("UTF-8"));
                        out.close();
                        Uri uri = Uri.parse("content://" + FilesProvider.AUTHORITY + "/" + safe);
                        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        Intent chooser = Intent.createChooser(send, "Add events with");
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {view});
                        startActivity(chooser);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Could not export events", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public String captureStatus() {
            // The lite build has no listener in its manifest: report capture as unavailable.
            try {
                getPackageManager().getServiceInfo(new android.content.ComponentName(MainActivity.this, CaptureService.class), 0);
            } catch (Exception e) {
                return "";
            }
            return CaptureStore.status(MainActivity.this);
        }

        @JavascriptInterface
        public void setCaptureGroups(String json) {
            try {
                CaptureStore.setSelected(MainActivity.this, new org.json.JSONArray(json));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String peekCaptured() {
            return CaptureStore.peek(MainActivity.this);
        }

        @JavascriptInterface
        public void ackCaptured() {
            CaptureStore.ack(MainActivity.this);
        }

        @JavascriptInterface
        public void openCaptureSettings() {
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));
                    } catch (ActivityNotFoundException e) {
                        openAppInfo();
                    }
                }
            });
        }

        /** Android 13+ blocks notification access for sideloaded apps until "Allow restricted settings" is tapped here. */
        @JavascriptInterface
        public void openAppInfo() {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                }
            });
        }

        @JavascriptInterface
        public void scheduleReminders(String json) {
            ReminderReceiver.addAll(MainActivity.this, json);
        }

        @JavascriptInterface
        public void cancelReminders(String idPrefix) {
            ReminderReceiver.cancelPrefix(MainActivity.this, idPrefix);
        }

        @JavascriptInterface
        public void setNoticeWatch(String json) {
            NoticeReceiver.watch(MainActivity.this, json);
        }

        @JavascriptInterface
        public String reminderIds() {
            return ReminderReceiver.futureIds(MainActivity.this);
        }

        @JavascriptInterface
        public boolean notificationsAllowed() {
            if (android.os.Build.VERSION.SDK_INT < 33) return true;
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void askNotificationPermission() {
            if (android.os.Build.VERSION.SDK_INT < 33) return;
            runOnUiThread(new Runnable() {
                public void run() {
                    requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 33);
                }
            });
        }

        @JavascriptInterface
        public int androidVersion() {
            return android.os.Build.VERSION.SDK_INT;
        }

        @JavascriptInterface
        public void openExternal(final String url) {
            runOnUiThread(new Runnable() {
                public void run() {
                    MainActivity.this.openExternal(url);
                }
            });
        }
    }
}
