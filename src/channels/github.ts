// flue-blueprint: channel/github@1
import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import prReviewer from '../agents/pr-reviewer.ts';
import issueClassifier from '../agents/issue-classifier.ts';
import issueTriager from '../agents/issue-triager.ts';
import { createPullRequestGateway } from '../shared/pull-requests.ts';

// The bot authenticates with a PAT, so its OWN comments arrive as sender type
// `User`, not `Bot`. Without this, the bot would react to (and loop on) its own
// reviews/replies. Set GITHUB_BOT_LOGIN to the PAT account's login to skip them.
const BOT_LOGIN = process.env.GITHUB_BOT_LOGIN?.toLowerCase();
function isSelf(sender: { type: string; login: string }): boolean {
	return sender.type === 'Bot' || (!!BOT_LOGIN && sender.login.toLowerCase() === BOT_LOGIN);
}

// Don't review PRs opened by bots (Dependabot, Renovate, …) — dependency bumps
// are config-only noise. Set REVIEW_BOT_PRS=true to opt back in.
const REVIEW_BOT_PRS = process.env.REVIEW_BOT_PRS === 'true';

// Deterministic acknowledgment: react 👀 on the incoming comment so the user
// immediately sees it's being processed. A guaranteed pipeline step, not left to
// the agent to remember. Best-effort — never block admission on it.
async function ackProcessing(
	ref: { owner: string; repo: string; pr: number },
	commentId: number,
	commentType: 'issue' | 'review',
): Promise<void> {
	try {
		await createPullRequestGateway({ owner: ref.owner, repo: ref.repo, issueNumber: ref.pr }).react({
			commentId,
			commentType,
			content: 'eyes',
		});
	} catch {
		// ignore — the signal is best-effort
	}
}

// Verified GitHub webhook ingress. `GITHUB_WEBHOOK_SECRET` authenticates inbound
// deliveries; outbound Octokit calls live in ../shared/pull-requests.ts.
//
// Webhook path: /channels/github/webhook
// Subscribe in GitHub to: "Pull requests", "Issue comments", and
// "Pull request review comments".
export const channel = createGitHubChannel({
	webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

	async webhook({ delivery }): Promise<undefined> {
		// --- New / reopened PR, or new commits pushed to a PR -----------------
		if (delivery.name === 'pull_request') {
			const { action } = delivery.payload;
			const { repository, pull_request } = delivery.payload;
			if (pull_request.user?.type === 'Bot' && !REVIEW_BOT_PRS) return; // skip Dependabot/Renovate
			const owner = repository.owner.login;
			const repo = repository.name;
			const ref = { owner, repo, issueNumber: pull_request.number };
			const id = channel.conversationKey(ref);

			if (action === 'opened' || action === 'reopened') {
				await dispatch(prReviewer, {
					id,
					input: {
						type: 'github.pull_request.review',
						command: 'full',
						deliveryId: delivery.deliveryId,
						owner,
						repo,
						pr: pull_request.number,
						base: pull_request.base.sha,
						head: pull_request.head.sha,
						reason: `Pull request ${action}.`,
					},
				});
				return;
			}

			if (action === 'synchronize') {
				await dispatch(prReviewer, {
					id,
					input: {
						type: 'github.pull_request.review',
						command: 'incremental',
						deliveryId: delivery.deliveryId,
						owner,
						repo,
						pr: pull_request.number,
						before: delivery.payload.before,
						after: delivery.payload.after,
						reason: 'New commits pushed to the pull request.',
					},
				});
				return;
			}
			return;
		}

		// --- Comment command on a PR: "review" or "full review" ---------------
		if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
			const { repository, issue, comment, sender } = delivery.payload;
			if (!issue.pull_request) return; // PRs only
			if (isSelf(sender)) return; // never react to ourselves

			const normalized = comment.body.trim().toLowerCase().replace(/^\//, '').trim();
			const command =
				normalized === 'full review' ? 'full' : normalized === 'review' ? 'incremental' : null;
			if (!command) return; // non-command conversation comments are ignored

			const owner = repository.owner.login;
			const repo = repository.name;
			await ackProcessing({ owner, repo, pr: issue.number }, comment.id, 'issue');
			await dispatch(prReviewer, {
				id: channel.conversationKey({ owner, repo, issueNumber: issue.number }),
				input: {
					type: 'github.pull_request.review',
					command,
					deliveryId: delivery.deliveryId,
					owner,
					repo,
					pr: issue.number,
					reason: `"${normalized}" command from @${sender.login}.`,
				},
			});
			return;
		}

		// --- User reply inside an inline review thread ------------------------
		if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
			const { repository, pull_request, comment, sender } = delivery.payload;
			if (isSelf(sender)) return;
			// Only replies within an existing thread — not fresh top-level comments.
			if (!comment.in_reply_to_id) return;

			const owner = repository.owner.login;
			const repo = repository.name;
			await ackProcessing({ owner, repo, pr: pull_request.number }, comment.id, 'review');
			await dispatch(prReviewer, {
				id: channel.conversationKey({ owner, repo, issueNumber: pull_request.number }),
				input: {
					type: 'github.pull_request.reply',
					command: 'reply',
					deliveryId: delivery.deliveryId,
					owner,
					repo,
					pr: pull_request.number,
					reason: `Reply from @${sender.login} on an inline review thread.`,
					comment: {
						type: 'review_comment',
						commentId: comment.id,
						inReplyToId: comment.in_reply_to_id,
						path: comment.path,
						body: comment.body,
					},
				},
			});
			return;
		}

		// Any other verified delivery: acknowledged with an empty success.
	},
});
