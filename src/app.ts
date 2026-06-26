// Import the Braintrust bridge first so its logger initializes before any
// agent/workflow activity is observed. No-ops without BRAINTRUST_API_KEY.
import './braintrust.ts';

import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// Application entrypoint. Mount Flue at the root so the GitHub channel webhook
// (/channels/github/webhook) and any agent/workflow routes are served.
const app = new Hono();
app.route('/', flue());

export default app;
