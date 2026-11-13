# Agent engine v2: নতুন NativeKit API

পুরনো কোনো method, event বা storage key বদলানো হয়নি। নতুন API-গুলো পাশে যোগ হয়েছে, আর `www/agent.html` এগুলো ব্যবহার করে শুধু তখনই, যখন `NativeKit.agent.getEngineFeatures()` সেই feature-এর নাম ফেরত দেয়। পুরনো app build-এ এই method নেই, তাই page আগের পথেই চলে।

| API | কী করে | feature নাম |
|---|---|---|
| `getEngineFeatures()` | engine version, feature-এর তালিকা আর limit ফেরত দেয় | — |
| `sendMessage({ ..., attachments })`, `followUp(prompt, { attachments })` | PNG/JPEG/GIF/WebP ছবি আর text ফাইল পাঠায় (Anthropic, OpenAI, OpenAI Responses, Gemini) | `attachments`, `imageInput` |
| `respondToApprovalWithArgs(id, approved, reason?, modifiedArgs?)` | approval-এ বদলানো argument সরাসরি tool-এ পাঠায় | `approvalWithArgs` |
| `rewindSession(sessionKey, keepUserTurns, { expectedPrompt })` | session-কে কোনো prompt-এর আগে কেটে ছোট করে: আসল edit আর regenerate | `rewindSession` |
| `forkSession(source, { newSessionKey, keepUserTurns, expectedPrompt })` | সেখান থেকে পুরো ইতিহাস নিয়ে নতুন chat বানায় | `forkSession` |
| `registerUiTool({ name, description, inputSchema, execute })` | page নিজেই একটা tool দেয় (`ui__<name>`); agent ডাকলে page উত্তর দেয় | `uiTools` |
| `connectMcp(...)` → `appTools`, `readAppResource`, `callAppTool` | MCP Apps: server-এর `ui://` পেজ sandbox-এ দেখানো, আর app থেকে tool ডাকা | — |
| `removeMcpTools(names)` | engine থেকে নির্দিষ্ট MCP tool সরায় | `removeMcpTools` |

`expectedPrompt` মিলে না গেলে rewind/fork কিছু না কেটে error দেয়। তখন page আগের মতো নোট লিখে পাঠায়।

## agent.html-এ কোথায় লাগে

- **Edit / Regenerate:** `rewindSession` দিয়ে native ইতিহাস কাটে, তারপর নতুন লেখা হুবহু পাঠায়।
- **Fork:** `forkSession` দিয়ে নতুন session, প্রথম message-এ পুরনো কথা paste করতে হয় না।
- **Approval-এ Edit:** "Run with changes" চাপলে `respondToApprovalWithArgs`।
- **ছবি:** composer-এর + বোতাম বা paste; বড় ছবি JPEG-এ ছোট করা হয়।
- **UI tools:** `ui__show_widget` (options, form, checklist, table, chart, stats, confirm, html) আর `ui__show_html`। widget-এ উত্তর দিলে সেটা tool-এর result হিসেবে যায়।
- **HTML widget আর MCP Apps:** `sandbox="allow-scripts allow-forms"` iframe, same-origin নেই, CSP দিয়ে network বন্ধ (MCP App-এর নিজের `connectDomains` ছাড়া)।

## iOS

xcframework শুধু macOS-এ build হয়। নতুন Rust API-এর পরে `plugins/native-agent/ios/Frameworks/REBUILD_PENDING` রাখা হয়েছে; main-এ push হলে "iOS agent FFI" workflow xcframework নতুন করে বানিয়ে commit করে আর ফাইলটা মুছে দেয়। তার আগে iOS build নতুন symbol না পেয়ে fail করবে।
