package app.groupdigest;

import android.app.Notification;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * Reads WhatsApp notifications the user has given this app access to, and keeps the
 * messages from the groups they picked. Only messages that arrive as notifications
 * can be seen: no history, nothing from muted groups, and nothing if WhatsApp's
 * "show preview" setting is off. Nothing is sent anywhere from here.
 */
public class CaptureService extends NotificationListenerService {
    // Notification extras by name: the constants are newer than the API level we compile against.
    private static final String EXTRA_MESSAGES = "android.messages";
    private static final String EXTRA_CONVERSATION_TITLE = "android.conversationTitle";
    private static final String EXTRA_IS_GROUP = "android.isGroupConversation";
    private static final String EXTRA_TITLE = "android.title";
    private static final String EXTRA_TEXT = "android.text";

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Throwable ignored) {
            // Never crash the listener on an unexpected notification shape.
        }
    }

    private void handle(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        if (!"com.whatsapp".equals(pkg) && !"com.whatsapp.w4b".equals(pkg)) return;
        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle x = n.extras;
        if (x == null) return;

        CharSequence convo = x.getCharSequence(EXTRA_CONVERSATION_TITLE);
        boolean isGroup = x.getBoolean(EXTRA_IS_GROUP, convo != null);
        if (!isGroup || convo == null) return; // 1:1 chats are never captured
        String group = CaptureStore.cleanGroupName(convo.toString());
        if (group.isEmpty()) return;

        CaptureStore.noteGroup(this, group);
        if (!CaptureStore.isSelected(this, group)) return;

        Parcelable[] msgs = x.getParcelableArray(EXTRA_MESSAGES);
        if (msgs != null && msgs.length > 0) {
            for (Parcelable p : msgs) {
                if (!(p instanceof Bundle)) continue;
                Bundle m = (Bundle) p;
                CharSequence text = m.getCharSequence("text");
                CharSequence sender = m.getCharSequence("sender");
                long time = m.getLong("time", sbn.getPostTime());
                if (text == null) continue;
                CaptureStore.add(this, group, time, sender == null ? null : sender.toString(), text.toString());
            }
        } else {
            // Older style: title "Group: Sender" or "Sender @ Group", text is the message.
            CharSequence title = x.getCharSequence(EXTRA_TITLE);
            CharSequence text = x.getCharSequence(EXTRA_TEXT);
            if (text == null) return;
            String sender = title == null ? null : title.toString();
            if (sender != null) {
                int at = sender.indexOf(" @ ");
                int colon = sender.indexOf(": ");
                if (at > 0) sender = sender.substring(0, at);
                else if (colon > 0) sender = sender.substring(colon + 2);
            }
            CaptureStore.add(this, group, sbn.getPostTime(), sender, text.toString());
        }
    }
}
