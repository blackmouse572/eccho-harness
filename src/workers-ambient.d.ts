// Minimal ambient types for the Cloudflare Workers surface used by app-owned
// Durable Objects and the scheduled handler. The project type-checks against
// `bun` types only; `@cloudflare/workers-types` cannot be added wholesale
// because its globals conflict with bun-types. These declarations cover just
// what src/cloudflare.ts and src/shared/retention.ts need.
declare module 'cloudflare:workers' {
	export class DurableObject<Env = unknown> {
		readonly ctx: DurableObjectState;
		readonly env: Env;
	}
}

interface DurableObjectState {
	readonly id: DurableObjectId;
	readonly storage: DurableObjectStorage;
}

interface DurableObjectStorage {
	readonly sql: {
		exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
	};
}

interface DurableObjectId {
	toString(): string;
}

interface DurableObjectNamespace<Class = unknown> {
	idFromName(name: string): DurableObjectId;
	newUniqueId(): DurableObjectId;
	get(id: DurableObjectId): DurableObjectStub<Class>;
}

type DurableObjectStub<Class = unknown> = Class & {
	fetch(input?: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

interface ScheduledController {
	readonly scheduledTime: number;
	readonly cron: string;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}
