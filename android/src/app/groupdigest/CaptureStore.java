package app.groupdigest;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Captured messages wait in a file in the app's private storage until the web app
 * picks them up and stores them with the rest of the chat. Shared by the
 * notification listener and the activity, which run in the same process.
 */
final class CaptureStore {
    private static final Object LOCK = new Object();
    private static final String PREFS = "capture";
    private static final String FILE = "captured.jsonl";
    private static final int MAX_KEYS = 2000;
    private static final Set<String> recent = new LinkedHashSet<String>();

    private CaptureStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** "Parents 3B (5 messages)" -> "Parents 3B" */
    static String cleanGroupName(String s) {
        return s.replaceAll("\\s*\\(\\d+\\s+\\S+\\)$", "").replaceAll("[\\u200e\\u200f\\u202a-\\u202e]", "").trim();
    }

    static boolean isEnabled(Context c) {
        String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        String me = new ComponentName(c, CaptureService.class).flattenToString();
        return flat != null && flat.contains(me);
    }

    static void noteGroup(Context c, String group) {
        synchronized (LOCK) {
            Set<String> seen = new HashSet<String>(prefs(c).getStringSet("seen", new HashSet<String>()));
            if (seen.add(group)) prefs(c).edit().putStringSet("seen", seen).apply();
        }
    }

    static boolean isSelected(Context c, String group) {
        return prefs(c).getStringSet("selected", new HashSet<String>()).contains(group);
    }

    static void setSelected(Context c, JSONArray names) {
        Set<String> sel = new HashSet<String>();
        for (int i = 0; i < names.length(); i++) sel.add(names.optString(i));
        prefs(c).edit().putStringSet("selected", sel).apply();
    }

    static String status(Context c) {
        try {
            JSONObject o = new JSONObject();
            o.put("enabled", isEnabled(c));
            o.put("seen", new JSONArray(prefs(c).getStringSet("seen", new HashSet<String>())));
            o.put("selected", new JSONArray(prefs(c).getStringSet("selected", new HashSet<String>())));
            File f = new File(c.getFilesDir(), FILE);
            o.put("pendingBytes", f.exists() ? f.length() : 0);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    static void add(Context c, String group, long time, String sender, String text) {
        // WhatsApp re-posts the last few messages with every update, so skip repeats.
        String key = group + "|" + time + "|" + sender + "|" + text;
        synchronized (LOCK) {
            if (recent.contains(key)) return;
            recent.add(key);
            if (recent.size() > MAX_KEYS) {
                String first = recent.iterator().next();
                recent.remove(first);
            }
            try {
                JSONObject o = new JSONObject();
                o.put("chat", group);
                o.put("ts", time);
                o.put("sender", sender == null ? JSONObject.NULL : sender);
                o.put("text", text);
                FileOutputStream out = new FileOutputStream(new File(c.getFilesDir(), FILE), true);
                out.write((o.toString() + "\n").getBytes("UTF-8"));
                out.close();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Hand waiting messages to the web app. They move to an in-flight file and are
     * only deleted by ack(), after the web app has stored them, so nothing is lost
     * if the app closes in between.
     */
    static String peek(Context c) {
        synchronized (LOCK) {
            File main = new File(c.getFilesDir(), FILE);
            File inflight = new File(c.getFilesDir(), FILE + ".inflight");
            if (!inflight.exists() && main.exists()) main.renameTo(inflight);
            JSONArray arr = new JSONArray();
            if (!inflight.exists()) return "[]";
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(inflight), "UTF-8"));
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    try {
                        arr.put(new JSONObject(line));
                    } catch (Exception ignored) {
                    }
                }
                r.close();
            } catch (Exception e) {
                return "[]";
            }
            return arr.toString();
        }
    }

    static void ack(Context c) {
        synchronized (LOCK) {
            new File(c.getFilesDir(), FILE + ".inflight").delete();
        }
    }
}
