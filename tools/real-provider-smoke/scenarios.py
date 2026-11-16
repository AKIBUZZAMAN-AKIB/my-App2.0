#!/usr/bin/env python3
"""Writes the smoke-test scenario files (synthetic data only) to argv[1]."""
import json, os, random, sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
NOTES = "Project notes\n- owner: Akib\n- vault code: TIGER-5521\n- backup day: Thursday\n"
OVH_SMALL = "Meta-Llama-3_3-70B-Instruct"  # on the app's OVH tool-model list
RO_TOOLS = ["read_file", "grep_files", "recall_turns", "memory_inspect"]  # read-only: no approval prompts
OVH_OVERFLOW = "Qwen2.5-VL-72B-Instruct"  # real window 32768 (OVH /models)


def tools_scenario(provider, model):
    return {
        "warm_models": ["ovhcloud"] if provider == "ovhcloud" else [],
        "session": "smoke-tools", "max_turns": 6, "timeout_s": 900, "workspace_files": {"notes.txt": NOTES},
        "prompts": [
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "Reply with exactly the word PONG-7 and nothing else."},
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "Use the read_file tool to read notes.txt, then tell me the vault code written in it."},
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "Without using any tool: what was the vault code you read from notes.txt earlier in this chat? Answer with the code only."},
        ],
    }


def overflow_scenario():
    random.seed(7)
    words = ("river market engine window garden signal planet copper lantern harbor meadow circuit violet thunder "
             "canvas orbit marble falcon ribbon summit cobalt prism willow ember quartz tundra beacon saddle").split()
    seed = []
    for t in range(3):
        seed.append(["user", f"History question {t + 1}: please describe item set {t + 1} in detail."])
        body = " ".join(f"{random.choice(words)}-{random.randint(10, 9999)}" for _ in range(4000))
        seed.append(["assistant", f"Item set {t + 1}: {body}"])
    return {
        "session": "smoke-overflow", "max_turns": 4, "timeout_s": 1200, "seed": seed,
        "warm_models": ["ovhcloud"],
        "prompts": [
            {"provider": "ovhcloud", "model": OVH_OVERFLOW, "allowed_tools": [], "prompt": "In one short sentence: what was my very first question in this chat about?"},
            # Second turn: budgets against the window learned from turn 1's error.
            {"provider": "ovhcloud", "model": OVH_OVERFLOW, "allowed_tools": [], "prompt": "Reply with exactly the word ACK-3 and nothing else."},
        ],
    }


def bengali_scenario(provider, model):
    facts = [
        ("আমাদের নতুন প্রজেক্টের নাম হবে 'নীলপদ্ম'। এটা একটা হিসাব রাখার মোবাইল অ্যাপ।", "ঠিক আছে, প্রজেক্টের নাম 'নীলপদ্ম' — হিসাব রাখার মোবাইল অ্যাপ। লিখে রাখলাম।"),
        ("প্রজেক্টের ডেডলাইন ২০ ডিসেম্বর। এর আগে প্রথম রিলিজ দিতে হবে।", "বুঝেছি, ডেডলাইন ২০ ডিসেম্বর, তার আগে প্রথম রিলিজ।"),
        ("টেস্ট সার্ভারের হোস্টনেম kakatua-17.lan, ওখানেই staging চলবে।", "ঠিক আছে, staging চলবে kakatua-17.lan-এ।"),
        ("ডাটাবেস হিসেবে আমরা SQLite নেব, Postgres না, কারণ অ্যাপ অফলাইনে চলবে।", "সিদ্ধান্ত: SQLite, Postgres না — অফলাইনের জন্য।"),
        ("সার্ভারের পোর্ট রাখো 8742।", "পোর্ট 8742 রাখলাম।"),
        ("না, পোর্ট বদলে 9150 করো, 8742 অন্য সার্ভিস নিয়ে নিয়েছে।", "ঠিক আছে, পোর্ট এখন 9150; 8742 বাদ।"),
        ("ডিজাইনের রং হবে গাঢ় নীল আর সাদা।", "রং: গাঢ় নীল আর সাদা।"),
    ]
    filler = [
        ("আজকে আবহাওয়া কেমন যেন মেঘলা।", "হ্যাঁ, মেঘলা দিনে কাজের মন বসে কম।"),
        ("চা খেয়ে আসি একটু।", "ঠিক আছে, আসুন।"),
        ("লগইন স্ক্রিনের লেখাগুলো একটু ছোট করো।", "লগইন স্ক্রিনের ফন্ট ছোট করার নোট রাখলাম।"),
        ("বাটনগুলো গোল কোণার হলে ভালো লাগবে।", "গোল কোণার বাটন — নোট করলাম।"),
        ("রিপোর্ট পেজে মাসভিত্তিক চার্ট লাগবে।", "মাসভিত্তিক চার্ট যোগ হবে।"),
        ("নোটিফিকেশন রাতে বন্ধ থাকবে।", "রাতে নোটিফিকেশন বন্ধ।"),
        ("আইকনটা পরে ঠিক করব।", "ঠিক আছে, আইকন পরে।"),
    ]
    seed = []
    for u, a in facts + filler:
        seed += [["user", u], ["assistant", a]]
    return {
        "session": "smoke-bn", "max_turns": 6, "timeout_s": 1500, "seed": seed,
        "prompts": [
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "আগের কথা মনে করে বলো: আমাদের সার্ভারের পোর্ট এখন কত, আর প্রজেক্টের ডেডলাইন কবে? সংক্ষেপে বাংলায় উত্তর দাও।"},
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "recall_turns টুল দিয়ে মূল কথোপকথন থেকে খুঁজে বলো: staging কোন হোস্টনেমের সার্ভারে চলবে বলেছিলাম? শুধু হোস্টনেমটা বলো।"},
        ],
    }


