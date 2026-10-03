#!/usr/bin/env bash
# One-time, operator-run host preparation for an exe.dev VM. Idempotent.
# Creates the unprivileged control user and directories only; it installs no
# credentials, enables nothing that runs the bot, and starts no services.
set -euo pipefail
umask 0022
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
for tool in node git systemctl useradd bun; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' ||
    { echo "node >= 22.12 required" >&2; exit 1; }
[[ $(bun --version) =~ ^1\.([4-9]|[1-9][0-9])\. ]] ||
    { echo "bun >= 1.4 required (install it at /usr/local/bin/bun)" >&2; exit 1; }

getent passwd ghbot >/dev/null ||
    useradd --system --user-group --create-home --home-dir /var/lib/opencode-github-bot \
        --shell /usr/sbin/nologin ghbot

install -d -o root -g root -m 0755 /srv/opencode-github-bot /srv/opencode-github-bot/releases
install -d -o ghbot -g ghbot -m 0700 /etc/opencode-github-bot
install -d -o ghbot -g ghbot -m 0700 /var/lib/opencode-github-bot
install -d -o ghbot -g ghbot -m 0700 /var/lib/opencode-github-bot/workspace-requests
install -d -o root -g root -m 0755 /workspaces
# Mount point for each executor's private BindPaths; empty on the host.
install -d -o root -g root -m 0755 /workspace

echo "Host prepared. Install secrets in /etc/opencode-github-bot (mode 0600, owner ghbot),"
echo "write /etc/opencode-github-bot/runtime.env, then run deploy/exe/deploy.ts."
