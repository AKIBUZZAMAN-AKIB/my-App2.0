# বাকি ৩টি কাজের হুবহু প্যাচ

এই ফাইলে যা আছে, সব যাচাই করা কোডের ওপর নির্ভর করে লেখা — অন্ধ অনুমান নয়।
নিচের ক্রমে বসালেই বাকি কাজ শেষ: **৯ → ৩ → ১**।

---

## ৯. টার্নের মাঝে চেকলিস্ট বদল — `agent_loop.rs`

`wiring::changed_since(db, session, sent_rev)` আগেই তৈরি ও পরীক্ষিত। এখন লুপকে
জিজ্ঞেস করতে হবে।

**কোথায়:** `run_turn`-এ, `let tree_enabled = …` (আজ ~৫১০ নম্বর লাইন) লাইনের পর
একটা revision ধরে রাখুন:

```rust
let tree_rev_at_send = crate::context_tree::wiring::rev(&ctx.config.db_path, &ctx.session_key);
```

**তারপর,** টুল-ব্যাচ শেষ হওয়ার পর (যেখানে `tool_results` প্রসেস হয়ে পরের ধাপে
যাওয়া হয়), এই এক ব্লক বসান:

```rust
// A mid-turn change means the checklist the model is looking at is stale. The next
// step is built from scratch instead of being sent with an old view.
if tree_enabled {
    if let Some(sent) = tree_rev_at_send {
        if crate::context_tree::wiring::changed_since(&ctx.config.db_path, &ctx.session_key, sent) {
            crate::context_tree::wiring::set_request_context(
                &ctx.session_key, tree_window, effective_max_tokens as u32, &tree_model,
            );
            event_bus::emit(
                ctx.callback.as_ref(),
                "context.tree_changed",
                &serde_json::json!({ "rev": crate::context_tree::wiring::rev(&ctx.config.db_path, &ctx.session_key) }),
                &ctx.session_key,
            );
            tree_rev_at_send = crate::context_tree::wiring::rev(&ctx.config.db_path, &ctx.session_key);
        }
    }
}
```

(লুপের ভেতরে `tree_rev_at_send` `mut` হতে হবে; `emit`-এর নাম আপনার `event_bus`-এ
যেটা আছে সেটাই ব্যবহার করবেন।)

**যাচাই:** `ctx set` ডেকে একই টার্নে পরের ধাপে চেকলিস্ট বদলেছে কি না দেখুন; প্যানেলে
`context.tree_changed` এলে `rev` বাড়বে।

---

## ৩. টোকেন ব্রেকডাউন — ইঞ্জিন থেকে UI-তে ডেটা

UI (`tokenCard`) ইতিমধ্যে এই আকৃতি পড়ে:

```jsonc
{ "items": [ { "id": "res/R7", "title": "Gradle log", "state": "in", "tokens": 18400 } ] }
```

**কোথায়:** `context_tree/dispatch.rs`, `view` অ্যাকশনের উত্তর যেখানে তৈরি হয়
(`json!({ "rev": …, "counts": …, "tokens": … })`), সেখানে `items` যোগ করুন:

```rust
let items: Vec<serde_json::Value> = nodes.iter().map(|n| json!({
    "id": n.id.as_str(),
    "title": n.title,
    "state": match n.state {
        ItemState::In => "in", ItemState::Out => "out", ItemState::Note => "note",
        ItemState::Temp => "temp", ItemState::Locked => "locked",
    },
    // What the engine will really send for this item, not what it stored.
    "tokens": super::select::sent_tokens(n),
})).collect();
```

তারপর উত্তরটায় `"items": items` যোগ করুন। `nodes` ভেরিয়েবলটা ওই ফাংশনে আগেই
আছে (counts বানাতে ব্যবহৃত)।

**যাচাই:** প্যানেলে কার্ড খুললে প্রতিটি সারিতে টোকেন দেখাবে; যে আইটেম ইঞ্জিন টোকেন
পাঠায়নি তার ঘরে `—` থাকবে, `0` নয়।

---

## ১. মাইক — `MainActivity.java`

পারমিশন (ম্যানিফেস্ট) আর `NativeKitPro.requestMic()` হয়ে গেছে। বাকিটা হলো
Capacitor-এর WebChromeClient-কে subclass করে `getUserMedia` অনুরোধে সাড়া দেওয়া।

**নতুন ফাইল:** `android/app/src/main/java/com/myapp/suite/MicChromeClient.java`

```java
package com.myapp.suite;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.PermissionRequest;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's own client already handles most WebChrome calls; it just never grants
 * RESOURCE_AUDIO_CAPTURE. This subclass grants audio once the runtime permission is
 * held, and asks for it otherwise, so getUserMedia stops reporting "blocked".
 */
public class MicChromeClient extends BridgeWebChromeClient {
    private final android.app.Activity activity;

    public MicChromeClient(com.getcapacitor.Bridge bridge, android.app.Activity activity) {
        super(bridge);
        this.activity = activity;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        for (String res : request.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) continue;
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{ res });
            } else {
                ActivityCompat.requestPermissions(activity,
                        new String[]{ Manifest.permission.RECORD_AUDIO }, 4301);
                request.deny();   // ব্যবহারকারী অনুমতি দিলে পরের বারে grant হবে
            }
            return;
        }
        super.onPermissionRequest(request);   // ক্যামেরা ইত্যাদি Capacitor যেমন চায়
    }
}
```

**কোথায় বসাবেন:** `MainActivity`-র ওই জায়গায় যেখানে WebView তৈরি হয়
(`getBridge().getWebView()`), সেখানে:

```java
getBridge().getWebView().setWebChromeClient(new MicChromeClient(getBridge(), this));
```

**সতর্কতা:** এটা **একবার** করবেন — Capacitor নিজে client সেট করার পরে করলে
ভাঙবে না, আগে করলে Capacitor সেটাকে আবার ওভাররাইড করবে।

**এছাড়া:** পেজ `file://` থেকে লোড হলে `getUserMedia` কাজ করবে **না**। দরকার
`https://` অথবা `WebViewAssetLoader`।

---

## যাচাইয়ের চেকলিস্ট (সব বসানোর পর একবারে)

| ধাপ | কী দেখবেন |
|---|---|
| ৯ | `ctx set` করার পর একই টার্নে পরের উত্তরে নতুন চেকলিস্ট, প্যানেলে `rev` বেড়েছে |
| ৩ | Context window কার্ডে প্রতিটি আইটেমের টোকেন + সাবটোটাল + মোট/% |
| ১ | মাইক বাটনে সিস্টেমের পারমিশন ডায়ালগ, অনুমতির পর `getUserMedia` সফল |
| ৫·৮ | স্ক্রল করলে হেডার+চিপ-সারি উপরে আটকে থাকে, নিচের সারি ভেসে ওঠে না |
