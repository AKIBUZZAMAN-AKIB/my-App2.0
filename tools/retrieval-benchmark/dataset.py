"""Ground-truth dataset for the semantic retrieval benchmark (synthetic, no user data).

How leakage is kept out:
* FACTS holds what is *said in the chat* (the indexed text). QUESTIONS holds what a
  user later *asks*; every question was written as a paraphrase of the fact's
  meaning, deliberately avoiding the fact's own content words (synonyms, other
  script, other language). bench.py measures and reports the remaining lexical
  overlap per question so this is checkable, not just claimed.
* Nothing is tuned on the test split: the dev split (fact id % 3 == 0) is the only
  place the RRF constant and query prefixes are chosen; the report uses test only
  (and shows dev separately).
* Limitation (stated in the report): corpus and questions were written by the same
  author (the agent), not by independent annotators.

Languages: bn = Bengali script, bl = Banglish (romanised Bengali), en = English,
mx = mixed Bengali/English in one sentence.
"""
import random

# id, user statement, assistant reply, answer key (must occur in the turn), supersedes (fact id or None)
FACTS = [
    (1, "স্টেজিং সার্ভার চলবে kakatua-17.lan হোস্টে।", "ঠিক আছে, staging থাকবে kakatua-17.lan-এ।", "kakatua-17", None),
    (2, "Let's go with SQLite rather than Postgres, the app must keep working without internet.", "Agreed: SQLite, no Postgres.", "SQLite", None),
    (3, "আমার বোনের বিয়ে ১৪ ফেব্রুয়ারি, চট্টগ্রামে।", "শুভকামনা! ১৪ ফেব্রুয়ারি, চট্টগ্রাম — মনে রাখলাম।", "১৪ ফেব্রুয়ারি", None),
    (4, "server er port 8742 rakho", "Port 8742 set korlam.", "8742", None),
    (5, "na, port ta 9150 koro, 8742 onno service niye niyeche", "Thik ache, port ekhon 9150.", "9150", 4),
    (6, "The release deadline is 20 December, first beta must ship before that.", "Noted: deadline 20 December.", "20 December", None),
    (7, "ডিজাইনের মূল রং হবে গাঢ় নীল আর সাদা।", "রং: গাঢ় নীল আর সাদা।", "গাঢ় নীল", None),
    (8, "amar laptop er RAM 16 GB, Ryzen 7 processor", "Ok, 16 GB RAM ar Ryzen 7.", "Ryzen 7", None),
    (9, "Crash report tool হিসেবে Sentry নয়, GlitchTip ব্যবহার করব কারণ self-host করা যায়।", "ঠিক, GlitchTip self-hosted।", "GlitchTip", None),
    (10, "My dentist appointment is on Tuesday at 4:30 PM with Dr. Farzana.", "Got it, Tuesday 4:30 PM, Dr. Farzana.", "Farzana", None),
    (11, "আমাদের অ্যাপের নাম হবে 'নীলপদ্ম'।", "নাম ঠিক হলো: নীলপদ্ম।", "নীলপদ্ম", None),
    (12, "amra app er nam 'নীলপদ্ম' bad diye 'Shapla' rakhbo, trademark problem ache", "Thik ache, notun nam Shapla.", "Shapla", 11),
    (13, "Monthly cloud budget is capped at 35 dollars.", "Budget cap: $35 per month.", "35", None),
    (14, "API rate limit মিনিটে ১২০টা request রাখব।", "প্রতি মিনিটে ১২০ request সীমা।", "১২০", None),
    (15, "Rahim bhai backend dekhbe, Nusrat UI er kaj korbe", "Backend: Rahim, UI: Nusrat.", "Nusrat", None),
    (16, "The Wi-Fi password at the office is mango-tree-42.", "Saved: mango-tree-42.", "mango-tree-42", None),
    (17, "আমার প্রিয় খাবার কাচ্চি বিরিয়ানি, কিন্তু চিংড়িতে অ্যালার্জি আছে।", "কাচ্চি প্রিয়, চিংড়িতে অ্যালার্জি — মনে রাখলাম।", "চিংড়ি", None),
    (18, "Login screen e OTP 6 digit hobe, 3 minute por expire korbe", "OTP: 6 digit, 3 minute expiry.", "3 minute", None),
    (19, "We decided to use Tauri instead of Electron to keep the binary small.", "Tauri it is.", "Tauri", None),
    (20, "ব্যাকআপ হবে প্রতি বৃহস্পতিবার রাত ২টায়।", "ব্যাকআপ: বৃহস্পতিবার রাত ২টা।", "বৃহস্পতিবার", None),
    (21, "backup ta বৃহস্পতিবার na, ekhon theke রবিবার raat 2 tay hobe", "Thik ache, backup ekhon রবিবার.", "রবিবার", 20),
    (22, "My flight to Kuala Lumpur is MH197 on 3 January.", "MH197, 3 January — noted.", "MH197", None),
    (23, "Error code E-4471 আসে যখন token-এর মেয়াদ শেষ হয়ে যায়।", "E-4471 মানে token expired।", "E-4471", None),
    (24, "amader office Uttara sector 7 e shift hocche next month", "Office: Uttara sector 7.", "Uttara", None),
    (25, "Use Inter for UI text and JetBrains Mono for code blocks.", "Fonts: Inter + JetBrains Mono.", "JetBrains Mono", None),
    (26, "মায়ের ওষুধ রোজ সকালে ৮টায়, নাম Losartan।", "Losartan, সকাল ৮টা।", "Losartan", None),
    (27, "Push notification er jonno Firebase na, ntfy use korbo", "Notifications: ntfy.", "ntfy", None),
    (28, "The maximum upload size will be 25 MB per file.", "Upload limit 25 MB.", "25 MB", None),
    (29, "আমাদের প্রথম ক্লায়েন্ট হলো 'রূপসা ফুডস'।", "প্রথম client: রূপসা ফুডস।", "রূপসা", None),
    (30, "git branch naming hobe feature/<ticket-id> format e", "Branch format: feature/<ticket-id>.", "feature/<ticket-id>", None),
    (31, "Akib's GitHub username for the bot is shapla-ci-bot.", "Bot account: shapla-ci-bot.", "shapla-ci-bot", None),
    (32, "ডার্ক মোড ডিফল্ট থাকবে না, সিস্টেম সেটিং অনুসরণ করবে।", "Dark mode: system setting অনুযায়ী।", "সিস্টেম সেটিং", None),
    (33, "amar gym er schedule shoni, montro, brihoshpoti shondha 7 ta", "Gym: Sat/Tue/Thu 7 PM.", "shondha 7", None),
    (34, "The invoice number for the domain renewal was INV-20931.", "Invoice INV-20931.", "INV-20931", None),
    (35, "ছবির জন্য WebP format, সর্বোচ্চ 1600px চওড়া।", "WebP, 1600px max।", "1600px", None),
    (36, "test coverage minimum 70% na hole merge hobe na", "Coverage gate: 70%.", "70%", None),
    (37, "coverage gate 70% theke 80% korlam, team agree korse", "Updated: 80% coverage gate.", "80%", 36),
    (38, "Our support email will be help@shapla.app.", "Support: help@shapla.app.", "help@shapla.app", None),
    (39, "বাবার জন্মদিন ২৯ মার্চ, এবার একটা ঘড়ি উপহার দেব।", "২৯ মার্চ, ঘড়ি উপহার।", "ঘড়ি", None),
    (40, "Encryption er jonno AES-256-GCM, key thakbe Keystore e", "AES-256-GCM + Keystore.", "AES-256-GCM", None),
    (41, "The meeting with the investors moved to Sunday 11 AM at Gulshan.", "Investor meeting: Sunday 11 AM, Gulshan.", "Gulshan", None),
    (42, "লগ ফাইল ১৪ দিন পর মুছে যাবে।", "লগ retention ১৪ দিন।", "১৪ দিন", None),
    (43, "bikash e payment nibo, card pore add korbo", "Payment: bKash first, card later.", "bKash", None),
    (44, "My car's registration expires in August, plate Dhaka Metro GA 11-2345.", "Plate GA 11-2345, renew by August.", "11-2345", None),
    (45, "সার্চে টাইপ করার ৩০০ মিলিসেকেন্ড পর query যাবে (debounce)।", "Debounce ৩০০ ms।", "৩০০", None),
    (46, "language switch e default English, kintu Bangla first time e jiggesh korbe", "Default English, ask on first launch.", "first time", None),
    (47, "The on-call phone number for the server room is 01711-554433.", "On-call: 01711-554433.", "01711-554433", None),
    (48, "অফলাইনে থাকলে পরিবর্তনগুলো queue-তে জমা থাকবে, নেট এলে sync হবে।", "Offline queue, পরে sync।", "queue", None),
]

