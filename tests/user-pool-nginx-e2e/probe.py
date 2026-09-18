#!/usr/bin/env python3
"""Container-side stdlib HTTP probe. Fixed disposable service names, no external targets.
Raw virtual keys exist only in this process's memory and are revoked in finally.
"""
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

MODEL = "claude-opus-5-2"
TARGETS = {"gateway": "http://litellm:7000"}
for i in range(1, 6):
    TARGETS.update({f"pool{i}": f"http://pool{i}:3000", f"sso{i}": f"http://sso{i}:7001", f"mock{i}": f"http://mock{i}:8002"})
SECRET = None
DEADLINE = time.monotonic() + 590
CHECKS = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("unexpected_redirect")


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def ensure(condition, label):
    if not condition:
        raise RuntimeError(label)


def passed(label, **info):
    CHECKS.append({"check": label, "passed": True, **info})


def request(target, path, method="GET", body=None, headers=None):
    ensure(target in TARGETS and path.startswith("/") and not path.startswith("//"), "target_not_fixture")
    ensure(time.monotonic() < DEADLINE, "test_deadline")
    payload = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(TARGETS[target] + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        response = OPENER.open(req, timeout=min(35, max(1, DEADLINE - time.monotonic())))
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read(4 * 1024 * 1024 + 1)
        ensure(len(raw) <= 4 * 1024 * 1024, "response_too_large")
        text = raw.decode("utf-8")
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        return response.status, value, text, response.headers


def expect(response, code, label):
    ensure(response[0] == code, label + "_http_" + str(response[0]) + "_expected_" + str(code))
    return response[1]


def poll(read, predicate, seconds, label):
    end = min(DEADLINE, time.monotonic() + seconds)
    while time.monotonic() < end:
        try:
            result = read()
            if predicate(result):
                return result
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.5)
    raise RuntimeError(label + "_timeout")


def internal():
    return {"X-Internal-Token": SECRET["internal"]}


def master():
    return {"Authorization": "Bearer " + SECRET["master"]}


def pool(i, summary=False):
    return expect(request(f"pool{i}", "/api/user-pool" + ("/summary" if summary else ""), headers=internal()), 200, "pool_read")


def mock(i):
    return expect(request(f"mock{i}", "/test/state", headers=internal()), 200, "mock_read")


def settings(i, changes):
    previous = pool(i, True)["settings"]
    updated = expect(request(f"pool{i}", "/api/user-pool/settings", "PATCH", {"expectedVersion": previous["version"], "changes": changes}, internal()), 200, "settings_patch")
    ensure(updated["version"] == previous["version"] + 1, "settings_version")


def infer(key, marker, stream=False, spoof=None):
    headers = {"anthropic-version": "2023-06-01"}
    if key is not None:
        headers["Authorization"] = "Bearer " + key
    body = {"model": MODEL, "max_tokens": 16, "stream": stream,
            "messages": [{"role": "user", "content": 'Reply OK. POOL_TEST:' + json.dumps({"id": marker}, separators=(",", ":"))}]}
    if spoof:
        headers["X-User-Identity"] = "sha256:" + spoof
        body["metadata"] = {"user_id": "sha256:" + spoof, "user_api_key": spoof, "token": spoof, "hashed_token": spoof,
                            "headers": {"X-User-Identity": "sha256:" + spoof}, "ghcp_canary": True}
        body["extra_headers"] = {"x-user-identity": "sha256:" + spoof}
    return request("gateway", "/v1/messages", "POST", body, headers)


def success(response, stream):
    expect(response, 200, "inference")
    if not stream:
        data = response[1]
        ensure(data.get("model") == MODEL and data.get("content", [{}])[0].get("text") == "OK", "json_content_model")
        ensure(data.get("stop_reason") == "end_turn", "json_terminal")
        return
    ensure("text/event-stream" in response[3].get("Content-Type", ""), "sse_content_type")
    events = []
    for frame in re.split(r"\r?\n\r?\n", response[2]):
        lines = [line[5:].strip() for line in frame.splitlines() if line.startswith("data:")]
        if lines:
            events.append(json.loads("\n".join(lines)))
    ensure(any(e.get("type") == "message_stop" for e in events), "sse_terminal")
    ensure(not any(e.get("type") == "error" or e.get("error") for e in events), "sse_error")
    ensure(any(e.get("type") == "message_start" and e.get("message", {}).get("model") == MODEL for e in events), "sse_model")
    ensure("".join(e.get("delta", {}).get("text", "") for e in events) == "OK", "sse_content")


