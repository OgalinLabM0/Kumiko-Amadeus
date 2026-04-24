// android/app/src/main/java/com/kumiko/amadeus/app/replies/RemoteReplyReceiver.java
//
// B.4 (A6.2 Direct Reply): receives RemoteInput text from a notification's
// "Reply" button (Android 7+) so the user can answer Kumiko without
// unlocking the phone / opening the app. The text gets stashed in
// SharedPreferences; next time the WebView resumes (or starts cold)
// it drains the stash and replays the message through the normal chat
// pipeline.
//
// We intentionally DON'T try to launch the WebView here to process the
// reply — Android allows broadcast receivers ~10s of CPU time, and
// booting a Capacitor WebView + Gemini round-trip easily exceeds that
// (the receiver would be killed mid-flight, dropping the reply).
// Stash → next-resume drain is the standard pattern.

package com.kumiko.amadeus.app.replies;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;

import androidx.core.app.RemoteInput;

import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteReplyReceiver extends BroadcastReceiver {

    public static final String ACTION_REPLY = "com.kumiko.amadeus.app.REPLY";
    public static final String KEY_TEXT_REPLY = "kumiko_text_reply";
    public static final String EXTRA_NOTIFICATION_ID = "notification_id";

    private static final String TAG = "RemoteReplyReceiver";
    private static final String PREFS = "kumiko_pending_replies";
    private static final String KEY_QUEUE = "queue";

    @Override
    public void onReceive(Context context, Intent intent) {
        Bundle remoteInput = RemoteInput.getResultsFromIntent(intent);
        if (remoteInput == null) {
            Log.w(TAG, "No RemoteInput results in intent");
            return;
        }
        CharSequence reply = remoteInput.getCharSequence(KEY_TEXT_REPLY);
        if (TextUtils.isEmpty(reply)) {
            Log.w(TAG, "Empty reply");
            return;
        }

        // Append {ts, text} into a JSON queue inside SharedPreferences.
        // The WebView drains this on resume via a new
        // services/androidPendingActions.ts module (created in JS land).
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            String existing = prefs.getString(KEY_QUEUE, "[]");
            JSONArray arr;
            try {
                arr = new JSONArray(existing);
            } catch (Throwable t) {
                arr = new JSONArray();
            }
            JSONObject row = new JSONObject();
            row.put("ts", System.currentTimeMillis());
            row.put("text", reply.toString());
            arr.put(row);
            prefs.edit().putString(KEY_QUEUE, arr.toString()).apply();
            Log.i(TAG, "Stashed reply (" + reply.length() + " chars), queue size now " + arr.length());
        } catch (Throwable t) {
            Log.e(TAG, "Failed to stash reply", t);
        }

        // Dismiss the notification we replied from so the user doesn't
        // see a stuck "Reply" button after submission.
        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);
        if (notificationId > 0) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(notificationId);
            }
        }
    }
}
