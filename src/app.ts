// Import the Braintrust bridge first so its logger initializes before any
// agent/workflow activity is observed. No-ops without BRAINTRUST_API_KEY.
import './braintrust.ts';

import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { checkReadiness } from './health.ts';

// Application entrypoint. Mount Flue at the root so the GitHub channel webhook
// (/channels/github/webhook) and any agent/workflow routes are served.
const app = new Hono();

// Liveness — fast, no external calls. Is the worker up?
app.get('/health', (c) => c.json({ status: 'ok', service: 'eccho-pr-reviewer', time: new Date().toISOString() }));

// Readiness — checks the external services/tools (GitHub, DeepSeek, webhook
// secret, Braintrust). 503 when a critical dependency is down.
app.get('/health/ready', async (c) => {
	const result = await checkReadiness();
	return c.json(result, result.status === 'ok' ? 200 : 503);
});

app.route('/', flue());

export default app;
