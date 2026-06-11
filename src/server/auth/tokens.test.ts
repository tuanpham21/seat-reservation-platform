import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "./tokens";

describe("access tokens", () => {
  it("round-trips the required bearer claims", async () => {
    const token = await signAccessToken({
      sub: "user-1",
      email: "person@example.com",
      sessionFamilyId: "family-1"
    });

    await expect(verifyAccessToken(token)).resolves.toMatchObject({
      sub: "user-1",
      email: "person@example.com",
      sessionFamilyId: "family-1"
    });
  });
});
