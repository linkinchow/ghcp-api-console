"""通过预览工具启动的真实 NGINX 本地功能验证；仅连接五个回环模拟后端。"""

import argparse
import http.client
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("hash_router_render", Path(__file__).with_name("render.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class Backend(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        with self.lock:
            self.connections.add(connection)
        return connection, address

    def close_connections(self):
        with self.lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

    def shutdown_request(self, connection):
        with self.lock:
            self.connections.discard(connection)
        super().shutdown_request(connection)


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.handle_request()

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with self.server.lock:
            self.server.requests += 1
        mode = self.headers.get("X-Fixture-Mode", "")
        if mode == "stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for data in (b"data: first\n\n", b"data: [DONE]\n\n"):
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
                time.sleep(0.8)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return
        if mode == "cancel":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                for _ in range(50):
                    self.wfile.write(b"6\r\ndata:x\r\n")
                    self.wfile.flush()
                    time.sleep(0.1)
            except OSError:
                self.server.client_cancelled.set()
            finally:
                self.close_connection = True
            return
        if mode == "truncate":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"data: incomplete\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        status = int(mode) if mode in ("401", "429", "500", "502", "503") else 200
        payload = json.dumps({"backend": self.server.index, "path": self.path, "method": self.command,
                              "body": body.decode(), "identity": self.headers.get("X-User-Identity"),
                              "authorization": self.headers.get("Authorization"),
                              "apiKey": self.headers.get("X-API-Key"),
                              "internalToken": self.headers.get("X-Internal-Token")}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if status == 429:
            self.send_header("Retry-After", "17")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)


def request(port, identity=None, path="/v1/messages", method="POST", mode="", body=b'{"model":"fixture-only"}'):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    headers = {"Authorization": "Bearer synthetic-router-key", "X-API-Key": "synthetic-router-key",
               "X-Internal-Token": "synthetic-must-not-forward", "Content-Type": "application/json"}
    if identity is not None:
        headers["X-User-Identity"] = identity
    if mode:
        headers["X-Fixture-Mode"] = mode
    connection.request(method, path, body=body if method == "POST" else None, headers=headers)
    response = connection.getresponse()
    return connection, response


def verify(nginx, port, report, stop):
    backends = []
    child = None
    prefix = Path(tempfile.mkdtemp(prefix="ghcp-hash-router-runtime-"))
    checks = []
    failure = None
    env = {name: os.environ[name] for name in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP") if name in os.environ}

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        (prefix / "logs").mkdir()
        for index in range(1, 6):
            backend = Backend(("127.0.0.1", 0), MockHandler)
            backend.index, backend.requests, backend.lock = index, 0, threading.Lock()
            backend.connections = set()
            backend.client_cancelled = threading.Event()
            backends.append(backend)
            threading.Thread(target=backend.serve_forever, daemon=True).start()
        config = renderer.render({"backends": [f"127.0.0.1:{server.server_port}" for server in backends],
                                  "trustedCidrs": ["127.0.0.1/32"]})
        config = config.replace("worker_processes auto;", "worker_processes 1;")
        config = config.replace("listen 8080;", f"listen 127.0.0.1:{port};")
        config = config.replace("/tmp/", prefix.as_posix() + "/")
        config = config.replace("error_log stderr warn;", "error_log logs/error.log warn;")
        (prefix / "nginx.conf").write_text(config, encoding="utf-8")
        command = [str(nginx), "-p", prefix.as_posix() + "/", "-c", "nginx.conf"]
        tested = subprocess.run([*command, "-t"], cwd=prefix, env=env, capture_output=True, timeout=15)
        if tested.returncode:
            print(tested.stderr.decode(errors="replace"), flush=True)
            raise AssertionError("nginx configuration test failed")
        passed("real nginx -t")
        child = subprocess.Popen([*command, "-g", "daemon off;"], cwd=prefix, env=env)
        deadline = time.monotonic() + 12
        while True:
            if child.poll() is not None:
                raise AssertionError("nginx exited during startup")
            try:
                connection, response = request(port, path="/healthz", method="GET")
                assert response.status == 200
                response.read(); connection.close()
                break
            except (OSError, http.client.HTTPException):
                if time.monotonic() > deadline:
                    raise AssertionError("nginx did not become healthy")
                time.sleep(0.1)
        expected = "1111222333444555"
        for repeat in range(2):
            for char, dest in zip("0123456789abcdef", expected):
                identity = "sha256:" + char + "a" * 63
                connection, response = request(port, identity, path="/v1/messages?fixture=1")
                assert response.status == 200
                result = json.loads(response.read()); connection.close()
                assert result["backend"] == int(dest)
                assert result["identity"] == identity
                assert result["path"] == "/v1/messages?fixture=1" and result["method"] == "POST"
                assert json.loads(result["body"]) == {"model": "fixture-only"}
                assert result["authorization"] == "Bearer synthetic-router-key"
                assert result["apiKey"] == "synthetic-router-key" and result["internalToken"] is None
        passed("all 16 hash prefixes route deterministically twice; headers method URI body preserved")
        count = sum(server.requests for server in backends)
        for identity in (None, "", "0" * 64, "sha256:" + "0" * 63, "sha256:" + "0" * 65,
                         "sha256:" + "A" * 64, "SHA256:" + "0" * 64, "sha256:" + "g" * 64):
            connection, response = request(port, identity)
            assert response.status == 400
            response.read(); connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
        connection.putrequest("GET", "/v1/models")
        connection.putheader("X-User-Identity", "sha256:" + "0" * 64)
        connection.putheader("X-User-Identity", "sha256:" + "a" * 64)
        connection.endheaders()
        response = connection.getresponse(); assert response.status == 400
        response.read(); connection.close()
        assert sum(server.requests for server in backends) == count
        passed("missing malformed uppercase and duplicate identities rejected without upstream")
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8, source_address=("127.0.0.2", 0))
        connection.request("GET", "/v1/models", headers={"X-User-Identity": "sha256:" + "0" * 64,
                                                        "X-Forwarded-For": "127.0.0.1"})
        response = connection.getresponse()
        assert response.status == 403
        response.read(); connection.close()
        assert sum(server.requests for server in backends) == count
        passed("untrusted source rejected even with forged X-Forwarded-For")
        identity = "sha256:" + "0" * 64
        for method, path in (("GET", "/api/accounts"), ("POST", "/internal/accounts"),
                             ("DELETE", "/v1/models"), ("POST", "/v1/responses"),
                             ("GET", "/v1/messages")):
            connection, response = request(port, identity, method=method, path=path)
            assert response.status == 404
            response.read(); connection.close()
        assert sum(server.requests for server in backends) == count
        passed("management and unsupported routes are not forwarded")
        for method, path in (("GET", "/v1/models"), ("HEAD", "/v1/models"), ("POST", "/responses"),
                             ("POST", "/chat/completions"), ("POST", "/v1/messages/count_tokens")):
            connection, response = request(port, identity, method=method, path=path)
            assert response.status == 200
            response.read(); connection.close()
        passed("all supported inference catalog and token-count routes pass")
        for status in (401, 429, 500, 502, 503):
            before = [server.requests for server in backends]
            connection, response = request(port, identity, mode=str(status))
            assert response.status == status
            if status == 429:
                assert response.getheader("Retry-After") == "17"
            response.read(); connection.close()
            assert [server.requests - n for server, n in zip(backends, before)] == [1, 0, 0, 0, 0]
        passed("401 429 and 5xx preserved; Retry-After preserved; no retries or other pools")
        connection, response = request(port, identity, mode="stream")
        assert response.status == 200 and response.getheader("Content-Type") == "text/event-stream"
        started = time.monotonic()
        first = response.readline()
        assert first == b"data: first\n" and time.monotonic() - started < 0.6
        rest = response.read(); connection.close()
        assert b"[DONE]" in rest and time.monotonic() - started >= 1.4
        passed("SSE first event arrives before completion and normal EOF preserved")
        connection, response = request(port, identity, mode="truncate")
        assert response.status == 200
        try:
            response.read()
        except http.client.IncompleteRead:
            pass
        else:
            raise AssertionError("truncated stream was accepted as complete")
        finally:
            connection.close()
        passed("truncated SSE remains incomplete, no replacement response")
        before = [server.requests for server in backends]
        connection, response = request(port, identity, mode="cancel")
        assert response.status == 200 and response.read(6) == b"data:x"
        response.close(); connection.close()
        assert backends[0].client_cancelled.wait(4), "client disconnect did not reach selected upstream"
        assert [server.requests - n for server, n in zip(backends, before)] == [1, 0, 0, 0, 0]
        passed("client cancellation closes selected upstream without replay")
        before = [server.requests for server in backends]
        backends[4].shutdown(); backends[4].server_close(); backends[4].close_connections()
        connection, response = request(port, "sha256:" + "f" * 64)
        assert response.status == 502
        response.read(); connection.close()
        assert [server.requests for server in backends] == before
        passed("unreachable selected pool returns 502 without switching pools")
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        print("FAIL " + failure, flush=True)
    finally:
        if child is not None and child.poll() is None:
            try:
                subprocess.run([str(nginx), "-p", prefix.as_posix() + "/", "-c", "nginx.conf", "-s", "quit"],
                               cwd=prefix, env=env, check=True, timeout=10, capture_output=True)
                child.wait(timeout=12)
            except Exception:
                failure = failure or "NGINX cleanup failed"
                child.terminate()
                child.wait(timeout=5)
        for backend in backends:
            backend.shutdown(); backend.server_close(); backend.close_connections()
        result = {"status": "failed" if failure else "passed", "checks": checks,
                  "failure": failure, "nginxExited": child is None or child.poll() is not None,
                  "mockListenersClosed": all(server.fileno() == -1 for server in backends),
                  "scope": "isolated loopback nginx + five synthetic backends", "evidenceDirectory": str(prefix)}
        report.update(result)
        (prefix / "report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result), flush=True)
        stop.set()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", type=Path, required=True)
    parser.add_argument("--confirm-local-fixture", action="store_true", required=True)
    parser.add_argument("--status-port", type=int, default=18129)
    parser.add_argument("--router-port", type=int, default=18128)
    args = parser.parse_args()
    if not args.nginx.is_file() or args.status_port == args.router_port:
        parser.error("Existing NGINX binary and distinct loopback ports required")
    report = {"status": "running"}
    completed = threading.Event()

    class StatusHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            payload = json.dumps(report).encode()
            self.send_response(200 if self.path == "/" else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", args.status_port), StatusHandler)
    thread = threading.Thread(target=verify, args=(args.nginx.resolve(), args.router_port, report, completed), daemon=True)
    def request_stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    lifetime = threading.Timer(180, request_stop)
    lifetime.daemon = True
    lifetime.start()
    thread.start()
    print(f"Local validation status on http://127.0.0.1:{args.status_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        thread.join(timeout=90)
        lifetime.cancel()
        server.server_close()


if __name__ == "__main__":
    main()
