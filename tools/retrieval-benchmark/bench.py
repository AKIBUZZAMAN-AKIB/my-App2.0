#!/usr/bin/env python3
"""Semantic retrieval benchmark: A = app's FTS5 path, B = dense embeddings, C = hybrid RRF.

Same corpus, same questions, same metrics for every method. Harness only; nothing
here is product code. Run with the venv that has numpy + fastembed:
  python bench.py OUT_DIR [--llm]
Embeddings: OVHcloud AI Endpoints `bge-m3` (anonymous free tier, no key) and two
local fastembed models. Vectors are cached in OUT_DIR/cache so re-runs cost nothing.
"""
import json, os, re, sqlite3, sys, time, unicodedata, urllib.request
import numpy as np
import dataset

OUT = sys.argv[1]
USE_LLM = "--llm" in sys.argv
os.makedirs(os.path.join(OUT, "cache"), exist_ok=True)
TURNS, QRELS = dataset.build()
TEXT = dict(TURNS)
IDS = [t for t, _ in TURNS]

# ---------- A: exact port of turn_memory/fts.rs (tokenizer, query_for, bm25 order) ----------
STOP = set("""the and for was were what which who when where why how did does you your our his her its this that with from about have had has
are is in on of to we it an or be at by do me my earlier before said tell chat turn turns""".split()) | set(
    "কী কি কে কোন কোনো কোথায় কোথায় কখন কেন কেমন আমরা আমি আপনি তুমি ছিল হয় হয় এবং ও এর যে এই সেই আগে বলেছিলাম বলেছিলেন বলেছিল করেছিলাম ছিলো না".split())


def is_word_char(c):
    return c.isalnum() or "\u0900" <= c <= "\u0DFF" or "\u0300" <= c <= "\u036F" or c == "_"


def query_for(q):
    terms, cur = [], ""
    for c in q + " ":
        if is_word_char(c):
            cur += c
            continue
        w = cur.lower()
        cur = ""
        if len(w) < 2 or w in STOP or w in terms:
            continue
        terms.append(w)
        if len(terms) == 12:
            break
    return " OR ".join(f'"{t}"*' for t in terms) if terms else None, terms


def build_fts():
    path = os.path.join(OUT, "fts.db")
    if os.path.exists(path):
        os.remove(path)
    c = sqlite3.connect(path)
    c.execute("CREATE VIRTUAL TABLE turn_fts USING fts5(session_key UNINDEXED, turn_no UNINDEXED, body, "
              "tokenize = \"unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0\")")
    t0 = time.perf_counter()
    c.executemany("INSERT INTO turn_fts (rowid, session_key, turn_no, body) VALUES (?, 's', ?, ?)", [(t, t, x) for t, x in TURNS])
    c.commit()
    build_ms = (time.perf_counter() - t0) * 1000
    # FTS5 shadow tables only (the base archive table exists in the app anyway)
    size = c.execute("SELECT SUM(pgsize) FROM dbstat WHERE name LIKE 'turn_fts%'").fetchone()[0] if has_dbstat(c) else os.path.getsize(path)
    return c, build_ms, size


