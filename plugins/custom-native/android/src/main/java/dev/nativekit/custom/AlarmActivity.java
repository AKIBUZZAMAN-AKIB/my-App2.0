package dev.nativekit.custom;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class AlarmActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON);

        int padding = (int) (32 * getResources().getDisplayMetrics().density);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(padding, padding, padding, padding);
        layout.setBackgroundColor(Color.rgb(7, 17, 31));

        TextView title = new TextView(this);
        title.setText(getIntent().getStringExtra("title"));
        title.setTextSize(32);
        title.setTextColor(Color.WHITE);
        title.setGravity(Gravity.CENTER);
        layout.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView body = new TextView(this);
        body.setText(getIntent().getStringExtra("body"));
        body.setTextSize(18);
        body.setTextColor(Color.LTGRAY);
        body.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
        bodyParams.setMargins(0, padding / 2, 0, padding);
        layout.addView(body, bodyParams);

        Button stop = new Button(this);
        stop.setText(R.string.nativekit_alarm_stop);
        stop.setOnClickListener(view -> {
            startService(new Intent(this, AlarmService.class).setAction(AlarmService.ACTION_STOP).putExtra("alarmId", getIntent().getStringExtra("alarmId")));
            finishAndRemoveTask();
        });
        layout.addView(stop, new LinearLayout.LayoutParams(-1, -2));
        setContentView(layout);
    }
}
