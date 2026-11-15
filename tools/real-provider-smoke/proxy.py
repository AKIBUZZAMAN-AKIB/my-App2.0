#!/usr/bin/env python3
"""Recording reverse proxy for the real-provider smoke test.

The app's own provider path (NativeAgentHandle -> agent loop -> llm_driver)
is pointed at this proxy through runtime `providerBaseUrls`; the proxy
forwards every request unchanged to the real provider and records what went
out and what came back, so a test is only called verified when a real
request/response pair was observed.

* /kilo/...  -> https://api.kilo.ai/api/gateway/...            (Kilo free routes, anonymous)
* /ovh/...   -> https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/... (OVHcloud anonymous tier)

No API key is used. Any Authorization header the app sends is dropped and
only its presence is logged. Bodies are written to LOG_DIR/bodies for the
report; they contain only the synthetic test conversation.

Env:
  PORT (default 8899), LOG_DIR (default ./smoke-log)
  CTX_OVERRIDE  JSON {"model-id": tokens}: rewrite context_length in /models
                answers (used only for the overflow test, to make the app's
                estimate fit while the real provider rejects).
  OVH_PER_MIN   anonymous OVH limit per model (default 2): requests wait.
"""
import http.client, http.server, json, os, ssl, sys, threading, time, urllib.parse

PORT = int(os.environ.get("PORT", "8899"))
LOG_DIR = os.environ.get("LOG_DIR", "./smoke-log")
CTX_OVERRIDE = json.loads(os.environ.get("CTX_OVERRIDE", "{}") or "{}")
OVH_PER_MIN = int(os.environ.get("OVH_PER_MIN", "2"))
UPSTREAMS = {
    "kilo": ("api.kilo.ai", "/api/gateway"),
    "ovh": ("oai.endpoints.kepler.ai.cloud.ovh.net", "/v1"),
}
KEEP_HEADERS = ("x-kong-request-id", "x-vercel-id", "x-request-id", "ratelimit-remaining", "ratelimit-limit",
                "ratelimit-reset", "x-ratelimit-remaining-minute", "retry-after", "x-generation-id")
os.makedirs(os.path.join(LOG_DIR, "bodies"), exist_ok=True)
lock = threading.Lock()
seq = [0]
ovh_times = {}


