import { test, expect } from "bun:test";
import { domainRepoTools } from "./repo-tools.ts";
import type { PullRequestGateway } from "./pull-requests.ts";

test("domainRepoTools delegate to the gateway", async () => {
  const calls: Record<string, unknown> = {};
  const gw = {
    readFile: async (path: string) => {
      calls.readFile = path;
      return "FILE";
    },
    listTree: async (prefix?: string) => {
      calls.listTree = prefix;
      return ["a", "b"];
    },
  } as unknown as PullRequestGateway;

  const tools = domainRepoTools(gw) as Array<{ name: string; run: (ctx: { input?: unknown }) => Promise<unknown> }>;
  const read = tools.find((t) => t.name === "read_repo_file")!;
  const list = tools.find((t) => t.name === "list_repo_tree")!;

  expect(await read.run({ input: { path: "CONTEXT.md" } })).toEqual({ path: "CONTEXT.md", content: "FILE" });
  expect(calls.readFile).toBe("CONTEXT.md");

  expect(await list.run({ input: { prefix: "docs/adr/" } })).toEqual({ paths: ["a", "b"] });
  expect(calls.listTree).toBe("docs/adr/");
});
