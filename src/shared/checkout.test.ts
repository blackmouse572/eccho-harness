import { test, expect } from 'bun:test';
import { checkoutPrHead, REPO_CHECKOUT_PATH } from './checkout.ts';
import type { FlueHarness } from '@flue/runtime';

// Fake harness recording the shell command the checkout builds.
function fakeHarness(result: { exitCode: number; stdout?: string; stderr?: string }) {
	const calls: { command?: string } = {};
	const harness = {
		shell(command: string) {
			calls.command = command;
			return Promise.resolve({ stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode });
		},
	} as unknown as FlueHarness;
	return { harness, calls };
}

test('checkoutPrHead clones + fetches the PR head ref and reports success', async () => {
	const { harness, calls } = fakeHarness({ exitCode: 0 });
	const res = await checkoutPrHead(harness, { owner: 'o', repo: 'r', pr: 42 });
	expect(res.ok).toBe(true);
	expect(res.path).toBe(REPO_CHECKOUT_PATH);
	expect(calls.command).toContain('git clone --filter=blob:none --no-checkout');
	expect(calls.command).toContain('pull/42/head');
	expect(calls.command).toContain('git checkout FETCH_HEAD');
});

test('checkoutPrHead reports failure with the stderr tail', async () => {
	const { harness } = fakeHarness({ exitCode: 128, stderr: 'fatal: repository not found' });
	const res = await checkoutPrHead(harness, { owner: 'o', repo: 'r', pr: 1 });
	expect(res.ok).toBe(false);
	expect(res.message).toContain('repository not found');
});
