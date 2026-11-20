package com.myapp.suite;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.concurrent.Executor;

/**
 * A real fingerprint / face check, for one decision at a time.
 *
 * <p>Why this file exists: the policy "Ask + fingerprint" was a promise the app could
 * not keep, because a WebView has no biometric API and the option was offered on every
 * device. {@link #isAvailable(FragmentActivity, int)} now answers from the sensor, and
 * {@link #confirm} runs an actual BiometricPrompt before a tool is allowed to run.
 *
 * <p>Two rules are deliberate:
 * <ul>
 *   <li>a device that cannot check gives a reason, never a silent "yes";</li>
 *   <li>an error or a cancel is a <b>no</b> — the tool must not run unapproved.</li>
 * </ul>
 */
public final class BiometricGate {

    /** The check could not be set up on this device; the caller falls back to "Always ask". */
    public static final int UNAVAILABLE = 0;
    /** A fingerprint or face is enrolled and ready. */
    public static final int READY = 1;
    /** The hardware exists but nothing is enrolled: the user must add one first. */
    public static final int NEEDS_ENROLMENT = 2;

    private BiometricGate() {}

    /** Ask the sensor, not the platform name. */
    public static int state(FragmentActivity activity) {
        if (activity == null) return UNAVAILABLE;
        int allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.BIOMETRIC_WEAK;
        int can = BiometricManager.from(activity).canAuthenticate(allowed);
        if (can == BiometricManager.BIOMETRIC_SUCCESS) return READY;
        if (can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) return NEEDS_ENROLMENT;
        return UNAVAILABLE;
    }

    /** A one-shot answer the caller can wait on. */
    public interface Result {
        void done(boolean approved);
    }

    /**
     * Show the system prompt and call {@code result} exactly once.
     *
     * @param title  what the user is approving, e.g. "Run run_shell"
     * @param reason one line of why, shown under the title
     */
    public static void confirm(FragmentActivity activity, String title, String reason, Result result) {
        if (activity == null || result == null) { if (result != null) result.done(false); return; }
        if (state(activity) != READY) { result.done(false); return; }
        Executor main = ContextCompat.getMainExecutor(activity);
        BiometricPrompt prompt = new BiometricPrompt(activity,
                main,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                        result.done(true);
                    }
                    @Override public void onAuthenticationError(int code, CharSequence message) {
                        // Cancel, lockout, no sensor: all of them mean "do not run".
                        result.done(false);
                    }
                    @Override public void onAuthenticationFailed() {
                        // One wrong finger is not a refusal: the prompt stays up.
                    }
                });
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title == null || title.isEmpty() ? "Confirm this action" : title)
                .setSubtitle(reason)
                .setNegativeButtonText("Cancel")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.BIOMETRIC_WEAK)
                .setConfirmationRequired(false)
                .build();
        prompt.authenticate(info);
    }
}
