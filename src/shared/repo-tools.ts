import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import type { PullRequestGateway } from "./pull-requests.ts";

// Tools the domain reviewer uses to read the eccho repo at the PR head via the
// GitHub API — no checkout, no container. Bound to one PR's gateway.
export function domainRepoTools(gw: PullRequestGateway) {
  return [
    defineTool({
      name: "list_repo_tree",
      description:
        "List file paths in the eccho repo at the PR head. Pass an optional `prefix` to filter (e.g. \"docs/adr/\", \".github/instructions/\"). Use to discover governance docs and related files.",
      input: v.object({
        prefix: v.optional(v.pipe(v.string(), v.description("Path prefix filter, e.g. docs/adr/"))),
      }),
      run: async ({ input }) => ({ paths: await gw.listTree(input.prefix) }),
    }),

    defineTool({
      name: "read_repo_file",
      description:
        "Read one file from the eccho repo at the PR head by path. Returns its text, or null if it is missing, a directory, binary, or too large. Use to read CONTEXT.md, docs/adr/**, .github/instructions/**, or any file you need to cross-check the change against.",
      input: v.object({
        path: v.pipe(v.string(), v.minLength(1), v.description("Repo-relative file path.")),
      }),
      run: async ({ input }) => ({ path: input.path, content: await gw.readFile(input.path) }),
    }),
  ];
}
