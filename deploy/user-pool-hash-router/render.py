#!/usr/bin/env python3
"""离线生成五后端固定路由配置；不启动服务，不覆盖已有文件。"""

import argparse
import ipaddress
import json
from pathlib import Path
import re

TEMPLATE = Path(__file__).with_name("nginx.conf.template")


def endpoint(value):
    if not isinstance(value, str):
        raise ValueError("Each backend must be a host:port string")
    if value.startswith("["):
        match = re.fullmatch(r"\[([0-9a-fA-F:]+)\]:([0-9]{1,5})", value)
        if not match:
            raise ValueError("Invalid bracketed IPv6 backend")
        host = "[" + ipaddress.IPv6Address(match[1]).compressed + "]"
        port = int(match[2])
    else:
        match = re.fullmatch(r"([a-zA-Z0-9.-]+):([0-9]{1,5})", value)
        if not match:
            raise ValueError("Backend must be a bare host:port, without scheme, path or options")
        host = match[1].lower()
        port = int(match[2])
        if re.fullmatch(r"[0-9.]+", host):
            host = str(ipaddress.IPv4Address(host))
        elif len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                    for label in host.split(".")):
            raise ValueError("Invalid backend DNS name")
    if not 1 <= port <= 65535:
        raise ValueError("Backend port must be between 1 and 65535")
    return f"{host}:{port}"


def render(config):
    if not isinstance(config, dict) or set(config) != {"backends", "trustedCidrs"}:
        raise ValueError("Configuration must contain only backends and trustedCidrs")
    if not isinstance(config["backends"], list) or len(config["backends"]) != 5:
        raise ValueError("Exactly five backends are required")
    backends = [endpoint(value) for value in config["backends"]]
    if len(set(backends)) != 5:
        raise ValueError("Each backend must be distinct")
    if not isinstance(config["trustedCidrs"], list) or not config["trustedCidrs"]:
        raise ValueError("At least one explicit trusted source CIDR is required")
    networks = []
    for value in config["trustedCidrs"]:
        if not isinstance(value, str) or "/" not in value:
            raise ValueError("Trusted sources must be explicit CIDR strings")
        network = ipaddress.ip_network(value, strict=True)
        if network.prefixlen == 0:
            raise ValueError("An unrestricted source network is not allowed")
        networks.append(str(network))
    text = TEMPLATE.read_text(encoding="utf-8")
    for index, backend in enumerate(backends, 1):
        text = text.replace(f"REPLACE_BACKEND_{index}", backend)
    text = text.replace("REPLACE_TRUSTED_ALLOW_RULES", "\n            ".join(
        f"allow {network};" for network in networks))
    if "REPLACE_" in text:
        raise ValueError("Unresolved template marker")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        text = render(json.loads(args.config.read_text(encoding="utf-8")))
        with args.output.open("x", encoding="utf-8", newline="\n") as output:
            output.write(text)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Configuration generation failed ({type(error).__name__}); check input and new output path.\n")
    print("NGINX configuration generated; no services started.")


if __name__ == "__main__":
    main()
