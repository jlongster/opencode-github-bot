#!/usr/bin/env bash
# Root-only. Triggered by opencode-github-bot-provision.path; never exposed to
# the control service or models beyond writing an opaque request file.
set -euo pipefail
umask 0077
[[ $EUID -eq 0 ]] || exit 1

queue=/var/lib/opencode-github-bot/workspace-requests
shopt -s nullglob

# Prints the workspace id of a valid request, or rejects it.
request_id() {
    local request=$1 name=${1##*/}
    local id=${name%.*}
    if [[ ! $id =~ ^[a-f0-9]{20}$ || -L $request || ! -f $request ]] ||
        [[ $(stat -c '%U:%a' "$request") != ghbot:600 ]]; then
        mv -T -- "$request" "$request.rejected"
        return 1
    fi
    printf '%s' "$id"
}

# Deletions first, so a reopened pull request's new request starts clean.
for request in "$queue"/*.delete; do
    id=$(request_id "$request") || continue
    user="ghb-${id}"
    home="/workspaces/${id}"
    systemctl disable --now "opencode-github-bot-workspace@${id}.socket" >/dev/null 2>&1 || true
    systemctl stop "opencode-github-bot-workspace@${id}.service" >/dev/null 2>&1 || true
    if getent passwd "$user" >/dev/null; then
        if [[ $(id -u "$user") -eq 0 ]]; then
            mv -T -- "$request" "$queue/${id}.failed"
            continue
        fi
        pkill -KILL -u "$user" || true
        for _ in 1 2 3 4 5; do pgrep -u "$user" >/dev/null || break; sleep 1; done
        if ! userdel "$user"; then
            mv -T -- "$request" "$queue/${id}.failed"
            continue
        fi
    fi
    ! getent group "$user" >/dev/null || groupdel "$user"
    if [[ -L $home ]]; then
        rm -f -- "$home"
    elif [[ -d $home ]]; then
        rm -rf --one-file-system -- "$home"
    fi
    rm -f -- "$request"
done

for request in "$queue"/*.request; do
    id=$(request_id "$request") || continue
    user="ghb-${id}"
    home="/workspaces/${id}"
    if ! getent passwd "$user" >/dev/null; then
        useradd --system --user-group --no-create-home \
            --home-dir "$home" --shell /usr/sbin/nologin "$user"
    fi
    if [[ $(id -u "$user") -eq 0 || $(id -Gn "$user") != "$user" ]]; then
        mv -T -- "$request" "$queue/${id}.failed"
        continue
    fi
    [[ -e $home || -L $home ]] || install -d -o "$user" -g "$user" -m 0700 "$home"
    if [[ ! -d $home || -L $home || $(stat -c '%U:%G:%a' "$home") != "$user:$user:700" ]]; then
        mv -T -- "$request" "$queue/${id}.failed"
        continue
    fi
    systemctl enable --now "opencode-github-bot-workspace@${id}.socket" >/dev/null
    rm -f -- "$request"
done
