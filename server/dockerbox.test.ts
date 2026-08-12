import { describe, expect, it } from "vitest";

import { __testing, containerNameFor } from "./dockerbox.ts";

const { networkNameFor, egressNetworkNameFor, proxyNameFor } = __testing;

describe("Docker bot resource names", () => {
  it("is deterministic for a UUID bot id", () => {
    const id = "A1B2C3D4-E5F6-47A8-9012-ABCDEF123456";
    expect(containerNameFor(id)).toBe("omb-bot-a1b2c3d4-e5f6-47a8-9012-abcdef123456");
    expect(containerNameFor(id)).toBe(containerNameFor(id));
  });

  it("sanitizes characters Docker names reject", () => {
    expect(containerNameFor("Bot id / with spaces!?" )).toBe("omb-bot-botidwithspaces");
  });

  it("uses distinct deterministic names for agent, proxy, and both networks", () => {
    const id = "test-bot";
    const agent = containerNameFor(id);
    const proxy = proxyNameFor(id);
    const network = networkNameFor(id);
    const egress = egressNetworkNameFor(id);
    expect(new Set([agent, proxy, network, egress]).size).toBe(4);
    expect(proxy).toBe(`${agent}-router`);
    expect(network).toBe(`${agent}-net`);
    expect(egress).toBe(`${agent}-egress`);
  });
});
