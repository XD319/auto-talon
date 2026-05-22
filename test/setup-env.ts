import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach } from "vitest";

beforeEach(() => {
  process.env.AGENT_PROVIDER ??= "mock";
  process.env.AGENT_USER_CONFIG_DIR ??= join(tmpdir(), "auto-talon-vitest-user-config");
});
