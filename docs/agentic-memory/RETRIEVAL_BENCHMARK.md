# Semantic retrieval benchmark: FTS5 vs embeddings vs hybrid

Run 16 Nov 2026 on the VM. Harness: `tools/retrieval-benchmark/` (`dataset.py`, `bench.py`). It is Python and stays outside the product. **No embedding code was added to the app.** Raw output: `/home/sprite/memory-audit/retrieval/report.json`.

## 1. Why paraphrased questions fail today

The app's recall path (`turn_memory/fts.rs`) builds an FTS5 query by OR-ing prefix matches of the question's words, minus stopwords, then sorts by bm25. It can find only turns that **share a word stem** with the question. In this dataset the questions were written to paraphrase:

- Mean share of a question's query terms that prefix-match any word of the answer turn: **0.081**.
- **60 of 88** questions share no term with their answer turn at all, so FTS5 cannot find those by design.
- Cross-script and cross-language questions are the worst case. Examples: a Bengali question about a fact said in English, a Banglish "apur shadi kobe" for a Bengali-script fact, "sister" vs "বোন". Test-split FTS5 R@5 by language: Bengali **0.000**, Banglish 0.312, mixed 0.375, English 0.457.
- When FTS5 does return something, it is often a filler turn that shares a generic word ("server", "port", "নতুন"). This pushes the precision of the hybrid down (§4).

## 2. Dataset and method (identical for A, B and C)

- **Corpus:** 400 synthetic chat turns (user line + assistant line). 48 fact turns are placed at random positions (seed 11). The other 352 turns are distractors drawn from 40 filler pairs in the same domains (other ports, other budgets, other people). Four facts are later **superseded** (port 8742→9150, app name নীলপদ্ম→Shapla, backup day, coverage 70→80%). For those questions both turns count as relevant, and the answer key is the newer value.
- **Questions:** 88, two per fact for 44 facts: Bengali 19, Banglish 22, English 37, mixed 10.
- **Leakage control:** questions were written as meaning paraphrases that avoid the fact's own words. The lexical overlap above is *measured* per question (in `report.json`), not just claimed. Split: **dev** = facts whose id is divisible by 3 (30 questions), **test** = the rest (58). The only tuned setting, the RRF constant k ∈ {10, 30, 60}, was picked on dev. All k gave the same dev MRR, so the first (k=10) was kept. The numbers below are **test only**.
- **Limitation:** the corpus and the questions were written by the same author (the agent), not by independent annotators. The dataset is small (58 test questions), so differences of a few points are noise.
- **Metrics:** Recall@5/@10 and Precision@5 against the relevant turns, MRR@10, and "Answer in top-5" (the answer string occurs in one of the top 5 turns).
- **A:** a line-for-line Python port of the app's FTS5 path: the same tokenizer (`unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 0`), stopwords, 12-term limit, prefix OR query and bm25 order, using Python's bundled SQLite.
- **B:** dense cosine search over L2-normalised vectors, brute force over all 400 turns.
  - `bge-m3` via **OVHcloud AI Endpoints** (anonymous, 1024 dims)
  - `paraphrase-multilingual-MiniLM-L12-v2` (local, fastembed/ONNX, 384 dims)
  - `potion-multilingual-128M` (local static model, 256 dims)
- **C:** Reciprocal Rank Fusion of the top-10 lists from A and B.

## 3. Results (test split, 58 questions)

| Method | R@5 | R@10 | P@5 | MRR | Answer in top-5 | dev MRR | ms/query |
|---|---|---|---|---|---|---|---|
| A FTS5 (current app) | 0.319 | 0.336 | 0.069 | 0.296 | 0.328 | 0.117 | 0.18 |
| B bge-m3 (OVHcloud API) | **0.672** | 0.698 | **0.141** | **0.677** | **0.672** | 0.631 | 58.5* |
| B MiniLM-L12 multilingual (local) | 0.509 | 0.543 | 0.107 | 0.484 | 0.517 | 0.361 | 3.2 |
| B potion-multilingual-128M (local) | 0.397 | 0.448 | 0.083 | 0.394 | 0.397 | 0.255 | 0.25 |
| C RRF FTS5 + bge-m3 | 0.647 | **0.716** | 0.138 | 0.509 | 0.655 | 0.394 | 58.7* |
| C RRF FTS5 + MiniLM | 0.491 | 0.595 | 0.103 | 0.391 | 0.500 | 0.261 | 3.4 |
| C RRF FTS5 + potion | 0.440 | 0.474 | 0.093 | 0.372 | 0.448 | 0.202 | 0.43 |

