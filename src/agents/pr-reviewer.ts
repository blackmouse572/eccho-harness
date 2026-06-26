import { defineAgent } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';
import instructions from './pr-reviewer.md' with { type: 'markdown' };
import reviewPr from '../skills/review-pr/SKILL.md' with { type: 'skill' };
import { channel } from '../channels/github.ts';
import { assessPrScope } from '../actions/assess-pr-scope.ts';
import { checkoutRepo } from '../actions/checkout-repo.ts';
import { reviewerProfiles } from '../shared/reviewers.ts';
import { createPullRequestGateway } from '../shared/pull-requests.ts';
import { createReviewTools } from '../shared/review-tools.ts';

// The Sandbox DO namespace binding (declared in wrangler.jsonc). Inferred from
// getSandbox so we don't depend on @cloudflare/workers-types here.
type Env = { Sandbox: Parameters<typeof getSandbox>[0] };

// Master orchestrator: one durable instance per pull request (id = channel
// conversation key, which encodes the trusted owner/repo/PR number). Holds
// memory across events for incremental reviews and reply handling. Gates a
// fan-out to specialist subagents by the PR's change scope, then synthesizes and
// posts one review (summary + inline resolvable threads).
//
// No `route` export: the only ingress is the verified GitHub webhook.
export default defineAgent<Env>(({ id, env }) => {
	const gateway = createPullRequestGateway(channel.parseConversationKey(id));
	return {
		model: 'deepseek/deepseek-v4-flash', // orchestration; specialists also Flash + low
		thinkingLevel: 'medium',
		instructions,
		// Container-backed sandbox for the domain reviewer's repo checkout. The
		// container only starts when checkout_repo actually runs a command.
		sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
		cwd: '/workspace',
		skills: [reviewPr],
		actions: [assessPrScope, checkoutRepo],
		subagents: reviewerProfiles,
		tools: createReviewTools(gateway),
	};
});
