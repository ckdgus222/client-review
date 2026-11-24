# Host nginx deployment

The production host can serve Review directly and use Docker for the API and database. The default TLS site mode is **preview**. The `live` mode opens sign-in and requires a separate release decision. Local Compose and restore rehearsals continue to use their own nginx.

## Candidate on an unused loopback port

1. Keep the currently running front proxy. Record active configuration, both Compose file lists and project names, image IDs, networking, restart policies, certificate renewal hook, mount points and the last good static release in a private operator directory. Make sure the original files can be restored.
2. Install the Ubuntu nginx package during an approved window with automatic startup suppressed for the install. Keep its system service stopped until the public ports are handed over. Choose distinct unused local ports for both backends and two common candidate listeners for both sites.
3. Use the existing Review project name, volumes and protected environment file. For a candidate, add the loopback API binding separately to the current deployment or use an isolated copy with a disposable DB and `MAIL_MODE=log`. Adding a binding to a running API recreates that container. Schedule this action or complete the rehearsal in isolation. Never test restore against live volumes.
4. On the final host, select `COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml`. Set `PUBLIC_URL`, `REVIEW_API_PORT` and `REVIEW_RELEASE_ROOT` in the protected server configuration. Keep the existing mail, database and backup settings. Check `docker compose config --quiet`, active services and bind addresses before starting. The default host overlay runs only `db` and `api`.
5. Provide an empty dedicated release directory outside the checkout. The deploy account must be able to write it and the nginx worker must be able to traverse and read its public files. The webroot for ACME is a separate directory. Use the exact webroot and lineage recorded by Certbot. No key contents belong in these settings.
6. From the intended clean commit run `python3 deploy/static-release.py prepare /srv/review-example` and then `python3 deploy/static-release.py activate /srv/review-example`. BuildKit produces the static site from that commit's tracked inputs. Repeating either command for the same commit is safe. Old HTML can load its hashed app assets from the previous release. Keep disk space available; remove older, unreferenced releases only after acceptance, under the release lock.
7. Generate a candidate **as the deploy user**. Example values below are placeholders.

```sh
candidate=$(mktemp)
python3 nginx/host/render.py --candidate --domain review.example.test \
  --cert-name review-example --release-root /srv/review-example \
  --acme-root /srv/acme-example --api-port 14100 > "$candidate"
```

Review the generated file locally. In a private candidate master configuration, load both candidate sites and a default server rejecting unknown hosts on the same temporary listeners. Use a separate pid and logs. Run `nginx -t -c <candidate-master>` before starting the isolated nginx process; do not reload the public front. Test with domain/SNI and a trusted certificate, e.g. `curl --resolve review.example.test:18443:127.0.0.1 https://review.example.test:18443/api/health`. Verify the Review site header and JSON body, demo interaction and fonts, policy pages and sign-in returning 503. For Dogwalk verify its own health payload, web/login, WebSocket upgrade, public pictures and private-file boundary. Test ACME through the HTTP candidate too.

## Controlled handover

Use an operator-approved window. Hold both applications' maintenance locks in a fixed order (Dogwalk, then Review). Coordinate cron and releases. Stop the candidate after successful tests; preserve the current production containers for rollback.

- Render each public vhost with the same inputs, omitting `--candidate`; use preview for Review. Install the **reviewed** output as regular root-owned files in `/etc/nginx/conf.d/review.conf` and `dogwalk.conf`. A single neutral default server handles unknown names. `default.conf.example` is its template. Disable any conflicting distribution default site. Keep the certificate keys under Certbot ownership.
- Provision the common operator helper as a root-owned executable outside Git. Create `/etc/nginx/host-ops` root-owned, mode 0700. Its regular file `domains` contains two lines, the Review name and then the Dogwalk name. Test the helper with both actual domain responses. Its lock is `/run/host-nginx/apply.lock`.
- Before enabling nginx at boot add a systemd drop-in with `ExecStartPre=/usr/local/sbin/host-nginx-apply recover` **before** the distribution's configuration test. Inspect the effective unit and, if it already declares an ExecStartPre test, reset that directive and re-list the recovery command followed by the original test. The recovery command restores the previous on-disk config after an interrupted transaction. The release owner must not have write access to the operator helper, hooks, configs or their parent directories.
- Prevent the old proxies from reclaiming 80/443 on restart, stop the container owning those ports, test and start the host nginx, then enable its system service. Update Certbot's deploy hook to call the trusted installed copy of `host-nginx-apply reload` in place of the old Docker callback. Preserve the webroot and certificate lineages. Check both hostnames from an external connection, including HTTP redirects and public access policy, and perform a renewal dry run with deploy hooks exercising the new command.
- For subsequent changes put a reviewed candidate in `/etc/nginx/host-ops/review.conf` or `dogwalk.conf` and run `host-nginx-apply apply review` or `apply dogwalk`. This tests the full configuration, reloads it and checks both HTTPS endpoints. Failure restores the previous file. To close only Review, render `--mode maintenance` for its vhost; other sites keep serving. Review's `deploy/update.sh` changes app containers and the static release without reloading the host.
- On a failed handover, stop/disable the host listener, restore the prior Compose inputs, image selections, proxy configs, restart policies and original renewal hook, then restore the original front first available with both backends on its expected networks. Restore the last working static release if it changed. Verify both hostnames and the prior access policy. Preserve the existing database and asset volumes throughout.
- After the next scheduled boot verify services, certificates, mount dependencies, both site checks and backup/restore operational checks. Keep legacy listeners disabled and available for rollback until those checks pass. Removing the old edge network requires checking all its remaining users.

The public repositories hold templates and synthetic test values only. Inspect the staged paths and diff before every commit. Real host settings, generated vhosts, private keys, OAuth material and operational records belong outside the worktree.
