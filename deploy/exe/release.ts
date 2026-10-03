/** Root shell script that builds, activates and health-checks one release. */
export function remoteScript(commit: string, sha256: string, upload: string) {
    return `set -euo pipefail
umask 0022
readonly commit=${commit}
readonly upload=${upload}
readonly root=/srv/opencode-github-bot
readonly release="$root/releases/$commit"
readonly marker="$release/.release"
trap 'rm -f -- "$upload"' EXIT
[[ $EUID -eq 0 && -d $root && ! -L $root ]] || exit 1
getent passwd ghbot >/dev/null || { echo "run deploy/exe/host-setup.sh first" >&2; exit 1; }
printf '%s  %s\\n' ${sha256} "$upload" | sha256sum --check --strict --status
exec 9>"$root/.deploy.lock"
flock -n 9

built=false
if [[ ! -f $marker ]]; then
    rm -rf -- "$release"
    install -d -o ghbot -g ghbot -m 0755 "$release"
    tar --extract --file "$upload" --directory "$release" --no-same-owner --no-same-permissions --touch
    chown -R ghbot:ghbot "$release"
    systemd-run --quiet --wait --pipe --collect --unit="opencode-github-bot-build-$commit" \\
        --uid=ghbot --gid=ghbot \\
        --property=NoNewPrivileges=true --property=PrivateTmp=true --property=PrivateDevices=true \\
        --property=ProtectSystem=strict --property=ProtectHome=true --property=CapabilityBoundingSet= \\
        --property=RuntimeMaxSec=12m \\
        --property="InaccessiblePaths=/etc/opencode-github-bot /var/lib/opencode-github-bot -/workspaces -/run/opencode-github-bot-workspaces" \\
        --property="ReadWritePaths=$release" --property="WorkingDirectory=$release" \\
        /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$release/.home" TMPDIR="$release/.tmp" \\
        /bin/bash -c 'set -euo pipefail; mkdir -p .home .tmp
            bun install --frozen-lockfile --production --cache-dir .cache
            bun run build.ts
            rm -rf .home .tmp .cache'
    chown -R -h root:root "$release"
    chmod -R go-w "$release"
    [[ -z $(find "$release" ! -user root -print -quit) ]]
    printf '%s' "$commit" > "$marker"
    built=true
fi
[[ -f $release/dist/main.mjs && -f $release/dist/workspace.mjs ]]

for unit in "$release"/deploy/exe/systemd/*; do
    install -o root -g root -m 0644 "$unit" /etc/systemd/system/
done
systemctl daemon-reload

previous=$(readlink "$root/current" 2>/dev/null || true)
prune() {
    for candidate in "$root"/releases/*; do
        name=\${candidate##*/}
        [[ $name =~ ^[a-f0-9]{40}$ && $name != "$commit" && "releases/$name" != "$previous" ]] || continue
        if [[ -f $candidate/.release ]]; then rm -rf -- "$candidate"; fi
    done
    return 0
}
if [[ ! -f /etc/opencode-github-bot/runtime.env ]]; then
    prune
    echo "{\\"commit\\":\\"$commit\\",\\"built\\":$built,\\"activated\\":false}"
    exit 0
fi
port=$(sed -n 's/^GITHUB_BOT_LISTEN_PORT=\\([0-9]\\{1,5\\}\\)$/\\1/p' /etc/opencode-github-bot/runtime.env)
port=\${port:-8080}

switch() {
    ln -sfn "$1" "$root/.current-next"
    mv -Tf -- "$root/.current-next" "$root/current"
}
restart() {
    systemctl enable --now opencode-github-bot-provision.path >/dev/null
    systemctl enable --now opencode-github-bot-cleanup.timer >/dev/null
    systemctl restart opencode-github-bot.service
    for unit in $(systemctl list-units --plain --no-legend --state=active 'opencode-github-bot-workspace@*.service' | awk '{print $1}'); do
        systemctl restart "$unit"
    done
    for _ in $(seq 30); do
        curl --fail --silent --max-time 1 "http://127.0.0.1:$port/health" >/dev/null && return 0
        sleep 1
    done
    return 1
}
switch "releases/$commit"
if ! restart; then
    if [[ -n $previous ]]; then switch "$previous"; restart || true
    else rm -f -- "$root/current"; systemctl stop opencode-github-bot.service || true; fi
    echo "deployment failed health check; rolled back" >&2
    exit 1
fi
systemctl enable opencode-github-bot.service >/dev/null
prune
echo "{\\"commit\\":\\"$commit\\",\\"built\\":$built,\\"activated\\":true}"
`;
}