\* Most of this is the network round trip to embed the question. The cosine search itself takes 0.09 ms for 400 vectors.

**R@5 by language (test):**

| Method | Bengali (11) | Banglish (16) | English (23) | mixed (8) |
|---|---|---|---|---|
| A FTS5 | 0.000 | 0.312 | 0.457 | 0.375 |
| B bge-m3 | **0.636** | **0.438** | 0.826 | **0.750** |
| B MiniLM | 0.091 | 0.312 | **0.848** | 0.500 |
| B potion | 0.182 | 0.312 | 0.565 | 0.375 |
| C FTS5 + bge-m3 | 0.545 | 0.438 | 0.804 | 0.750 |

**Cost, storage and speed (400 turns):**

- **FTS5:** index built in 96.6 ms. Database size 106,496 bytes (the whole file, which holds only the index).
- **bge-m3 (OVHcloud):**
  - Embedding 400 turns took 8,556 tokens in 16 requests (the provider's batch limit is 25 inputs), 20.0 s in total on the anonymous tier. The 88 questions took 1,169 tokens.
  - Cost here: **$0** (anonymous, 2 requests per minute). At OVHcloud's listed price of €0.01 per million input tokens (OVHcloud's bge-m3 catalog page; the same page gives the anonymous limit of 2 requests per minute and the batch limit of 25), the 400 turns would cost about €0.00009.
  - Vectors take 1.6 MB as float32 or 0.4 MB as int8.
- **MiniLM local:** 2.3 s for 400 turns on the VM CPU, 3.2 ms per query, 0.6 MB float32.
- **potion local:** 0.1 s for 400 turns, 0.2 ms per query, 0.4 MB float32.

**Answer accuracy (LLM reads the top-5 and answers): NOT MEASURED.** The run on `kilo-auto/free` stopped after 96 of 174 calls (7 errors, free-tier speed), so there is no complete number. "Answer in top-5" is the only answer-level number above, and it is a ceiling for what a reader model could answer, not an accuracy.

## 4. What this shows

1. **Embeddings clearly help paraphrased and cross-language recall.** bge-m3 more than doubles test R@5 (0.319 → 0.672) and MRR (0.296 → 0.677). Bengali R@5 goes from 0.000 to 0.636. This is a meaningful improvement on this dataset.
2. **Plain RRF with the current FTS5 hurts the ranking.** Compared with bge-m3 alone, RRF lowers MRR from 0.677 to 0.509 and dev MRR from 0.631 to 0.394. FTS5's false positives from generic shared words get equal weight in the fusion. R@10 rises slightly (0.698 → 0.716). Note that this dataset has almost no exact-wording questions. In the earlier 400-turn benchmark, exact-wording questions are where FTS5 reached 100%. A hybrid that keeps FTS5's strength on identifiers and numbers without its noise has **not been tested here**. Candidate designs: let FTS5 vote only when its match is strong or the query holds an identifier, or use weighted fusion. That needs a dataset with both question types.
3. **Small on-device models are weaker on Bengali.** MiniLM matches bge-m3 on English (0.848) but reaches only 0.091 on Bengali. potion is fast and tiny, but only beats FTS5 modestly.
4. **No vector database is needed.** Brute-force cosine over 400 vectors takes 0.03–0.09 ms. Even 10,000 turns would be a linear scan of a few MB. If a SQLite-native index is wanted later, [sqlite-vec](https://github.com/asg017/sqlite-vec) is "pure C, no dependencies, runs anywhere SQLite runs" and stores float/int8/binary vectors in `vec0` virtual tables (it is pre-v1, so breaking changes are expected). It is not needed at this scale.

## 5. Mobile feasibility (not measured on a phone)

- **Provider embeddings** (bge-m3 on OVHcloud): there is no model on the device, but each archived turn needs a network call, recall needs one call per question (about 58 ms here plus mobile latency), and an authenticated key is needed beyond 2 requests per minute.
- **Local models:** the ONNX MiniLM (multilingual, 384 dims) and static potion models ran on the VM CPU. Their phone speed and the size of their files in the app bundle were not measured.
- **Storage:** int8 vectors at 1024 dims take about 1 KB per turn.

## 6. Recommendation

- Do **not** ship plain RRF over the current FTS5.
- Next experiment, still in the harness:
  - add exact-wording questions to this dataset
  - test dense-first retrieval with FTS5 used only for identifier/number queries, or weighted fusion
  - measure answer accuracy with a non-reasoning reader model
- If that holds, implement provider-side bge-m3 behind a setting, store int8 vectors in a SQLite BLOB column with brute-force search, and keep FTS5 for exact identifiers.
