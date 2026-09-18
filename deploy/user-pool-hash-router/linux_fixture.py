"""隔离 Linux 容器中的合成后端与一次性 HTTP 测试；不含真实端点。"""

import argparse
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import threading
import time

from runtime_check import Backend, MockHandler


class ContainerMock(MockHandler):
    def do_GET(self):
        if self.path == "/fixture/state":
            self.reply_state()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/fixture/offline":
            self.server.offline = True
            self.reply_state()
        elif self.path == "/fixture/online":
            self.server.offline = False
            self.reply_state()
        else:
            super().do_POST()

    def reply_state(self):
        with self.server.lock:
            value = {"backend": self.server.index, "requests": self.server.requests,
                     "cancelled": self.server.client_cancelled.is_set(), "offline": self.server.offline}
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        if self.server.offline:
            self.close_connection = True
            return
        super().handle_request()


def send_http(host, path, *, identity=None, method="POST", mode="", body=b'{"model":"synthetic-only"}'):
    assert host in {"router1", "router2", "mock1", "mock2", "mock3", "mock4", "mock5"}
    connection = http.client.HTTPConnection(host, 8080, timeout=8)
    headers = {"Authorization": "Bearer synthetic-router-key", "X-API-Key": "synthetic-router-key",
               "X-Internal-Token": "synthetic-must-not-forward", "Content-Type": "application/json"}
    if identity is not None:
        headers["X-User-Identity"] = identity
    if mode:
        headers["X-Fixture-Mode"] = mode
    connection.request(method, path, body=body if method == "POST" else None, headers=headers)
    return connection, connection.getresponse()


def read(host, path="/fixture/state", **kwargs):
    connection, response = send_http(host, path, **kwargs)
    body = response.read()
    status, headers = response.status, dict(response.getheaders())
    connection.close()
    return status, headers, json.loads(body) if body else None


def counts():
    return [read("mock" + str(i), method="GET")[2]["requests"] for i in range(1, 6)]


def probe(router, char):
    identity = "sha256:" + char + "a" * 63
    status, _, body = read(router, "/v1/messages?fixture=1", identity=identity)
    assert status == 200
    assert body["backend"] == int("1111222333444555"[int(char, 16)])
    assert body["identity"] == identity
    assert body["authorization"] == "Bearer synthetic-router-key"
    assert body["apiKey"] == "synthetic-router-key" and body["internalToken"] is None
    assert body["path"] == "/v1/messages?fixture=1" and body["method"] == "POST"
    assert json.loads(body["body"]) == {"model": "synthetic-only"}
    return body["backend"]


