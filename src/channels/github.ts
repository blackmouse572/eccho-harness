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

// Deterministic acknowledgment: react 👀 on the incoming PR comment so the user
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
		console.log(`[webhook] ${delivery.name} delivery=${delivery.deliveryId}`);

		// --- New / reopened PR, or new commits pushed to a PR -----------------
		if (delivery.name === 'pull_request') {
			const { action } = delivery.payload;
			const { repository, pull_request } = delivery.payload;
			const pr = `${repository.owner.login}/${repository.name}#${pull_request.number}`;

			if (pull_request.user?.type === 'Bot' && !REVIEW_BOT_PRS) {
				console.log(`[pull_request] skip bot PR ${pr} action=${action}`);
				return;
			}

			const owner = repository.owner.login;
			const repo = repository.name;
			const ref = { owner, repo, issueNumber: pull_request.number };
			const id = channel.conversationKey(ref);

			if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
				if (pull_request.draft) {
					console.log(`[pull_request] skip draft ${pr} action=${action}`);
					return;
				}
				console.log(`[pull_request] dispatch full review ${pr} action=${action} head=${pull_request.head.sha.slice(0, 7)}`);
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
				await createPullRequestGateway({ owner, repo, issueNumber: pull_request.number })
					.postComment('> Comment `/review` for an incremental review or `/full-review` for a full review.')
					.catch((err) => console.warn(`[pull_request] postComment failed ${pr}`, err));
				return;
			}

			if (action === 'synchronize') {
				console.log(`[pull_request] dispatch incremental review ${pr} before=${String(delivery.payload.before).slice(0, 7)} after=${String(delivery.payload.after).slice(0, 7)}`);
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

			console.log(`[pull_request] unhandled action=${action} ${pr}`);
			return;
		}

		// --- New issue opened -------------------------------------------------------
		if (delivery.name === 'issues') {
			const { action } = delivery.payload;
			const { repository, issue, sender } = delivery.payload;
			const issueRef = `${repository.owner.login}/${repository.name}#${issue.number}`;

			if (action !== 'opened') return;
			if (isSelf(sender)) {
				console.log(`[issues] skip self sender=${sender.login} ${issueRef}`);
				return;
			}
			if (issue.user?.type === 'Bot' && !REVIEW_BOT_PRS) {
				console.log(`[issues] skip bot issue ${issueRef}`);
				return;
			}

			const owner = repository.owner.login;
			const repo = repository.name;
			console.log(`[issues] dispatch classify ${issueRef} author=${sender.login}`);
			await dispatch(issueClassifier, {
				id: channel.conversationKey({ owner, repo, issueNumber: issue.number }),
				input: {
					command: 'classify',
					owner,
					repo,
					issue: issue.number,
					title: issue.title,
					body: issue.body ?? '',
					author: sender.login,
				},
			});
			return;
		}

		// --- Issue or PR comment ----------------------------------------------------
		if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
			const { repository, issue, comment, sender } = delivery.payload;
			const ref = `${repository.owner.login}/${repository.name}#${issue.number}`;

			if (isSelf(sender)) {
				console.log(`[issue_comment] skip self sender=${sender.login} ${ref}`);
				return;
			}

			if (!issue.pull_request) {
				// Issue comment — /triage command
				const body = comment.body.trim();
				if (!body.toLowerCase().startsWith('/triage')) return;
				const rest = body.slice('/triage'.length).trim().toLowerCase();
				const directive = rest.split(/\s+/)[0] || undefined;
				const validDirectives = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];
				if (directive && !validDirectives.includes(directive)) {
					console.log(`[issue_comment] unknown triage directive="${directive}" ${ref}`);
					return;
				}
				const owner = repository.owner.login;
				const repo = repository.name;
				console.log(`[issue_comment] dispatch triage ${ref} directive=${directive ?? 'auto'} requester=${sender.login}`);
				await dispatch(issueTriager, {
					id: channel.conversationKey({ owner, repo, issueNumber: issue.number }),
					input: {
						command: 'triage',
						owner,
						repo,
						issue: issue.number,
						directive,
						requester: sender.login,
					},
				});
				return;
			}

			// PR comment — review commands
			const normalized = comment.body.trim().toLowerCase().replace(/^\//, '').trim();
			const command =
				normalized === 'full-review' ? 'full' : normalized === 'review' ? 'incremental' : null;
			if (!command) {
				console.log(`[issue_comment] unrecognised command="${normalized}" ${ref} sender=${sender.login}`);
				return;
			}

			const owner = repository.owner.login;
			const repo = repository.name;
			console.log(`[issue_comment] dispatch ${command} review ${ref} sender=${sender.login}`);
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
					reason: `"/${normalized}" command from @${sender.login}.`,
				},
			});
			return;
		}

		// --- User reply inside an inline review thread ------------------------
		if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
			const { repository, pull_request, comment, sender } = delivery.payload;
			const pr = `${repository.owner.login}/${repository.name}#${pull_request.number}`;

			if (isSelf(sender)) {
				console.log(`[review_comment] skip self sender=${sender.login} ${pr}`);
				return;
			}
			if (!comment.in_reply_to_id) {
				console.log(`[review_comment] skip top-level comment ${pr} sender=${sender.login}`);
				return;
			}

			const owner = repository.owner.login;
			const repo = repository.name;
			console.log(`[review_comment] dispatch reply ${pr} sender=${sender.login} comment=${comment.id}`);
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

		console.log(`[webhook] unhandled event=${delivery.name}`);
	},
});
