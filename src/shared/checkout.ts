import type { FlueHarness } from '@flue/runtime';

// The one place that clones a PR's head into the sandbox. Both the checkout_repo
// action (model-facing adapter) and the review workflow call this — a change to
// auth, clone depth, or the ref lands once. Runs git in the container sandbox
// (the virtual sandbox has no real git).
export const REPO_CHECKOUT_PATH = '/workspace/repo';

export type CheckoutResult = { ok: boolean; path: string; message: string };

export async function checkoutPrHead(
	harness: FlueHarness,
	ref: { owner: string; repo: string; pr: number },
): Promise<CheckoutResult> {
	const token = process.env.GITHUB_TOKEN ?? '';
	const url = `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
	// Blobless clone (no checkout), then fetch the PR head ref and check it out.
	const cmd = [
		`rm -rf ${REPO_CHECKOUT_PATH}`,
		`git clone --filter=blob:none --no-checkout ${url} ${REPO_CHECKOUT_PATH}`,
		`cd ${REPO_CHECKOUT_PATH}`,
		`git fetch --depth 1 origin pull/${ref.pr}/head`,
		'git checkout FETCH_HEAD',
	].join(' && ');

	try {
		const res = await harness.shell(cmd, { timeoutMs: 180_000 });
		const ok = res.exitCode === 0;
		// Avoid leaking the tokenized URL; surface only the tail of stderr.
		return { ok, path: REPO_CHECKOUT_PATH, message: ok ? 'checked out' : res.stderr.slice(-500) || `git exited ${res.exitCode}` };
	} catch (err) {
		return { ok: false, path: REPO_CHECKOUT_PATH, message: err instanceof Error ? err.message : String(err) };
	}
}