# fact id -> list of (lang, question). Written as paraphrases (see module doc).
QUESTIONS = {
    1: [("en", "Which machine did we pick to host the pre-production environment?"), ("bl", "test deploy er jonno kon box ta select korechilam?")],
    2: [("bn", "তথ্য জমা রাখার জন্য কোন স্টোরেজ ইঞ্জিন চূড়ান্ত হয়েছিল?"), ("mx", "net chara cholte hobe bole kon database engine final hoyechilo?")],
    3: [("en", "When and where is my sister getting married?"), ("bl", "apur shadi kobe ar kothay?")],
    5: [("bn", "আমাদের ব্যাকএন্ড এখন কোন নম্বরে listen করে?"), ("en", "What network number does our service listen on now?")],
    6: [("mx", "beta ber korar last date ta কবে?"), ("bn", "চূড়ান্ত সংস্করণ কোন তারিখের মধ্যে দিতে হবে?")],
    7: [("en", "What colour palette did we choose for the design?"), ("bl", "design er theme color ki thik holo?")],
    8: [("bn", "আমার কম্পিউটারের কনফিগারেশন কী, কোন চিপ?"), ("en", "What CPU and memory does my notebook have?")],
    9: [("en", "Which error tracking service will we run on our own servers?"), ("bl", "app crash dhorar jonno kon jinish nijer server e chalabo?")],
    10: [("bn", "দাঁতের ডাক্তারের কাছে কবে যেতে হবে, কার কাছে?"), ("mx", "teeth checkup er appointment kar sathe?")],
    12: [("en", "What is the product going to be called after the rename?"), ("bn", "ট্রেডমার্ক ঝামেলার পর অ্যাপের নতুন নাম কী?")],
    13: [("bn", "প্রতি মাসে হোস্টিংয়ে সর্বোচ্চ কত টাকা খরচ করা যাবে?"), ("bl", "hosting e mashe koto poisa khoroch korte parbo?")],
    14: [("en", "How many calls per minute is a client allowed before throttling?"), ("mx", "throttling er age per minute koyta call allow?")],
    15: [("bn", "ইন্টারফেসের কাজ কে করবে?"), ("en", "Who is responsible for the frontend screens?")],
    16: [("bl", "office er internet er code ta ki?"), ("en", "What do I type to join the workplace wireless network?")],
    17: [("en", "Is there any seafood I must avoid eating?"), ("bl", "amar kon khabar e somossa hoy?")],
    18: [("bn", "এককালীন কোড কত অঙ্কের আর কতক্ষণ বৈধ থাকে?"), ("en", "How long does the one-time sign-in code stay valid?")],
    19: [("mx", "desktop wrapper hishebe কোন framework বেছে নিয়েছি?"), ("bn", "ডেস্কটপ সংস্করণ বানাতে কোন কাঠামো নেওয়া হয়েছে?")],
    21: [("en", "On which night does the data copy job run now?"), ("bl", "data copy kon din raate hoy ekhon?")],
    22: [("bn", "মালয়েশিয়া যাওয়ার ফ্লাইট নম্বর কী?"), ("mx", "KL jawar plane ta কোনটা?")],
    23: [("en", "What does it mean when the app shows the session-ended code?"), ("bl", "login er meyad furale kon error number dekhay?")],
    24: [("bn", "নতুন কর্মস্থল কোন এলাকায় যাচ্ছে?"), ("en", "Which neighbourhood is our workplace relocating to?")],
    25: [("bl", "code dekhanor jonno kon typeface?"), ("en", "Which typefaces are used in the interface and for source snippets?")],
    26: [("en", "Which medicine does my mother take each morning?"), ("bl", "ammur oshudh er nam ki, kokhon khay?")],
    27: [("bn", "মোবাইলে অ্যালার্ট পাঠাতে কোন সার্ভিস ব্যবহার হবে?"), ("en", "What service will deliver alerts to phones?")],
    28: [("mx", "ekta attachment সর্বোচ্চ কত বড় হতে পারে?"), ("en", "What is the biggest file a user can attach?")],
    29: [("en", "Who is our very first customer?"), ("bl", "prothom kader jonno kaj korchi?")],
    30: [("bn", "শাখার নাম রাখার নিয়ম কী?"), ("en", "How should new git branches be named?")],
    31: [("bl", "automation er github account er nam ki?"), ("en", "Which GitHub handle does the automation use?")],
    32: [("en", "Will the night theme be on by default?"), ("bl", "kalo theme ki auto on thakbe?")],
    33: [("bn", "আমি কোন কোন দিন ব্যায়াম করতে যাই?"), ("en", "Which evenings do I work out?")],
    34: [("mx", "domain renew er bill নম্বর কত ছিল?"), ("en", "What was the reference number on the domain bill?")],
    35: [("en", "What image format and maximum width do we use for pictures?"), ("bl", "photo gula kon format e ar koto boro?")],
    37: [("bn", "মার্জ করতে টেস্ট কতটা ঢাকতে হবে এখন?"), ("en", "What test coverage threshold blocks merging now?")],
    38: [("bl", "customer ra kon mail e jogajog korbe?"), ("en", "Which address should customers write to for help?")],
    39: [("en", "What present am I getting my father, and when is his birthday?"), ("bl", "abbur jonmodin kobe, ki debo?")],
    40: [("bn", "ডেটা গোপন রাখতে কোন অ্যালগরিদম, চাবি কোথায় থাকে?"), ("mx", "data encrypt korte kon cipher use হচ্ছে?")],
    41: [("bl", "investor der sathe meeting kothay hobe?"), ("en", "Where and when do we meet the funders?")],
    42: [("en", "How long are log records kept before deletion?"), ("bl", "log koto din rakha hoy?")],
    43: [("bn", "শুরুতে টাকা নেওয়ার কোন মাধ্যম থাকবে?"), ("en", "Which mobile wallet will we accept payments through first?")],
    44: [("en", "What is my vehicle's licence plate?"), ("bl", "amar gari r number plate ki?")],
    45: [("mx", "search box এ কত delay দিয়ে request যায়?"), ("en", "How long do we wait after the user stops typing before querying?")],
    46: [("bn", "অ্যাপ প্রথম খুললে ভাষা নিয়ে কী হবে?"), ("en", "What happens with the interface language on first launch?")],
    47: [("bl", "server room er emergency te ke call dibo, number ta?"), ("en", "Which number do I ring for the data centre duty person?")],
    48: [("en", "What happens to edits made while there is no connection?"), ("bl", "net na thakle change gula ki hoy?")],
}

