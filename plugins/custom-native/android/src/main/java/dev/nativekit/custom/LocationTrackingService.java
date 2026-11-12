package dev.nativekit.custom;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;

public class LocationTrackingService extends Service implements LocationListener {
    public static final String ACTION_START = "dev.nativekit.LOCATION_START";
    public static final String ACTION_STOP = "dev.nativekit.LOCATION_STOP";
    public static final String LOCATION_BROADCAST = "dev.nativekit.custom.LOCATION";
    private static final String PREFS = "nativekit_location_store";
    private LocationManager locationManager;
    private int maxBuffer = 100;

    @Override public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopTracking();
            return START_NOT_STICKY;
        }
        long minTime = intent == null ? 30_000L : Math.max(5_000L, intent.getLongExtra("minTimeMs", 30_000L));
        float minDistance = intent == null ? 10f : Math.max(0f, intent.getFloatExtra("minDistanceM", 10f));
        maxBuffer = intent == null ? 100 : Math.max(10, Math.min(1000, intent.getIntExtra("maxBuffer", 100)));

        Notification notification = notification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7421, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(7421, notification);
        if (!hasPermission()) { stopTracking(); return START_NOT_STICKY; }

        try { if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTime, minDistance, this); } catch (Exception ignored) {}
        try { if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTime, minDistance, this); } catch (Exception ignored) {}
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", true).apply();
        return START_STICKY;
    }

    private boolean hasPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public void onLocationChanged(Location location) {
        try {
            JSONObject value = new JSONObject();
            value.put("latitude", location.getLatitude());
            value.put("longitude", location.getLongitude());
            value.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            value.put("altitude", location.hasAltitude() ? location.getAltitude() : JSONObject.NULL);
            value.put("speed", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL);
            value.put("bearing", location.hasBearing() ? location.getBearing() : JSONObject.NULL);
            value.put("timestamp", location.getTime());
            append(value);
            sendBroadcast(new Intent(LOCATION_BROADCAST).setPackage(getPackageName()).putExtra("location", value.toString()));
        } catch (Exception ignored) {}
    }

    private synchronized void append(JSONObject value) {
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString("locations", "[]");
        JSONArray old;
        try { old = new JSONArray(raw); } catch (Exception ignored) { old = new JSONArray(); }
        JSONArray next = new JSONArray();
        int first = Math.max(0, old.length() - maxBuffer + 1);
        for (int i = first; i < old.length(); i++) next.put(old.opt(i));
        next.put(value);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("locations", next.toString()).apply();
    }

    private Notification notification() {
        Intent stop = new Intent(this, LocationActionReceiver.class).setAction(ACTION_STOP);
        PendingIntent pending = PendingIntent.getBroadcast(this, 7422, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, NativeConfig.locationChannel(this))
            : new Notification.Builder(this);
        return builder.setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(getApplicationInfo().loadLabel(getPackageManager()))
            .setContentText(getString(R.string.nativekit_location_channel_name))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, getString(R.string.nativekit_location_stop), pending).build())
            .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(NativeConfig.locationChannel(this), getString(R.string.nativekit_location_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("A user-started background location session");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void stopTracking() {
        try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", false).apply();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() { try { locationManager.removeUpdates(this); } catch (Exception ignored) {} super.onDestroy(); }
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}
    @SuppressWarnings("deprecation") @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
