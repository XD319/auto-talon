import type { LocalPolicyConfig } from "../types";

export const DEFAULT_LOCAL_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Never allow tools to escape the workspace boundary.",
      effect: "deny",
      id: "deny-outside-workspace",
      match: {
        pathScopes: ["outside_workspace", "outside_write_root"]
      },
      priority: 100
    },
    {
      description: "Reviewer profile is read-focused and cannot mutate files or run shell.",
      effect: "deny",
      id: "reviewer-read-only",
      match: {
        agentProfiles: ["reviewer"],
        capabilities: ["filesystem.write", "shell.execute"]
      },
      priority: 90
    },
    {
      description: "Shell execution is always approval-gated.",
      effect: "allow_with_approval",
      id: "shell-needs-approval",
      match: {
        capabilities: ["shell.execute"]
      },
      priority: 80
    },
    {
      description: "File writes are always approval-gated.",
      effect: "allow_with_approval",
      id: "file-write-needs-approval",
      match: {
        capabilities: ["filesystem.write"]
      },
      priority: 80
    },
    {
      description: "Network fetches are approval-gated.",
      effect: "allow_with_approval",
      id: "web-fetch-needs-approval",
      match: {
        capabilities: ["network.fetch"]
      },
      priority: 80
    },
    {
      description: "Low-risk internal reads are allowed.",
      effect: "allow",
      id: "file-read-allow",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace", "write_root"]
      },
      priority: 70
    }
  ],
  source: "local"
};
