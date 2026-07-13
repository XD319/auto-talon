import { describe, expect, it } from "vitest";
import { combinePolicyEffects } from "../src/policy/policy-engine.js";

describe("layered policy", () => {
  it("uses deny over approval over allow and reports the deciding layer", () => {
    expect(combinePolicyEffects([{ layer: "user", effect: "deny" }, { layer: "workspace", effect: "allow" }])).toEqual({ effect: "deny", decidingLayers: ["user"] });
    expect(combinePolicyEffects([{ layer: "user", effect: "allow" }, { layer: "workspace", effect: "allow_with_approval" }])).toEqual({ effect: "allow_with_approval", decidingLayers: ["workspace"] });
  });
});
