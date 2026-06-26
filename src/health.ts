import { pingGitHub } from './shared/pull-requests.ts';

// Readiness checks for the external services and tools this app depends on.
// `critical` checks gate the overall status (503 when any is down); optional
// ones are reported but don't fail readiness.
export type HealthCheck = {
	name: string;
	status: 'ok' | 'down' | 'not_configured';
	critical: boolean;
	detail?: string;
};

export type Readiness = { status: 'ok' | 'degraded'; checks: HealthCheck[] };

export async function checkReadiness(): Promise<Readiness> {
	// GitHub — a live call that both reaches the API and validates the token.
	const gh = await pingGitHub();

	const checks: HealthCheck[] = [
		{
			name: 'github',
			status: gh.ok ? 'ok' : 'down',
			critical: true,
			detail: gh.ok ? `authenticated as ${gh.login}` : gh.error,
		},
		{
			// A live DeepSeek call is too costly for a probe — check key presence.
			name: 'deepseek',
			status: process.env.DEEPSEEK_API_KEY ? 'ok' : 'down',
			critical: true,
			detail: process.env.DEEPSEEK_API_KEY ? 'API key configured' : 'missing DEEPSEEK_API_KEY',
		},
		{
			name: 'github_webhook_secret',
			status: process.env.GITHUB_WEBHOOK_SECRET ? 'ok' : 'down',
			critical: true,
			detail: process.env.GITHUB_WEBHOOK_SECRET ? 'configured' : 'missing GITHUB_WEBHOOK_SECRET',
		},
		{
			// Optional tracing — not required to operate.
			name: 'braintrust',
			status: process.env.BRAINTRUST_API_KEY ? 'ok' : 'not_configured',
			critical: false,
			detail: process.env.BRAINTRUST_API_KEY ? 'tracing enabled' : 'tracing disabled',
		},
	];

	const status: Readiness['status'] = checks.every((c) => !c.critical || c.status === 'ok') ? 'ok' : 'degraded';
	return { status, checks };
}