# Distractor/filler turns: same domains, different values, so lexical and
# semantic neighbours exist for most facts.
FILLER = [
    ("আজকে আবহাওয়া কেমন যেন মেঘলা।", "হ্যাঁ, মেঘলা দিনে কাজে মন বসে কম।"),
    ("Can you suggest a name for the settings icon?", "Maybe a simple gear glyph."),
    ("lunch e ki khabo bujhtesi na", "Khichuri try korte paren."),
    ("The QA laptop has 8 GB of memory, it's slow.", "8 GB is tight for the emulator."),
    ("পুরনো সার্ভারে port 3000 খোলা ছিল, ওটা বন্ধ করো।", "port 3000 বন্ধ করার নোট রাখলাম।"),
    ("Redis use korbo cache er jonno? pore dekhbo", "Pore decide kora jabe."),
    ("Our competitor's app is called Kolmi.", "Kolmi noted as competitor."),
    ("ঈদের ছুটি কবে থেকে?", "ক্যালেন্ডার দেখে জানাব।"),
    ("The staging database snapshot is 2.3 GB.", "That's manageable."),
    ("amar cousin er birthday next week, ki gift dewa jay?", "Boi ba headphone bhalo option."),
    ("Write a haiku about rain.", "Grey sky softly sighs / tin roofs drum a quiet song / the city slows down."),
    ("ফন্ট সাইজ একটু বড় করো সেটিংস পেজে।", "সেটিংস পেজে ফন্ট বড় করা হবে।"),
    ("What does HTTP 429 mean?", "Too Many Requests: the client is rate limited."),
    ("database migration script ta review kore dao", "Script e ekta index missing ache."),
    ("ঢাকায় যানজট আজ ভয়াবহ।", "অফিসে দেরি হলে জানিয়ে দিন।"),
    ("Explain what a mutex is in one line.", "A lock that lets only one thread use a resource at a time."),
    ("pore ekta podcast app banabo bhabchi", "Interesting idea."),
    ("Remind me what JSON stands for.", "JavaScript Object Notation."),
    ("আমার ভাই ফেব্রুয়ারিতে সিলেট যাবে।", "সিলেট সুন্দর জায়গা।"),
    ("Old error code E-1002 is deprecated now.", "E-1002 marked deprecated."),
    ("design er font ta ektu boro lagche", "Size 14 theke 13 kora jay."),
    ("Our previous budget for ads was 50 dollars, we stopped it.", "Ads paused."),
    ("নতুন টিমমেট সাকিব আগামী মাসে যোগ দেবে।", "সাকিবের জন্য onboarding doc লাগবে।"),
    ("What is the capital of Malaysia?", "Kuala Lumpur."),
    ("ki keyboard shortcut diye tab bondho kori?", "Ctrl+W."),
    ("The marketing site will use Astro.", "Astro for the landing page."),
    ("ছবির থাম্বনেইল 320px হলেই চলবে।", "থাম্বনেইল 320px।"),
    ("I had a long call with the bank about my card.", "Hope it got sorted."),
    ("gym e aj jaini, ghum pacchilo", "Rest o dorkar."),
    ("The CI pipeline takes 11 minutes now.", "We could cache dependencies."),
    ("আমার পুরনো ফোনের নম্বর 01819-000111 আর ব্যবহার করি না।", "পুরনো নম্বর বাদ দিলাম।"),
    ("Translate 'good morning' to Bangla.", "সুপ্রভাত।"),
    ("invoice gula ek folder e rakhte hobe", "Invoices folder banano jay."),
    ("Is Kotlin or Swift better for the widget?", "Each platform needs its own."),
    ("বাবা আজ ডাক্তারের কাছে গিয়েছিলেন, সব ঠিক আছে।", "ভালো খবর।"),
    ("The logo file should be SVG.", "SVG logo noted."),
    ("amader intern ke git shikhate hobe", "Ekta short guide likhe dei."),
    ("How many bytes in a kilobyte?", "1000 by SI, 1024 in binary usage."),
    ("নেট খুব স্লো আজকে।", "রাউটার রিস্টার্ট করে দেখুন।"),
    ("The analytics dashboard refreshes every 15 minutes.", "15-minute refresh."),
]


