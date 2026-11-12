package dev.nativekit.isolatedbrowser;

import android.app.IntentService;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;

import androidx.webkit.ProfileStore;
import androidx.webkit.WebStorageCompat;
import androidx.webkit.WebViewFeature;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Runs in the fixed isolated WebView process so data is removed from the correct process partition. */
@SuppressWarnings("deprecation")
public final class IsolatedStorageCleanupService extends IntentService {
    static final String EXTRA_APP_ID = "appId";
    static final String EXTRA_RESULT = "result";
    static final int RESULT_OK = 0;
    static final int RESULT_ERROR = 1;

    private final Handler main = new Handler(Looper.getMainLooper());

    public IsolatedStorageCleanupService() { super("NativeKitIsolatedStorageCleanup"); }

    @Override protected void onHandleIntent(Intent intent) {
        ResultReceiver receiver = intent == null ? null : intent.getParcelableExtra(EXTRA_RESULT);
        try {
            if (Build.VERSION.SDK_INT < 28 || intent == null) throw new IllegalStateException("Isolated data cleanup requires Android API 28 or newer");
            try { WebView.setDataDirectorySuffix("nativekit-isolated-v1"); }
            catch (IllegalStateException ignored) { /* The isolated process has already initialized this same suffix. */ }
            String appId = intent.getStringExtra(EXTRA_APP_ID);
            if (appId == null || appId.isEmpty()) throw new IllegalArgumentException("Missing appId");
            deleteBrowserData(appId);
            if (receiver != null) receiver.send(RESULT_OK, Bundle.EMPTY);
        } catch (Exception error) {
            if (receiver != null) {
                Bundle data = new Bundle();
                data.putString("error", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
                receiver.send(RESULT_ERROR, data);
            }
        }
    }

    private void deleteBrowserData(String appId) throws Exception {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            deleteProfileWithRetry(IsolatedAppStore.profileName(appId));
            return;
        }
        String host = IsolatedAppStore.originHost(appId);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            deleteSiteData(host);
            return;
        }
        // Compatibility path for older WebView providers. The per-app origin still prevents cross-app conflicts.
        WebStorage.getInstance().deleteOrigin("https://" + host);
        CookieManager cookies = CookieManager.getInstance();
        String origin = "https://" + host;
        String values = cookies.getCookie(origin);
        if (values != null) for (String pair : values.split(";")) {
            String name = pair.trim().split("=", 2)[0];
            if (!name.isEmpty()) cookies.setCookie(origin, name + "=; Max-Age=0; Path=/; Secure; SameSite=Strict");
        }
        cookies.flush();
    }

    private void deleteProfileWithRetry(String profileName) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 32; attempt++) {
            AtomicReference<Exception> failure = new AtomicReference<>();
            CountDownLatch finished = new CountDownLatch(1);
            main.post(() -> {
                try { ProfileStore.getInstance().deleteProfile(profileName); }
                catch (Exception error) { failure.set(error); }
                finally { finished.countDown(); }
            });
            if (!finished.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out while scheduling WebView profile deletion");
            if (failure.get() == null) return;
            last = failure.get();
            if (!(last instanceof IllegalStateException)) throw last;
            Thread.sleep(250L);
        }
        throw new IllegalStateException("Per-app WebView profile is still in use", last);
    }

    private void deleteSiteData(String host) throws Exception {
        AtomicReference<Exception> failure = new AtomicReference<>();
        CountDownLatch finished = new CountDownLatch(1);
        main.post(() -> {
            try {
                WebStorageCompat.deleteBrowsingDataForSite(WebStorage.getInstance(), host, finished::countDown);
            } catch (Exception error) {
                failure.set(error);
                finished.countDown();
            }
        });
        if (!finished.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out while deleting isolated site data");
        if (failure.get() != null) throw failure.get();
    }
}
