import assert from "node:assert/strict";
import test from "node:test";

import { isPublicAddress } from "./egress-proxy.mjs";

test("allows public IPv4 and IPv6", () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("blocks loopback, private, Docker, Tailscale and metadata IPv4", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.85.198.61",
    "127.0.0.1",
    "169.254.169.254",
    "172.17.0.1",
    "192.168.1.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("blocks local and documentation IPv6", () => {
  for (const address of ["::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("blocks IPv4-mapped private IPv6 addresses", () => {
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:169.254.169.254"), false);
});

test("rejects hostnames and malformed strings before DNS", () => {
  assert.equal(isPublicAddress("localhost"), false);
  assert.equal(isPublicAddress("not-an-ip"), false);
  assert.equal(isPublicAddress(""), false);
});