def snapshot():
    return [{"leases": pool(i)["leases"], "mock": mock(i)} for i in range(1, 6)]


def unchanged(before, after):
    # Compare full lease records as well as upstream activity (not just lease count).
    ensure([p["leases"] for p in before] == [p["leases"] for p in after], "denied_request_changed_leases")
    for old, new in zip(before, after):
        for field in ("inference", "counters", "seats", "tasks", "users"):
            ensure(old["mock"].get(field) == new["mock"].get(field), "denied_request_reached_backend_" + field)


def e2e():
    keys = []
    revoked = set()
    user = "nginx-e2e-" + secrets.token_hex(8)
    selected = {}
    try:
        # Every source is fresh and every callback terminates on its own pool's proxy alias.
        for i in range(1, 6):
            initial = pool(i)
            source = mock(i)
            ensure(initial["enabled"] and initial["counts"]["total"] == 0 and not initial["leases"], "pool_not_fresh")
            ensure(source["fixture"] and all(not source[k] for k in ("users", "tasks", "seats", "inference")), "mock_not_fresh")
            ensure(request(f"pool{i}", "/api/user-pool/summary")[0] == 401, "proxy_internal_auth_required")
            settings(i, {"idle_target": 2, "max_accounts": 4, "lease_seconds": 3600, "paused": 0})
            poll(lambda: pool(i, True), lambda p: p["counts"]["ready_idle"] == 2 and p["counts"]["provisioning"] == 0 and p["counts"]["total"] == 2, 90, "two_ready_pool" + str(i))
            settings(i, {"paused": 1})
            state = mock(i)
            c = state["counters"]
            ensure(c["scimCreates"] == c["taskPosts"] == c["callbacksSucceeded"] == 2 and c["callbacksFailed"] == c["scimConflicts"] == 0 and len(state["seats"]) == 2, "real_sso_prewarm_chain_pool" + str(i))
            passed("real_sso_prewarm_pool" + str(i), ready_idle=2, max_accounts=4, lease_seconds=3600, paused=True)
        result = request("gateway", "/user/new", "POST", {"user_id": user, "user_role": "internal_user", "auto_create_key": False}, master())
        ensure(result[0] == 200 and result[1].get("user_id") == user, "database_user_new")
        ensure(not result[1].get("key"), "auto_create_key_false_ignored")
        # Use real server-generated keys rather than assuming custom-key request support.
        # Worst case <=256 creates. Do not persist or print any key (even unused ones).
        for _ in range(256):
            data = expect(request("gateway", "/key/generate", "POST", {"user_id": user, "models": [MODEL], "duration": "15m"}, master()), 200, "database_key_generate")
            key = data.get("key")
            ensure(isinstance(key, str) and key.startswith("sk-"), "generated_key_missing")
            keys.append(key)
            digest = hashlib.sha256(key.encode()).hexdigest()
            if digest[0] in "047ad2":
                selected.setdefault(digest[0], (key, digest))
            if len(selected) == 6:
                break
        ensure(len(selected) == 6, "bounded_key_prefix_coverage_not_reached")
        passed("real_database_virtual_keys", generated=len(keys), accepted_prefixes="047ad", rejected_prefix="2")
        expected_ids = {}
        for prefix, i in zip("047ad", range(1, 6)):
            key, digest = selected[prefix]
            for repetition in range(2):
                for stream in (False, True):
                    marker = f"accepted-{prefix}-{repetition}-{'sse' if stream else 'json'}"
                    # Same synthetic identity persists through repeated JSON/SSE requests.
                    success(infer(key, marker, stream), stream)
                    expected_ids[marker] = i
            current = snapshot()
            matches = [(n + 1, lease) for n, state in enumerate(current) for lease in state["leases"] if lease.get("callerKeyHash") == "sha256:" + digest]
            ensure(len(matches) == 1 and matches[0][0] == i, "hash_routed_wrong_pool_" + prefix)
            lease = matches[0][1]
            ensure(lease["phase"] == "active", "lease_not_active")
            for marker, expected in expected_ids.items():
                records = [(n + 1, record) for n, state in enumerate(current) for record in state["mock"]["inference"] if record.get("marker") == marker]
                ensure(len(records) == 1 and records[0][0] == expected, "marker_duplicate_or_wrong_pool")
                if expected == i:
                    ensure(records[0][1]["identity"] == lease["memberIdentity"], "marker_member_identity_disagreement")
            passed("json_sse_sticky_identity_pool" + str(i), prefix=prefix, requests=4)
        base = snapshot()
        ensure(all(len(p["leases"]) == 1 for p in base), "one_lease_per_pool_required")
        # External spoofing must not substitute a server-authenticated hash or enroll prefix2.
        scenarios = [("genuine_noncanary", selected["2"][0], None, {403}),
                     ("missing_key", None, None, {401, 403}),
                     ("invalid_key", "sk-invalid-synthetic-" + secrets.token_hex(24), None, {401, 403}),
                     ("noncanary_spoof", selected["2"][0], selected["0"][1], {403}),
                     ("missing_spoof", None, selected["0"][1], {401, 403}),
                     ("invalid_spoof", "sk-invalid-synthetic-" + secrets.token_hex(24), selected["0"][1], {401, 403})]
        for label, key, spoof, codes in scenarios:
            response = infer(key, "denied-" + label, spoof=spoof)
            ensure(response[0] in codes, label + "_http_" + str(response[0]))
            unchanged(base, snapshot())
            passed(label + "_no_backend_no_lease", status=response[0])
        # A valid enrolled caller spoofing ANOTHER admitted hash still owns its original pool.
        success(infer(selected["4"][0], "accepted-spoof-other-pool", spoof=selected["0"][1]), False)
        final = snapshot()
        rows = [(i + 1, r) for i, p in enumerate(final) for r in p["mock"]["inference"] if r.get("marker") == "accepted-spoof-other-pool"]
        ensure(len(rows) == 1 and rows[0][0] == 2 and rows[0][1]["identity"] == final[1]["leases"][0]["memberIdentity"], "admitted_spoof_changed_identity")
        ensure(all(len(p["leases"]) == 1 for p in final), "admitted_spoof_extra_lease")
        passed("admitted_spoof_cannot_change_identity")
        expect(request("gateway", "/key/delete", "POST", {"keys": [selected["0"][1]]}, master()), 200, "revoke_key")
        revoked.add(selected["0"][0])
        before = snapshot()
        denied = infer(selected["0"][0], "denied-revoked-key", spoof=selected["4"][1])
        ensure(denied[0] in {401, 403}, "revoked_key_http_" + str(denied[0]))
        unchanged(before, snapshot())
        passed("revoked_genuine_key_no_backend_no_lease", status=denied[0])
    finally:
        # Reserve cleanup time even if a test assertion or request timed out.
        global DEADLINE
        DEADLINE = max(DEADLINE, time.monotonic() + 30)
        remaining = [key for key in keys if key not in revoked]
        if remaining:
            expect(request("gateway", "/key/delete", "POST", {"keys": [hashlib.sha256(key.encode()).hexdigest() for key in remaining]}, master()), 200, "revoke_all_generated_keys")
            revoked.update(remaining)
        if keys:
            passed("all_generated_keys_revoked", generated=len(keys), revoked=len(revoked))
        # DB is fresh and destroyed too; remove the synthetic user through genuine admin API.
        if keys:
            expect(request("gateway", "/user/delete", "POST", {"user_ids": [user]}, master()), 200, "delete_synthetic_user")
            passed("synthetic_user_deleted")
        keys.clear()
        selected.clear()