def log(rec):
    with lock:
        with open(os.path.join(LOG_DIR, "requests.jsonl"), "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def summarize_request(body):
    msgs = body.get("messages") or []
    roles = [m.get("role") for m in msgs]
    chars = 0
    tool_results = []
    for m in msgs:
        c = m.get("content")
        s = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
        chars += len(s or "")
        if m.get("role") == "tool":
            tool_results.append((s or "")[:160])
    last_user = next((m.get("content") for m in reversed(msgs) if m.get("role") == "user"), "")
    if not isinstance(last_user, str):
        last_user = json.dumps(last_user, ensure_ascii=False)
    return {
        "model": body.get("model"), "stream": bool(body.get("stream")), "n_messages": len(msgs), "roles": roles,
        "content_chars": chars, "tools": [t.get("function", {}).get("name") for t in body.get("tools") or []],
        "tool_results": tool_results, "last_user": last_user[:160], "max_tokens": body.get("max_tokens") or body.get("max_completion_tokens"),
        "system_chars": sum(len(m.get("content") or "") for m in msgs if m.get("role") == "system" and isinstance(m.get("content"), str)),
    }


def throttle(up, model):
    if up != "ovh":
        return 0.0
    waited = 0.0
    while True:
        with lock:
            now = time.time()
            ts = [t for t in ovh_times.get(model, []) if now - t < 61]
            if len(ts) < OVH_PER_MIN:
                ts.append(now)
                ovh_times[model] = ts
                return waited
            wait = 61 - (now - ts[0])
        time.sleep(max(wait, 0.5))
        waited += max(wait, 0.5)


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _route(self):
        parts = self.path.split("/", 2)
        if len(parts) < 3 or parts[1] not in UPSTREAMS:
            return None, None, None
        host, base = UPSTREAMS[parts[1]]
        return parts[1], host, base + "/" + parts[2]

    def do_GET(self):
        self._forward(None)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self._forward(self.rfile.read(n))

    def _forward(self, raw):
        up, host, path = self._route()
        if not up:
            self.send_error(404)
            return
        with lock:
            seq[0] += 1
            n = seq[0]
        rec = {"seq": n, "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "upstream": up, "method": self.command, "path": path,
               "auth_header_present": bool(self.headers.get("Authorization"))}
        body = None
        if raw:
            try:
                body = json.loads(raw)
                rec["req"] = summarize_request(body)
                with open(os.path.join(LOG_DIR, "bodies", f"{n:04d}-req.json"), "w") as f:
                    json.dump(body, f, ensure_ascii=False, indent=1)
            except Exception as e:
                rec["req_parse_error"] = str(e)
        rec["throttled_s"] = round(throttle(up, (body or {}).get("model", "")), 1) if body else 0
        headers = {"Content-Type": self.headers.get("Content-Type", "application/json"), "Accept-Encoding": "identity",
                   "User-Agent": self.headers.get("User-Agent", "native-agent-smoke")}
        if self.headers.get("Accept"):
            headers["Accept"] = self.headers["Accept"]
        t0 = time.time()
        conn = http.client.HTTPSConnection(host, timeout=300, context=ssl.create_default_context())
        try:
            conn.request(self.command, path, body=raw, headers=headers)
            resp = conn.getresponse()
        except Exception as e:
            rec["upstream_error"] = str(e)
            log(rec)
            self.send_error(502)
            return
        rec["status"] = resp.status
        rec["headers"] = {k: v for k, v in resp.getheaders() if k.lower() in KEEP_HEADERS}
        ctype = resp.getheader("Content-Type", "")
        if "text/event-stream" in ctype:
            self._stream(resp, rec, n, t0)
        else:
            data = resp.read()
            rec["latency_ms"] = int((time.time() - t0) * 1000)
            if self.command == "GET" and path.endswith("/models") and CTX_OVERRIDE and resp.status == 200:
                try:
                    d = json.loads(data)
                    for m in d.get("data", []):
                        if m.get("id") in CTX_OVERRIDE:
                            m["context_length"] = CTX_OVERRIDE[m["id"]]
                            rec.setdefault("ctx_override", {})[m["id"]] = CTX_OVERRIDE[m["id"]]
                    data = json.dumps(d).encode()
                except Exception as e:
                    rec["override_error"] = str(e)
            self._summarize_response(data, rec, n)
            self.send_response(resp.status)
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        log(rec)

    def _summarize_response(self, data, rec, n):
        try:
            d = json.loads(data)
        except Exception:
            rec["resp_text"] = data[:400].decode("utf-8", "replace")
            return
        if "data" in d and isinstance(d["data"], list) and "choices" not in d:
            rec["resp"] = {"models": len(d["data"])}
            return
        with open(os.path.join(LOG_DIR, "bodies", f"{n:04d}-resp.json"), "w") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        ch = (d.get("choices") or [{}])[0]
        msg = ch.get("message") or {}
        rec["resp"] = {"id": d.get("id"), "model": d.get("model"), "provider": d.get("provider"), "usage": d.get("usage"),
                       "finish_reason": ch.get("finish_reason"), "content": (msg.get("content") or "")[:300],
                       "tool_calls": [(c.get("function") or {}).get("name") for c in msg.get("tool_calls") or []]}
        if "error" in d:
            rec["resp"]["error"] = json.dumps(d["error"], ensure_ascii=False)[:600]
        if "object" in d and d.get("object") == "error":
            rec["resp"]["error"] = json.dumps(d, ensure_ascii=False)[:600]

    def _stream(self, resp, rec, n, t0):
        self.send_response(resp.status)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        chunks, content, tools, usage, rid, model, finish, first = 0, [], [], None, None, None, None, None
        buf = b""
        raw_log = open(os.path.join(LOG_DIR, "bodies", f"{n:04d}-stream.txt"), "wb")
        while True:
            piece = resp.read1(65536) if hasattr(resp, "read1") else resp.read(4096)
            if not piece:
                break
            if first is None:
                first = int((time.time() - t0) * 1000)
            raw_log.write(piece)
            self.wfile.write(b"%x\r\n%s\r\n" % (len(piece), piece))
            self.wfile.flush()
            buf += piece
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line.startswith(b"data:"):
                    continue
                payload = line[5:].strip()
                if payload == b"[DONE]":
                    continue
                try:
                    d = json.loads(payload)
                except Exception:
                    continue
                chunks += 1
                rid = rid or d.get("id")
                model = model or d.get("model")
                if d.get("usage"):
                    usage = d["usage"]
                for ch in d.get("choices") or []:
                    delta = ch.get("delta") or {}
                    if delta.get("content"):
                        content.append(delta["content"])
                    for tc in delta.get("tool_calls") or []:
                        nm = (tc.get("function") or {}).get("name")
                        if nm:
                            tools.append(nm)
                    finish = ch.get("finish_reason") or finish
        self.wfile.write(b"0\r\n\r\n")
        raw_log.close()
        rec["latency_ms"] = int((time.time() - t0) * 1000)
        rec["resp"] = {"streamed": True, "sse_chunks": chunks, "first_byte_ms": first, "id": rid, "model": model, "usage": usage,
                       "finish_reason": finish, "content": "".join(content)[:300], "tool_calls": tools}


class S(http.server.ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"proxy on 127.0.0.1:{PORT}, log {LOG_DIR}", flush=True)
    S(("127.0.0.1", PORT), H).serve_forever()
