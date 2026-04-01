/**
 * OS Auth — Password Hashing
 *
 * Thin wrapper around argon2id. All password storage goes through here.
 */

import argon2 from "argon2"

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password)
}