def main():
    global SECRET
    SECRET = json.loads(Path("/fixtures/secrets.json").read_text())
    mode = sys.argv[1]
    if mode == "wait-sso":
        i = int(sys.argv[2])
        poll(lambda: request(f"sso{i}", "/healthz"), lambda r: r[0] == 200, 60, "sso_ready")
    elif mode == "wait-pool":
        i = int(sys.argv[2])
        poll(lambda: request(f"pool{i}", "/readyz"), lambda r: r[0] == 200 and r[1].get("storage") == "mysql", 65, "mysql_proxy_ready")
    elif mode == "wait-gateway":
        poll(lambda: request("gateway", "/health/readiness"), lambda r: r[0] == 200 and isinstance(r[1], dict) and r[1].get("db") == "connected", 140, "litellm_ready")
    elif mode == "e2e":
        e2e()
    else:
        raise RuntimeError("unknown_probe_mode")


if __name__ == "__main__":
    status = 0
    try:
        main()
    except Exception as exc:
        label = str(exc) if isinstance(exc, RuntimeError) and re.fullmatch(r"[a-zA-Z0-9_]+", str(exc)) else type(exc).__name__
        CHECKS.append({"check": label, "passed": False})
        status = 1
    finally:
        for check in CHECKS:
            print("CHECK " + json.dumps(check), flush=True)
    raise SystemExit(status)