def english_scenario(provider, model):
    """Same-batch change in English: the port is set and changed inside one summary batch."""
    turns = [
        ("Our project is called 'Bluelotus', a bookkeeping mobile app.", "Noted: project 'Bluelotus', a bookkeeping mobile app."),
        ("Deadline is December 20; the first release must ship before it.", "Got it: deadline December 20, first release before that."),
        ("Staging runs on the host kakatua-17.lan.", "OK, staging on kakatua-17.lan."),
        ("We'll use SQLite, not Postgres, because the app works offline.", "Decision: SQLite, not Postgres, for offline use."),
        ("Set the server port to 8742.", "Server port set to 8742."),
        ("No, change the server port to 9150; another service took 8742.", "Done: server port is now 9150, 8742 dropped."),
        ("Design colors: dark blue and white.", "Colors: dark blue and white."),
        ("It's cloudy today.", "Cloudy days are slow days."),
        ("Make the login screen text a bit smaller.", "Noted: smaller login text."),
        ("Rounded buttons would look nice.", "Rounded buttons noted."),
        ("The report page needs a monthly chart.", "Monthly chart added to the plan."),
        ("Notifications stay off at night.", "Night-time notifications off."),
        ("We'll fix the icon later.", "OK, icon later."),
        ("Grabbing a coffee.", "Sure."),
    ]
    seed = []
    for u, a in turns:
        seed += [["user", u], ["assistant", a]]
    return {
        "session": "smoke-en", "max_turns": 6, "timeout_s": 1500, "seed": seed,
        "prompts": [
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "From what we said before: what is our server port now, and when is the deadline? Answer briefly."},
        ],
    }


def goals_scenario(provider, model):
    """Goal switch / resume typed live, after 14 seeded turns on mixed topics."""
    turns = [
        ("For the payment page we use the Stripe card form.", "Noted: Stripe card form for payments."),
        ("The checkout tests still need writing.", "Open task: write the checkout tests."),
        ("The weather is grey today.", "Grey days are slow days."),
        ("The login screen times out after 30 seconds on slow networks.", "Noted: login timeout after 30 s on slow networks."),
        ("For login we will use the OAuth device flow.", "Decision: OAuth device flow for login."),
        ("Our release notes go in docs/RELEASE.md.", "Release notes file: docs/RELEASE.md."),
        ("I had a sandwich for lunch.", "Enjoy it."),
    ] * 2
    seed = []
    for u, a in turns:
        seed += [["user", u], ["assistant", a]]
    return {
        "session": "smoke-goals", "max_turns": 4, "timeout_s": 1500, "seed": seed,
        "prompts": [
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "New goal: build the payment page with Stripe Elements"},
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "Pause this and switch to fixing the login timeout bug"},
            {"provider": provider, "model": model, "allowed_tools": RO_TOOLS, "prompt": "Go back to the payment page"},
            {"provider": provider, "model": model, "allowed_tools": [], "prompt": "Without using any tool: which goal is current now and which goal is paused? Give their goal IDs. Answer in one or two short lines."},
        ],
    }


scen = {
    "kilo_tools": tools_scenario("auto", None),
    "ovh_tools": tools_scenario("ovhcloud", OVH_SMALL),
    "ovh_overflow": overflow_scenario(),
    "kilo_bengali": bengali_scenario("auto", None),
    "ovh_bengali": dict(bengali_scenario("ovhcloud", OVH_SMALL), warm_models=["ovhcloud"], session="smoke-bn-ovh"),
    # Same overflow, but the model marked non-streaming through the app's own
    # providerModelStreamingCapabilities setting: OVH then answers with a real 400.
    "ovh_english": dict(english_scenario("ovhcloud", OVH_SMALL), warm_models=["ovhcloud"], session="smoke-en-ovh"),
    "ovh_goals": dict(goals_scenario("ovhcloud", OVH_SMALL), warm_models=["ovhcloud"]),
    "kilo_goals": goals_scenario("auto", None),
    "ovh_overflow_nostream": dict(overflow_scenario(), session="smoke-overflow-ns",
                                  runtime={"providerModelStreamingCapabilities": {"ovhcloud": {OVH_OVERFLOW: False}}}),
}
for name, s in scen.items():
    with open(os.path.join(out, name + ".json"), "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
print(" ".join(scen))
