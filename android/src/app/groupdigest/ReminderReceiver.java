package app.groupdigest;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Event reminders as phone notifications. Reminders are kept in
 * SharedPreferences and scheduled with AlarmManager; they are scheduled again
 * after the phone restarts, because Android forgets alarms on reboot.
 */
public class ReminderReceiver extends BroadcastReceiver {
    static final String ACTION = "app.groupdigest.REMIND";
    private static final String PREFS = "reminders";
    private static final String KEY = "list";
    private static final String CHANNEL = "event-reminders";
    private static final int FLAG_IMMUTABLE = 0x04000000; // PendingIntent.FLAG_IMMUTABLE (API 23+)

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (ACTION.equals(action)) {
            String id = intent.getStringExtra("id");
            show(ctx, id, intent.getStringExtra("title"), intent.getStringExtra("body"));
            remove(ctx, id);
        } else {
            // BOOT_COMPLETED or app update: schedule everything again.
            rescheduleAll(ctx);
        }
    }

    // ---------- storage ----------

    static synchronized JSONArray load(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static void save(Context ctx, JSONArray list) {
        prefs(ctx).edit().putString(KEY, list.toString()).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Adds reminders: JSON array of {id, at, title, body}. */
    static synchronized void addAll(Context ctx, String json) {
        try {
            JSONArray add = new JSONArray(json);
            JSONArray cur = load(ctx);
            JSONArray out = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject r = cur.getJSONObject(i);
                if (r.getLong("at") > now && !containsId(add, r.getString("id"))) out.put(r);
            }
            for (int i = 0; i < add.length(); i++) {
                JSONObject r = add.getJSONObject(i);
                if (r.getLong("at") <= now) continue;
                out.put(r);
                schedule(ctx, r);
            }
            save(ctx, out);
        } catch (Exception ignored) {
        }
    }

    /** Cancels every reminder whose id starts with the prefix. */
    static synchronized void cancelPrefix(Context ctx, String prefix) {
        JSONArray cur = load(ctx);
        JSONArray out = new JSONArray();
        for (int i = 0; i < cur.length(); i++) {
            try {
                JSONObject r = cur.getJSONObject(i);
                if (r.getString("id").startsWith(prefix)) alarms(ctx).cancel(pending(ctx, r));
                else out.put(r);
            } catch (Exception ignored) {
            }
        }
        save(ctx, out);
    }

    /** Ids of reminders still in the future. */
    static synchronized String futureIds(Context ctx) {
        JSONArray cur = load(ctx);
        JSONArray ids = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < cur.length(); i++) {
            try {
                JSONObject r = cur.getJSONObject(i);
                if (r.getLong("at") > now) ids.put(r.getString("id"));
            } catch (Exception ignored) {
            }
        }
        return ids.toString();
    }

    private static synchronized void remove(Context ctx, String id) {
        if (id == null) return;
        JSONArray cur = load(ctx);
        JSONArray out = new JSONArray();
        for (int i = 0; i < cur.length(); i++) {
            try {
                JSONObject r = cur.getJSONObject(i);
                if (!id.equals(r.getString("id"))) out.put(r);
            } catch (Exception ignored) {
            }
        }
        save(ctx, out);
    }

    private static boolean containsId(JSONArray list, String id) {
        for (int i = 0; i < list.length(); i++) {
            if (id.equals(list.optJSONObject(i) == null ? null : list.optJSONObject(i).optString("id"))) return true;
        }
        return false;
    }

    static synchronized void rescheduleAll(Context ctx) {
        JSONArray cur = load(ctx);
        long now = System.currentTimeMillis();
        for (int i = 0; i < cur.length(); i++) {
            try {
                JSONObject r = cur.getJSONObject(i);
                if (r.getLong("at") > now) schedule(ctx, r);
            } catch (Exception ignored) {
            }
        }
    }

    // ---------- alarms ----------

    private static AlarmManager alarms(Context ctx) {
        return (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    }

    private static PendingIntent pending(Context ctx, JSONObject r) throws Exception {
        Intent i = new Intent(ctx, ReminderReceiver.class);
        i.setAction(ACTION);
        i.putExtra("id", r.getString("id"));
        i.putExtra("title", r.getString("title"));
        i.putExtra("body", r.getString("body"));
        return PendingIntent.getBroadcast(ctx, r.getString("id").hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
    }

    private static void schedule(Context ctx, JSONObject r) throws Exception {
        // Inexact but allowed while the phone sleeps; exact alarms need an extra
        // permission that Android 14 denies by default.
        alarms(ctx).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.getLong("at"), pending(ctx, r));
    }

    // ---------- notification ----------

    private static void show(Context ctx, String id, String title, String body) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = channelBuilder(ctx, nm);
            if (b == null) return;
        } else {
            b = new Notification.Builder(ctx);
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
        }
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi);
        nm.notify(id == null ? 1 : id.hashCode(), b.build());
    }

    /** Notification channels arrived in Android 8. This build compiles against Android 6, so use reflection. */
    private static Notification.Builder channelBuilder(Context ctx, NotificationManager nm) {
        try {
            Class<?> chCls = Class.forName("android.app.NotificationChannel");
            Object ch = chCls.getConstructor(String.class, CharSequence.class, int.class)
                    .newInstance(CHANNEL, "Event reminders", 4 /* IMPORTANCE_HIGH */);
            NotificationManager.class.getMethod("createNotificationChannel", chCls).invoke(nm, ch);
            return Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(ctx, CHANNEL);
        } catch (Exception e) {
            return null;
        }
    }
}
