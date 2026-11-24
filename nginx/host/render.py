#!/usr/bin/env python3
"""Print a single http-context site configuration; installing it is a separate step."""
import argparse
import re
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent


def domain(value):
    labels = value.split(".")
    if len(value) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
    ):
        raise argparse.ArgumentTypeError("expected a lowercase DNS name")
    return value


def directory(value):
    path = PurePosixPath(value)
    public_bases = (PurePosixPath("/srv"), PurePosixPath("/var/www"))
    if (not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value) or str(path) != value
            or ".." in path.parts or not any(base in path.parents for base in public_bases)):
        raise argparse.ArgumentTypeError("expected a dedicated directory under /srv or /var/www")
    return value


def port(value):
    if not re.fullmatch(r"[1-9][0-9]{0,4}", value) or int(value) > 65535:
        raise argparse.ArgumentTypeError("expected a port from 1 to 65535")
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", type=domain, required=True)
    parser.add_argument("--cert-name", required=True)
    parser.add_argument("--release-root", type=directory, required=True)
    parser.add_argument("--acme-root", type=directory, required=True)
    parser.add_argument("--api-port", type=port, default=14100)
    parser.add_argument("--http-port", type=port)
    parser.add_argument("--https-port", type=port)
    parser.add_argument("--candidate", action="store_true", help="listen only on loopback")
    parser.add_argument("--mode", choices=("preview", "live", "maintenance"), default="preview")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", args.cert_name):
        parser.error("invalid Certbot lineage name")
    if any(PurePosixPath(x).is_relative_to(PurePosixPath(y))
           for x, y in ((args.release_root, args.acme_root), (args.acme_root, args.release_root))):
        parser.error("public files and ACME challenges must have separate roots")
    http = args.http_port or (18080 if args.candidate else 80)
    https = args.https_port or (18443 if args.candidate else 443)
    if args.api_port < 1024 or len({http, https, args.api_port}) != 3 or (args.candidate and min(http, https) < 1024):
        parser.error("pick separate ports and unprivileged candidate listeners")
    template = (HERE / "site.conf.in").read_text()
    routes = "    return 503;\n"
    if args.mode != "maintenance":
        routes = (HERE / "static.conf.in").read_text()
        if args.mode == "preview":
            routes = "    if ($request_method !~ ^(GET|HEAD)$) { return 503; }\n" + routes
            routes += "    location / { return 503; }\n"
        else:
            template = "limit_req_zone $binary_remote_addr zone=client_review_login:1m rate=10r/m;\n\n" + template
            routes += (HERE / "live.conf.in").read_text()
    prefix = "127.0.0.1:" if args.candidate else ""
    fields = {
        "DOMAIN": args.domain, "CERT_NAME": args.cert_name,
        "HTTPS_AUTHORITY": args.domain if https == 443 else f"{args.domain}:{https}",
        "HTTP_LISTEN": f"{prefix}{http}", "HTTPS_LISTEN": f"{prefix}{https}",
        "HTTP_IPV6": "" if args.candidate else f"listen [::]:{http};",
        "HTTPS_IPV6": "" if args.candidate else f"listen [::]:{https} ssl;",
        "ACME_ROOT": args.acme_root, "RELEASE_ROOT": args.release_root, "API_PORT": str(args.api_port),
    }
    template = f"# review-mode: {args.mode}\n" + template.replace("@ROUTES@", routes.rstrip())
    print(re.sub(r"@([A-Z0-9_]+)@", lambda match: fields[match[1]], template), end="")


if __name__ == "__main__":
    main()
