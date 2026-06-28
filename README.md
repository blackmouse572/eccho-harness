# eccho-harness

A GitHub bot harness for automated PR review and issue triage.

## Setup

```bash
bun install
bun run index.ts
```

## GitHub Commands

### PR Review

Post a comment on any pull request:

| Comment | Action |
|---|---|
| `/review` | Incremental review (changes since last review) |
| `/full-review` | Full review of all PR changes |

The bot reacts 👀 to acknowledge it received the command. Replies to inline review thread comments are automatically routed back to the reviewer.

### Issue Triage

Post a comment on any issue:

| Comment | Action |
|---|---|
| `/triage` | Auto-detect directive and triage |
| `/triage needs-triage` | Mark as needing triage |
| `/triage needs-info` | Mark as needing more info |
| `/triage ready-for-agent` | Mark as ready for agent |
| `/triage ready-for-human` | Mark as ready for human |
| `/triage wontfix` | Mark as wontfix |

## Automatic Triggers

| Event | Action |
|---|---|
| PR opened / reopened | Full review |
| PR new commits pushed | Posts a comment with available review commands |
| Issue opened | Classify issue |

## Webhook Setup

Subscribe your GitHub repo to these event types: **Pull requests**, **Issue comments**, **Pull request review comments**.

Webhook path: `POST /channels/github/webhook`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | Authenticates inbound webhook deliveries |
| `GITHUB_BOT_LOGIN` | no | PAT account login to prevent self-triggered loops |
| `REVIEW_BOT_PRS` | no | Set `true` to review Dependabot/Renovate PRs (default: skip) |
