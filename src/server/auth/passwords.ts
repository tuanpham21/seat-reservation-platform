import * as argon2 from "argon2";

export const argon2idOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
} satisfies argon2.Options & { raw?: false };

export function hashPassword(password: string) {
  return argon2.hash(password, argon2idOptions);
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
