#!/usr/bin/env bash
# Administrator-installed copy only. Read /etc/nginx/host-ops/domains in review, dogwalk order.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ops=/etc/nginx/host-ops
active=/etc/nginx/conf.d
pending=$ops/pending

fail() { echo "$1" >&2; exit 1; }
trusted() {
    [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] &&
        [ -z "$(find "$1" -maxdepth 0 -perm /022 -print)" ]
}
[ "$EUID" = 0 ] || fail "Administrator privileges required"
case "${1:-reload}:${2:-}" in
    apply:review|apply:dogwalk) action=apply ;;
    reload:|recover:) action=${1:-reload} ;;
    *) fail "Usage: apply.sh [reload | recover | apply review | apply dogwalk]" ;;
esac
[ "$#" -le 2 ] || fail "Unexpected arguments"
for dir in /etc/nginx "$ops" "$active"; do
    [ -d "$dir" ] && trusted "$dir" || fail "Expected a root-owned nginx directory"
done
install -d -m 0700 /run/host-nginx
exec 9>/run/host-nginx/apply.lock
flock -x 9

install_config() {
    local temp
    temp=$(mktemp "$active/.host-site.XXXXXXXX")
    install -m 0644 "$1" "$temp"
    mv -fT "$temp" "$2"
}

finish_transaction() {
    local retired
    retired=$(mktemp -d "$ops/.finished.XXXXXXXX")
    mv -T "$pending" "$retired/data"
    rm -f "$retired/data/site" "$retired/data/previous.conf"
    rmdir "$retired/data" "$retired"
}

# An old worker may keep a WebSocket open after reload. Wait only until it
# stops accepting new connections, not until all existing requests finish.
active_workers() {
    local master=$1 children pid title
    children=$(cat "/proc/$master/task/$master/children") || return 1
    for pid in $children; do
        IFS= read -r -d '' title 2>/dev/null < "/proc/$pid/cmdline" || continue
        if [[ "$title" = 'nginx: worker process' ]]; then echo "$pid"; fi
    done
}

reload_and_wait() {
    local master before after pid draining
    master=$(cat /run/nginx.pid) || return 1
    [[ "$master" =~ ^[1-9][0-9]*$ ]] || return 1
    before=$(active_workers "$master") || return 1
    [ -n "$before" ] || return 1
    systemctl reload nginx || return 1
    for attempt in {1..100}; do
        after=$(active_workers "$master") || return 1
        draining=true
        for pid in $before; do
            if [[ $'\n'"$after"$'\n' = *$'\n'"$pid"$'\n'* ]]; then draining=false; break; fi
        done
        if [ -n "$after" ] && [ "$draining" = true ]; then return 0; fi
        sleep 0.1
    done
    return 1
}

restore_pending() {
    local site
    [ -d "$pending" ] || return 0
    site=$(cat "$pending/site")
    case "$site" in review|dogwalk) ;; *) fail "Invalid pending transaction";; esac
    install_config "$pending/previous.conf" "$active/$site.conf"
    nginx -t
    if [ "$action" != recover ]; then
        reload_and_wait
        wait_for_sites || fail "Restored the previous file, but HTTPS recovery is unconfirmed"
    fi
    finish_transaction
}

probe_sites() {
    local host body code response wanted header_file
    local -a domains
    trusted "$ops/domains" || return 1
    mapfile -t domains < "$ops/domains"
    [ "${#domains[@]}" = 2 ] && [ "${domains[0]}" != "${domains[1]}" ] || return 1
    for host in "${domains[@]}"; do
        [[ "$host" =~ ^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$ ]] || return 1
        header_file=$(mktemp) || return 1
        if ! response=$(curl -q --noproxy '*' -sS --max-time 4 --resolve "$host:443:127.0.0.1" \
            -D "$header_file" -w $'\n%{http_code}' "https://$host/api/health"); then
            rm -f "$header_file"
            return 1
        fi
        if [ "$host" = "${domains[0]}" ] && ! tr -d '\r' < "$header_file" | grep -iqx 'X-Client-Review-Site: client-review'; then
            rm -f "$header_file"
            return 1
        fi
        rm -f "$header_file"
        code=${response##*$'\n'}
        body=${response%$'\n'*}
        if [ "$host" = "${domains[0]}" ]; then
            if grep -qx '# review-mode: maintenance' "$active/review.conf"; then
                [ "$code" = 503 ] || return 1
                continue
            fi
            wanted='{"status":"ok"}'
        else
            wanted='{"status":"ok","db":"up"}'
        fi
        [ "$code" = 200 ] && [ "$body" = "$wanted" ] || return 1
    done
}

wait_for_sites() {
    local attempt
    for attempt in {1..8}; do
        if probe_sites; then return 0; fi
        sleep 1
    done
    return 1
}

restore_pending
[ "$action" != recover ] || exit 0

if [ "$action" = apply ]; then
    site=$2
    dst=$active/$site.conf
    candidate=$ops/$site.conf
    for path in "$dst" "$candidate"; do
        [ -f "$path" ] && trusted "$path" || fail "Expected a reviewed root-owned site file"
    done
    backup=$(mktemp -d "$ops/.transaction.XXXXXXXX")
    cp "$dst" "$backup/previous.conf"
    echo "$site" > "$backup/site"
    mv -T "$backup" "$pending"
    trap 'rc=$?; if [ "$rc" -ne 0 ]; then restore_pending; fi' EXIT
    install_config "$candidate" "$dst"
fi
nginx -t
reload_and_wait
wait_for_sites || fail "The two HTTPS hosts did not pass their health checks"
if [ "$action" = apply ]; then finish_transaction; fi