def build(seed=11, n_turns=400):
    """Returns (turns, qrels). turns: list of (turn_no, text). qrels: list of dicts."""
    rnd = random.Random(seed)
    fact_ids = [f[0] for f in FACTS]
    # place facts at distinct turns; a superseding fact always comes later
    slots = sorted(rnd.sample(range(5, n_turns - 5), len(FACTS)))
    order = list(FACTS)
    # keep supersede pairs ordered: sort by id keeps 4<5, 11<12, 20<21, 36<37
    placed = {f[0]: slots[i] for i, f in enumerate(order)}
    turns = {}
    for fid, user, asst, *_ in FACTS:
        turns[placed[fid]] = f"{user}\n{asst}"
    for t in range(1, n_turns + 1):
        if t not in turns:
            u, a = FILLER[rnd.randrange(len(FILLER))]
            turns[t] = f"{u}\n{a}"
    by_id = {f[0]: f for f in FACTS}
    qrels = []
    for fid, qs in QUESTIONS.items():
        rel = {placed[fid]}
        sup = by_id[fid][4]
        if sup:
            rel.add(placed[sup])
        for k, (lang, q) in enumerate(qs):
            qrels.append({"qid": f"f{fid}-{k}", "fact": fid, "lang": lang, "question": q, "relevant": sorted(rel),
                          "answer_turn": placed[fid], "answer": by_id[fid][3], "split": "dev" if fid % 3 == 0 else "test",
                          "superseded": bool(sup)})
    return [(t, turns[t]) for t in sorted(turns)], qrels