def run(phase):
    started = time.monotonic()
    checks = []
    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)
    try:
        if phase in ("survivor", "recovered"):
            routers = ("router2",) if phase == "survivor" else ("router1", "router2")
            for router in routers:
                for char in "0123456789abcdef":
                    probe(router, char)
            passed(phase + " all 16 identities preserve pool mapping")
        elif phase == "denied":
            before = counts()
            for router in ("router1", "router2"):
                connection = http.client.HTTPConnection(router, 8080, timeout=8)
                connection.request("GET", "/v1/models", headers={"X-User-Identity": "sha256:" + "0" * 64,
                                                               "X-Forwarded-For": "172.31.250.30"})
                response = connection.getresponse()
                assert response.status == 403
                response.read(); connection.close()
            assert counts() == before
            passed("untrusted container rejected despite forged source header")
        else:
            for router in ("router1", "router2"):
                status, _, body = read(router, "/healthz", method="GET")
                assert status == 200 and body["scope"] == "router_process"
                for _ in range(2):
                    for char in "0123456789abcdef":
                        probe(router, char)
            passed("two real nginx containers route all 16 prefixes twice and preserve HTTP data")
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                values = list(pool.map(lambda item: probe(*item),
                    [(router, char) for router in ("router1", "router2") for char in "0123456789abcdef"]))
            assert len(values) == 32
            passed("concurrent requests across both routers preserve deterministic mapping")
            for router in ("router1", "router2"):
                before = counts()
                for identity in (None, "", "0" * 64, "sha256:" + "0" * 63, "sha256:" + "0" * 65,
                                 "sha256:" + "A" * 64, "SHA256:" + "0" * 64, "sha256:" + "g" * 64):
                    status, _, _ = read(router, "/v1/messages", identity=identity)
                    assert status == 400
                connection = http.client.HTTPConnection(router, 8080, timeout=8)
                connection.putrequest("GET", "/v1/models")
                connection.putheader("X-User-Identity", "sha256:" + "0" * 64)
                connection.putheader("X-User-Identity", "sha256:" + "a" * 64)
                connection.endheaders()
                response = connection.getresponse(); assert response.status == 400
                response.read(); connection.close()
                for method, path in (("GET", "/api/accounts"), ("POST", "/internal/accounts"),
                                     ("DELETE", "/v1/models"), ("POST", "/v1/responses")):
                    status, _, _ = read(router, path, method=method, identity="sha256:" + "0" * 64)
                    assert status == 404
                assert counts() == before
            passed("invalid duplicate identities and management paths never reach any backend")
            for router in ("router1", "router2"):
                for method, path in (("GET", "/v1/models"), ("HEAD", "/v1/models"),
                                     ("POST", "/chat/completions"), ("POST", "/responses"),
                                     ("POST", "/v1/messages/count_tokens")):
                    status, _, _ = read(router, path, method=method, identity="sha256:" + "0" * 64)
                    assert status == 200
            passed("both routers forward all supported methods and paths")
            for router in ("router1", "router2"):
                for code in (401, 429, 500, 502, 503):
                    before = counts()
                    status, headers, _ = read(router, "/v1/messages", identity="sha256:" + "0" * 64, mode=str(code))
                    assert status == code
                    if code == 429:
                        assert headers["Retry-After"] == "17"
                    assert [a-b for a,b in zip(counts(), before)] == [1,0,0,0,0]
            passed("401 429 5xx and Retry-After preserved with exactly one selected upstream attempt")
            for router in ("router1", "router2"):
                connection, response = send_http(router, "/v1/messages", identity="sha256:" + "0" * 64, mode="stream")
                assert response.status == 200 and response.getheader("Content-Type") == "text/event-stream"
                begin = time.monotonic()
                assert response.readline() == b"data: first\n" and time.monotonic()-begin < 0.6
                assert b"[DONE]" in response.read() and time.monotonic()-begin >= 1.4
                connection.close()
                connection, response = send_http(router, "/v1/messages", identity="sha256:" + "0" * 64, mode="truncate")
                try:
                    response.read()
                except http.client.IncompleteRead:
                    pass
                else:
                    raise AssertionError("incomplete upstream falsely completed")
                finally:
                    connection.close()
            passed("SSE events arrive incrementally and truncated bodies fail on both routers")
            for router, char, mock in (("router1", "0", "mock1"), ("router2", "4", "mock2")):
                before = counts()
                connection, response = send_http(router, "/v1/messages", identity="sha256:" + char * 64, mode="cancel")
                assert response.read(6) == b"data:x"
                response.close(); connection.close()
                deadline = time.monotonic()+4
                while not read(mock, method="GET")[2]["cancelled"]:
                    assert time.monotonic()<deadline
                    time.sleep(0.1)
                differences=[a-b for a,b in zip(counts(),before)]
                assert sum(differences)==1 and differences[int(mock[-1])-1]==1
            passed("client cancellation reaches only its selected backend")
            read("mock5", "/fixture/offline")
            before=counts()
            for router in ("router1", "router2"):
                connection,response=send_http(router,"/v1/messages",identity="sha256:"+"f"*64)
                assert response.status==502
                response.read();connection.close()
            assert counts()==before
            read("mock5", "/fixture/online")
            probe("router1","f");probe("router2","f")
            passed("selected upstream transport failure never switches pools; recovery keeps mapping")
        result={"status":"passed","phase":phase,"checks":checks,"elapsedSeconds":round(time.monotonic()-started,3)}
    except Exception as error:
        result={"status":"failed","phase":phase,"checks":checks,"error":type(error).__name__+": "+str(error),
                "elapsedSeconds":round(time.monotonic()-started,3)}
    print(json.dumps(result),flush=True)
    Path('/reports/'+phase+'.json').write_text(json.dumps(result,indent=2))
    if result['status']!='passed': raise SystemExit(1)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['mock','base','denied','survivor','recovered'])
    parser.add_argument('--index',type=int,choices=range(1,6))
    args=parser.parse_args()
    if os.environ.get('GHCP_ROUTER_SYNTHETIC_TEST')!='1':
        parser.error('Synthetic fixture opt-in required')
    if args.mode=='mock':
        if args.index is None: parser.error('mock index required')
        backend=Backend(('0.0.0.0',8080),ContainerMock)
        backend.index,backend.requests,backend.lock=args.index,0,threading.Lock()
        backend.connections=set();backend.client_cancelled=threading.Event();backend.offline=False
        backend.serve_forever()
    else:
        run(args.mode)


if __name__=='__main__': main()
