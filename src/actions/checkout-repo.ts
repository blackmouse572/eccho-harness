import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { checkoutPrHead } from '../shared/checkout.ts';

// Model-facing adapter over checkoutPrHead. Clone the PR head into the sandbox
// so the domain reviewer can grep/read any file. Only invoked when the scope
// assessment includes the `domain` dimension, so the container only starts then.
export const checkoutRepo = defineAction({
	name: 'checkout_repo',
	description:
		'Check out the pull request head into the sandbox at /workspace/repo (full repo, for domain review). Only call this when a domain review is needed. Returns whether the checkout succeeded.',
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		pr: v.number(),
	}),
	output: v.object({
		ok: v.boolean(),
		path: v.string(),
		message: v.string(),
	}),
	async run({ harness, input, log }) {
		log.info(`Checking out ${input.owner}/${input.repo}#${input.pr} into /workspace/repo`);
		return checkoutPrHead(harness, input);
	},
});
