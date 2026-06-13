import { describe, expect, it } from "vitest";
import { verifyPassword } from "./passwords";
import { loginTimingDummyHash, loginTimingDummyPassword } from "./timing";

describe("login timing dummy hash", () => {
  it("uses the same argon2 verifier path as real password hashes", async () => {
    await expect(verifyPassword(loginTimingDummyHash, loginTimingDummyPassword)).resolves.toBe(true);
    await expect(verifyPassword(loginTimingDummyHash, "wrong-password")).resolves.toBe(false);
  });
});
