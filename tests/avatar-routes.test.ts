import { describe, it, expect } from "bun:test";

describe("avatar-routes", () => {
  it("should export handleAvatarRoutes function", async () => {
    const { handleAvatarRoutes } = await import("../src/avatar-routes.ts");
    expect(typeof handleAvatarRoutes).toBe("function");
  });
});
