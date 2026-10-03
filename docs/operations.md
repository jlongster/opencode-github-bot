# Operations

Nothing here has been run against a live VM, GitHub App or provider. Each
live step requires James's explicit approval.

## Configuration

`/etc/opencode-github-bot/runtime.env` (owner `ghbot`, mode `0600`) holds
non-secret settings:

```sh
GITHUB_BOT_LISTEN_HOST=127.0.0.1         # or 0.0.0.0 behind the exe.dev proxy
GITHUB_BOT_LISTEN_PORT=8080
GITHUB_BOT_PUBLIC_ORIGIN=https://<vm>.exe.xyz
GITHUB_APP_ID=<id>
GITHUB_APP_SLUG=<slug>                   # mention @<slug>, login <slug>[bot]
GITHUB_APP_PRIVATE_KEY_PATH=/etc/opencode-github-bot/app.pem
GITHUB_WEBHOOK_SECRET_PATH=/etc/opencode-github-bot/webhook-secret
GITHUB_ALLOWED_INSTALLATIONS=<id>[,<id>]
# Numeric GitHub user IDs (gh api users/<login> --jq .id); everyone else is
# ignored. Required and non-empty.
GITHUB_ALLOWED_USERS=<id>[,<id>]
OPENCODE_MODEL=<provider>/<model>
GITHUB_BOT_STATE_DIRECTORY=/var/lib/opencode-github-bot
GITHUB_BOT_WORKSPACE_SOCKETS=/run/opencode-github-bot-workspaces
GITHUB_BOT_MAX_CONCURRENT_TURNS=4
# Optional: GITHUB_API_URL, GITHUB_GIT_URL
```

Secret files must be regular, owner-only files (`0600`, owner `ghbot`).
OpenCode provider credentials live in OpenCode's state under
`GITHUB_BOT_STATE_DIRECTORY`; they are never placed in workspaces or prompts.

GitHub App permissions: pull requests (read/write), issues (read/write),
contents (read), metadata (read). Events: issue comment, pull request review
comment. Webhook URL: `<public origin>/github/webhook`.

## Host

VM `opencode-github-bot.exe.xyz`, created from the Anomaly devbox image
`ghcr.io/anomalyco/devbox@sha256:182c7b24…` (Arch, systemd, Node, git; login
user `anomaly` with sudo). The image's Bun 1.3 cannot read the lockfile, so the
official Bun 1.4.2 release is installed at `/usr/local/bin/bun` (checksum
verified), ahead of `/usr/bin/bun` on every PATH the deploy uses. exe.dev's HTTPS proxy currently targets
port 80; point it at `GITHUB_BOT_LISTEN_PORT` (or listen on 80 with
`GITHUB_BOT_LISTEN_HOST=0.0.0.0`) when activating.

Note: `exe.dev new --image=<digest>` substituted the current build for the
`boldsoftware/exeuntu` image; always verify `/exe.dev/etc/image.conf` against
the registry after creating a VM.

## Host setup (once, as root)

Requires Node ≥ 22.12, Bun ≥ 1.4, git and systemd. Done on `opencode-github-bot`.

```sh
bash deploy/exe/host-setup.sh
```

Creates `ghbot`, `/srv/opencode-github-bot`, `/etc/opencode-github-bot`,
`/var/lib/opencode-github-bot`, `/workspaces` and the empty `/workspace`
mount point. It installs no credentials and starts nothing.

## Deploy

```sh
bun deploy/exe/deploy.ts <ssh-destination>
```

Requires a clean worktree. Uploads `git archive HEAD`, builds it as `ghbot` in
a sandbox under `/srv/opencode-github-bot/releases/<commit>`, makes it
root-owned, installs the units, switches `current`, restarts the control
service and active workspace executors, and checks `/health`. A failed health
check restores the previous release. Without `runtime.env` the release is
staged only. The current and previous releases are kept.

## Model credentials

Import an OpenCode credential (`{ integrationID, label, value }`) into the
bot's OpenCode state while the service is stopped:

```sh
sudo -u ghbot node /srv/opencode-github-bot/current/dist/import-credential.mjs \
    /var/lib/opencode-github-bot /var/lib/opencode-github-bot/credential.json
```

The file must be `0600` and owned by `ghbot`; it is deleted after import. The
command prints the provider's model IDs, never credential values.

## State

| Path                                           | Contents                                  |
| ---------------------------------------------- | ----------------------------------------- |
| `/var/lib/opencode-github-bot/bot.sqlite`      | deliveries, conversations, inbox, outbox  |
| `/var/lib/opencode-github-bot/opencode.sqlite` | OpenCode sessions and events              |
| `/var/lib/opencode-github-bot/mirrors/`        | control-owned bare repository mirrors     |
| `/workspaces/<id>/`                            | per-conversation workspace (`ghb-<id>`)   |

Releases contain no state. Back up the state directory and `/workspaces`
together.

## User allowlist

The live allowlist is the Anomaly team from `anomalyco/opencode`
`.github/TEAM_MEMBERS` (dev branch), resolved to numeric IDs on 2026-10-03.
`runtime.env` lists each ID with its username in a comment. To refresh it,
resolve each username with `gh api users/<login> --jq .id`, replace the
allowlist block in `runtime.env` (keep owner `ghbot`, mode `0600`) and run
`sudo systemctl restart opencode-github-bot`. Someone who renames their
account keeps access; whoever claims their old username does not.

## Workspace cleanup

`opencode-github-bot-cleanup.timer` runs daily (missed runs happen at the next
boot) and deletes workspaces of pull requests closed over seven days. Run it
by hand with `sudo systemctl start opencode-github-bot-cleanup.service`; see
results with `journalctl -u opencode-github-bot-cleanup`. Failed deletions are
left as `workspace-requests/<id>.failed`.

## Checks after a deployment

```sh
curl -fsS http://127.0.0.1:8080/health
systemctl status opencode-github-bot opencode-github-bot-provision.path
systemctl list-timers opencode-github-bot-cleanup.timer
journalctl -u opencode-github-bot -n 50
```

Logs never contain comment bodies, prompts, replies or credentials.
