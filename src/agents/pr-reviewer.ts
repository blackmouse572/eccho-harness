import { defineAgent } from '@flue/runtime';
import instructions from './pr-reviewer.md' with { type: 'markdown' };
import reviewPr from '../skills/review-pr/SKILL.md' with { type: 'skill' };
import { channel } from '../channels/github.ts';
import { assessPrScope } from '../actions/assess-pr-scope.ts';
import { architectReviewer, makeDomainReviewer, securityReviewer, testReviewer } from '../shared/reviewers.ts';
import { createPullRequestGateway } from '../shared/pull-requests.ts';
import { createReviewTools } from '../shared/review-tools.ts';

// Master orchestrator: one durable instance per pull request (id = channel
// conversation key, which encodes the trusted owner/repo/PR number). Holds
// memory across events for incremental reviews and reply handling. Gates a
// fan-out to specialist subagents by the PR's change scope, then synthesizes and
// posts one review (summary + inline resolvable threads).
//
// No container/sandbox: the domain reviewer reads the repo at the PR head
// through GitHub-API tools. No `route` export: the only ingress is the webhook.
export default defineAgent(({ id }) => {
	const gateway = createPullRequestGateway(channel.parseConversationKey(id));
	return {
		model: 'deepseek/deepseek-v4-flash',
		thinkingLevel: 'medium',
		instructions,
		skills: [reviewPr],
		actions: [assessPrScope],
		subagents: [architectReviewer, testReviewer, securityReviewer, makeDomainReviewer(gateway)],
		tools: createReviewTools(gateway),
	};
});
