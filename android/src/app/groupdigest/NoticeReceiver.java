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
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Live-sync notices for the Android app, which has no Web Push: about every
 * half hour, fetch new notices for this phone's sync room from the relay
 * (scheduled digest ready, server offline, WhatsApp unlinked), open the
 * sealed ones with the room key (same scheme as src/lib/syncCrypto.ts) and
 * show them as notifications.
 */
public class NoticeReceiver extends BroadcastReceiver {
    static final String ACTION = "app.groupdigest.NOTICES";
    private static final String PREFS = "notices";
    private static final String CHANNEL = "sync-notices";
    private static final int FLAG_IMMUTABLE = 0x04000000;

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        if (!ACTION.equals(intent.getAction())) {
            // Boot or app update: alarms are forgotten, set it again.
            if (prefs(ctx).getString("room", null) != null) arm(ctx);
            return;
        }
        final PendingResult done = goAsync();
        new Thread(new Runnable() {
            public void run() {
                try {
                    check(ctx);
                } catch (Exception ignored) {
                } finally {
                    done.finish();
                }
            }
        }).start();
    }

    /** {relay, room, secret, after} to watch a room, or "" to stop. */
    static synchronized void watch(Context ctx, String json) {
        SharedPreferences p = prefs(ctx);
        try {
            if (json == null || json.isEmpty()) {
                p.edit().clear().apply();
                alarms(ctx).cancel(pending(ctx));
                return;
            }
            JSONObject o = new JSONObject(json);
            String room = o.getString("room");
            long after = o.optLong("after", 0);
            SharedPreferences.Editor e = p.edit();
            if (!room.equals(p.getString("room", ""))) e.putLong("after", after);
            else e.putLong("after", Math.max(after, p.getLong("after", 0)));
            e.putString("relay", o.getString("relay")).putString("room", room).putString("secret", o.getString("secret")).apply();
            arm(ctx);
        } catch (Exception ignored) {
        }
    }

    private static void arm(Context ctx) {
        alarms(ctx).setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 60_000L,
                AlarmManager.INTERVAL_HALF_HOUR, pending(ctx));
    }

    private static void check(Context ctx) throws Exception {
        SharedPreferences p = prefs(ctx);
        String relay = p.getString("relay", null), room = p.getString("room", null), secret = p.getString("secret", null);
        if (relay == null || room == null || secret == null) return;
        byte[] s = Base64.decode(secret, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        String token = Base64.encodeToString(hmac(s, "group-digest auth v1"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        byte[] key = hmac(s, "group-digest enc v1");
        long after = p.getLong("after", 0);

        HttpURLConnection c = (HttpURLConnection) new URL(relay + "/api/sync/" + room + "/notices?after=" + after).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (c.getResponseCode() != 200) return;
        JSONArray list = new JSONObject(read(c.getInputStream())).getJSONArray("notices");
        long max = after;
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.getJSONObject(i);
            long seq = n.getLong("seq");
            if (seq <= after) continue;
            max = Math.max(max, seq);
            String title = n.optString("title", ""), body = n.optString("body", "");
            if (n.has("blob")) {
                try {
                    JSONObject v = new JSONObject(open(key, room + "/notice", n.getString("blob")));
                    title = v.optString("title", "");
                    body = v.optString("body", "");
                } catch (Exception e) {
                    continue; // sealed with another key
                }
            }
            if (!title.isEmpty()) show(ctx, n.optString("tag", "notice"), title, body);
        }
        if (max > after) p.edit().putLong("after", max).apply();
    }

    private static byte[] hmac(byte[] key, String label) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        return m.doFinal(label.getBytes(StandardCharsets.UTF_8));
    }

    static String open(byte[] key, String aad, String blob) throws Exception {
        byte[] raw = Base64.decode(blob, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
        ci.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, raw, 0, 12));
        ci.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        return new String(ci.doFinal(raw, 12, raw.length - 12), StandardCharsets.UTF_8);
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
        in.close();
        return out.toString("UTF-8");
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static AlarmManager alarms(Context ctx) {
        return (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
    }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, NoticeReceiver.class);
        i.setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, 7, i, PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
    }

    private static void show(Context ctx, String tag, String title, String body) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Class<?> chCls = Class.forName("android.app.NotificationChannel");
                Object ch = chCls.getConstructor(String.class, CharSequence.class, int.class).newInstance(CHANNEL, "Live sync", 3 /* DEFAULT */);
                NotificationManager.class.getMethod("createNotificationChannel", chCls).invoke(nm, ch);
                b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(ctx, CHANNEL);
            } catch (Exception e) {
                return;
            }
        } else {
            b = new Notification.Builder(ctx);
            b.setDefaults(Notification.DEFAULT_ALL);
        }
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi);
        nm.notify(("notice-" + tag).hashCode(), b.build());
    }
}
