import { defineAgent } from '@flue/runtime';
import instructions from './issue-classifier.md' with { type: 'markdown' };
import { channel } from '../channels/github.ts';
import { createIssueGateway } from '../shared/issues.ts';
import { createClassifierTools } from '../shared/issue-tools.ts';
import { createRetentionExtension } from '../shared/retention.ts';

// Self-scheduled storage cleanup (see shared/retention.ts).
export const cloudflare = createRetentionExtension();

export default defineAgent(({ id }) => {
	const { owner, repo, issueNumber } = channel.parseConversationKey(id);
	const gw = createIssueGateway({ owner, repo, issueNumber });
	return {
		model: 'deepseek/deepseek-v4-flash',
		instructions,
		tools: createClassifierTools(gw),
	};
});
