# মাইক্রোফোন ব্লক — কারণ ও বাকি ধাপ

## যা পাওয়া গেল
`android/app/src/main/AndroidManifest.xml`-এ **`RECORD_AUDIO` পারমিশনই ছিল না** (২৯টি `uses-permission`-এর মধ্যে শুধু `CAMERA` ছিল)। পারমিশন ডিক্লেয়ার না থাকলে WebView ইউজারকে জিজ্ঞেসও করতে পারে না — ব্রাউজার/অ্যাপ সরাসরি "blocked" দেখায়। এটাই মূল কারণ, সেটিংসের সমস্যা নয়।

## এই কমিটে যা হলো
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```
(`CAMERA`-এর ঠিক উপরে বসানো, যাতে একই গুচ্ছে থাকে।)

## বাকি ধাপ (MainActivity.java)
WebView-এ মাইক ব্যবহার করতে হলে দুটো জিনিস লাগে — পারমিশন ডিক্লেয়ার করা (হয়ে গেছে) **এবং** রানটাইমে চাওয়া + WebView-এর অনুরোধে সাড়া দেওয়া:

```java
// 1) WebChromeClient — পেজ যখন মাইক চায়
webView.setWebChromeClient(new WebChromeClient() {
  @Override
  public void onPermissionRequest(final PermissionRequest request) {
    runOnUiThread(() -> {
      for (String r : request.getResources()) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
          if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
              != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(MainActivity.this,
                new String[]{ Manifest.permission.RECORD_AUDIO }, 1001);
            request.deny();   // পরে ব্যবহারকারী আবার চাপলে অনুমতি দেবে
            return;
          }
          request.grant(new String[]{ r });
        }
      }
    });
  }
});
```

```java
// 2) শুরুতেই একবার চাওয়া (ব্রিজ থেকে অন-ডিমান্ডও করা যায়)
if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
    != PackageManager.PERMISSION_GRANTED) {
  ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO }, 1001);
}
```

## আরেকটা ফাঁদ
পেজ যদি `file://` থেকে লোড হয়, তাহলে **মাইক কখনোই কাজ করবে না** (secure context দরকার)। `https://` বা `WebViewAssetLoader` (`https://appassets.androidplatform.net/...`) ব্যবহার করতে হবে।

## যাচাই
১. অ্যাপ ইনস্টল করে **Settings → Apps → My App → Permissions → Microphone** দেখা যায় কি না।
২. মাইক বাটন চাপলে সিস্টেমের পারমিশন ডায়ালগ আসে।
৩. অনুমতি দেওয়ার পর পেজে `navigator.mediaDevices.getUserMedia({audio:true})` সফল হয়।