def has_dbstat(c):
    try:
        c.execute("SELECT 1 FROM dbstat LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


def fts_search(c, q, k=10):
    mq, _ = query_for(q)
    if not mq:
        return []
    return [r[0] for r in c.execute("SELECT turn_no FROM turn_fts WHERE turn_fts MATCH ? AND session_key='s' ORDER BY bm25(turn_fts) LIMIT ?", (mq, k))]


# ---------- B: embeddings ----------
def ovh_embed(texts, cache_name):
    path = os.path.join(OUT, "cache", cache_name + ".json")
    if os.path.exists(path):
        d = json.load(open(path))
        return np.array(d["vecs"], dtype=np.float32), d["meta"]
    vecs, usage, calls, ms = [], 0, [], 0.0
    for i in range(0, len(texts), 25):
        body = json.dumps({"model": "bge-m3", "input": texts[i:i + 25]}).encode()
        for attempt in range(12):
            req = urllib.request.Request("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings", data=body, headers={"Content-Type": "application/json"})
            t0 = time.perf_counter()
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    d = json.load(r)
                    hdr = {k: v for k, v in r.headers.items() if "ratelimit" in k.lower() or "request-id" in k.lower()}
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(35)
                    continue
                raise
        ms += (time.perf_counter() - t0) * 1000
        vecs += [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
        usage += (d.get("usage") or {}).get("total_tokens", 0)
        calls.append({"n": len(texts[i:i + 25]), "model": d.get("model"), "usage": d.get("usage"), "headers": hdr})
    meta = {"total_tokens": usage, "requests": calls, "wall_ms": ms}
    json.dump({"vecs": vecs, "meta": meta}, open(path, "w"))
    return np.array(vecs, dtype=np.float32), meta


_local = {}


def local_embed(model, texts, prefix=""):
    from fastembed import TextEmbedding
    if model not in _local:
        _local[model] = TextEmbedding(model_name=model, threads=4)
    t0 = time.perf_counter()
    v = np.array(list(_local[model].embed([prefix + t for t in texts], batch_size=32)), dtype=np.float32)
    return v, (time.perf_counter() - t0) * 1000


def normalize(v):
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)


def dense_rank(qv, dv, k=10):
    s = dv @ qv
    idx = np.argsort(-s)[:k]
    return [IDS[i] for i in idx]


def rrf(lists, k=60, n=10):
    sc = {}
    for l in lists:
        for r, d in enumerate(l):
            sc[d] = sc.get(d, 0) + 1.0 / (k + r + 1)
    return [d for d, _ in sorted(sc.items(), key=lambda x: -x[1])][:n]


# ---------- metrics ----------
def metrics(results, qrels):
    m = {"R@5": 0, "R@10": 0, "P@5": 0, "MRR": 0, "Hit@5": 0, "AnsCtx@5": 0}
    for q in qrels:
        rel = set(q["relevant"])
        got = results[q["qid"]]
        m["R@5"] += len(rel & set(got[:5])) / len(rel)
        m["R@10"] += len(rel & set(got[:10])) / len(rel)
        m["P@5"] += len(rel & set(got[:5])) / 5
        m["Hit@5"] += 1 if q["answer_turn"] in got[:5] else 0
        m["AnsCtx@5"] += 1 if any(q["answer"] in TEXT[t] for t in got[:5]) else 0
        rr = 0
        for i, d in enumerate(got[:10]):
            if d in rel:
                rr = 1 / (i + 1)
                break
        m["MRR"] += rr
    n = max(len(qrels), 1)
    return {k: round(v / n, 3) for k, v in m.items()} | {"n": len(qrels)}


def overlap(q):
    """Share of the question's FTS query terms that prefix-match any word of the target turn."""
    _, terms = query_for(q["question"])
    words = set(w.lower() for w in re.findall(r"[\w\u0980-\u09FF]+", TEXT[q["answer_turn"]]))
    hit = [t for t in terms if any(w.startswith(t) for w in words)]
    return len(hit) / max(len(terms), 1), hit


# ---------- LLM answer accuracy (optional, free Kilo route) ----------
def llm_answer(question, contexts):
    prompt = ("Answer the question using only these excerpts from an earlier chat. If several values conflict, the later turn wins. "
              "Reply with the short answer only; if the excerpts do not contain it, reply UNKNOWN.\n\n" +
              "\n".join(f"[turn {t}] {TEXT[t]}" for t in sorted(contexts)) + f"\n\nQuestion: {question}")
    body = json.dumps({"model": "kilo-auto/free", "messages": [{"role": "user", "content": prompt}], "max_tokens": 300}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request("https://api.kilo.ai/api/gateway/chat/completions", data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            return (d["choices"][0]["message"].get("content") or "").strip(), d.get("model"), d.get("usage"), d.get("id")
        except Exception as e:
            err = str(e)
            time.sleep(20)
    return "ERROR " + err, None, None, None


BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def correct(ans, key):
    a = unicodedata.normalize("NFC", ans).lower().translate(BN_DIGITS)
    k = unicodedata.normalize("NFC", key).lower().translate(BN_DIGITS)
    alts = {"bkash": ["bikash", "বিকাশ"], "রবিবার": ["sunday", "robibar"], "গাঢ় নীল": ["dark blue", "navy"], "চিংড়ি": ["prawn", "shrimp", "chingri"],
            "বৃহস্পতিবার": ["thursday"], "ঘড়ি": ["watch"], "সিস্টেম সেটিং": ["system"], "shondha 7": ["7 pm", "7pm", "7 ta", "৭টা", "7টা"],
            "রূপসা": ["rupsha", "rupsa"], "নীলপদ্ম": ["nilpodmo"], "14 ফেব্রুয়ারি": ["14 february", "february 14", "14 feb"], "14 দিন": ["14 day"],
            "first time": ["first launch", "ask", "জিজ্ঞেস", "jiggesh", "প্রথমবার"], "3 minute": ["3 min", "৩ মিনিট", "three minute"], "queue": ["কিউ", "sync"],
            "300": ["300"], "120": ["120"], "35": ["35"]}
    return k in a or any(x in a for x in alts.get(k, []))


def main():
    t_all = time.time()
    report = {"corpus_turns": len(TURNS), "questions": len(QRELS)}
    c, fts_build_ms, fts_bytes = build_fts()
    report["fts"] = {"build_ms": round(fts_build_ms, 1), "index_bytes": fts_bytes}
    texts = [x for _, x in TURNS]
    qs = [q["question"] for q in QRELS]
    runs, lat = {}, {}

    # A
    t0 = time.perf_counter()
    runs["A_fts5"] = {q["qid"]: fts_search(c, q["question"]) for q in QRELS}
    lat["A_fts5"] = (time.perf_counter() - t0) * 1000 / len(QRELS)

    # B: OVH bge-m3 (provider), local models
    emb = {}
    dv, dmeta = ovh_embed(texts, "bge-m3-docs")
    qv, qmeta = ovh_embed(qs, "bge-m3-queries")
    emb["bge-m3 (OVHcloud API)"] = (normalize(dv), normalize(qv), dmeta, qmeta)
    local_models = [("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", ""), ("minishlab/potion-multilingual-128M", "")]
    for name, pre in local_models:
        try:
            d, dms = local_embed(name, texts, pre)
            t0 = time.perf_counter()
            q, qms = local_embed(name, qs, pre)
            emb[name.split("/")[1] + " (local)"] = (normalize(d), normalize(q), {"wall_ms": dms}, {"wall_ms": qms})
        except Exception as e:
            report.setdefault("errors", []).append(f"{name}: {e}")
    report["embeddings"] = {}
    for name, (d, q, dm, qm) in emb.items():
        key = "B_" + name
        t0 = time.perf_counter()
        runs[key] = {QRELS[i]["qid"]: dense_rank(q[i], d) for i in range(len(QRELS))}
        search_ms = (time.perf_counter() - t0) * 1000 / len(QRELS)
        lat[key] = search_ms + qm.get("wall_ms", 0) / len(QRELS)
        report["embeddings"][name] = {"dim": int(d.shape[1]), "vector_bytes_f32": int(d.shape[0] * d.shape[1] * 4),
                                      "vector_bytes_int8": int(d.shape[0] * d.shape[1]), "doc_embed_ms_total": round(dm.get("wall_ms", 0), 1),
                                      "query_embed_ms_avg": round(qm.get("wall_ms", 0) / len(QRELS), 2), "search_ms_avg": round(search_ms, 3),
                                      "doc_tokens": dm.get("total_tokens"), "query_tokens": qm.get("total_tokens"),
                                      "requests": (dm.get("requests") or [])[:1] + (qm.get("requests") or [])[:1]}

    # C: RRF of A with each B; k chosen on dev only
    dev = [q for q in QRELS if q["split"] == "dev"]
    test = [q for q in QRELS if q["split"] == "test"]
    report["rrf_k_dev"] = {}
    for name in emb:
        bkey = "B_" + name
        best = None
        for k in (10, 30, 60):
            r = {q["qid"]: rrf([runs["A_fts5"][q["qid"]], runs[bkey][q["qid"]]], k=k) for q in QRELS}
            m = metrics(r, dev)
            report["rrf_k_dev"][f"{name} k={k}"] = m["MRR"]
            if best is None or m["MRR"] > best[0]:
                best = (m["MRR"], k, r)
        runs[f"C_rrf(k={best[1]}) fts5+{name}"] = best[2]
        lat[f"C_rrf(k={best[1]}) fts5+{name}"] = lat["A_fts5"] + lat[bkey]

    report["results"] = {}
    for name, r in runs.items():
        report["results"][name] = {"test": metrics(r, test), "dev": metrics(r, dev), "all": metrics(r, QRELS),
                                   "by_lang_test": {l: metrics(r, [q for q in test if q["lang"] == l]) for l in ("bn", "bl", "en", "mx")},
                                   "latency_ms_avg": round(lat[name], 3)}

    ov = [overlap(q)[0] for q in QRELS]
    report["lexical_overlap"] = {"mean": round(float(np.mean(ov)), 3), "zero_overlap_questions": sum(1 for x in ov if x == 0),
                                 "per_question": {q["qid"]: [round(overlap(q)[0], 2), overlap(q)[1]] for q in QRELS}}
    report["lang_counts"] = {l: sum(1 for q in QRELS if q["lang"] == l) for l in ("bn", "bl", "en", "mx")}
    report["split_counts"] = {"dev": len(dev), "test": len(test)}

    if USE_LLM:
        best_b = max((n for n in runs if n.startswith("B_")), key=lambda n: report["results"][n]["dev"]["MRR"])
        best_c = max((n for n in runs if n.startswith("C_")), key=lambda n: report["results"][n]["dev"]["MRR"])
        cache_p = os.path.join(OUT, "cache", "llm.json")
        cache = json.load(open(cache_p)) if os.path.exists(cache_p) else {}
        acc = {}
        for name in ("A_fts5", best_b, best_c):
            ok, n, models, rows = 0, 0, set(), []
            for q in test:
                ctx = runs[name][q["qid"]][:5]
                key = f"{q['qid']}|{','.join(map(str, sorted(ctx)))}"
                if key not in cache:
                    cache[key] = llm_answer(q["question"], ctx)
                    json.dump(cache, open(cache_p, "w"), ensure_ascii=False)
                ans, model, usage, rid = cache[key]
                if ans.startswith("ERROR"):
                    continue
                n += 1
                good = correct(ans, q["answer"])
                ok += good
                models.add(model)
                rows.append([q["qid"], ans[:80], good])
            acc[name] = {"accuracy": round(ok / max(n, 1), 3), "answered": n, "of": len(test), "models": sorted(m for m in models if m), "rows": rows}
        report["llm_answer_accuracy_test"] = acc

    report["wall_s"] = round(time.time() - t_all, 1)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), ensure_ascii=False, indent=1)
    for name, r in report["results"].items():
        t = r["test"]
        print(f"{name:70s} R@5 {t['R@5']:.3f} R@10 {t['R@10']:.3f} P@5 {t['P@5']:.3f} MRR {t['MRR']:.3f} Ans@5 {t['AnsCtx@5']:.3f} lat {r['latency_ms_avg']}ms")


if __name__ == "__main__":
    main()
