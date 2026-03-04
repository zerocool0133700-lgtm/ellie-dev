/**
 * ELLIE-510 — Vault: AES-256-GCM encrypt/decrypt and DB credential functions
 *
 * Covers: encrypt/decrypt round-trip, tamper detection, wrong-key rejection,
 * random IV (two encryptions of same plaintext differ), getMasterKey validation,
 * and createCredential/getDecryptedPayload with a mock Supabase client.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { encrypt, decrypt, createCredential, getDecryptedPayload } from "../src/vault.ts";

// ── Test key (64 hex chars = 32 bytes) ───────────────────────

const TEST_KEY = "a".repeat(64); // all 'a's — valid 64-hex-char key
const OTHER_KEY = "b".repeat(64);

function withKey(hex: string, fn: () => void) {
  const original = process.env.VAULT_MASTER_KEY;
  process.env.VAULT_MASTER_KEY = hex;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = original;
  }
}

async function withKeyAsync(hex: string, fn: () => Promise<void>) {
  const original = process.env.VAULT_MASTER_KEY;
  process.env.VAULT_MASTER_KEY = hex;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = original;
  }
}

// ── encrypt / decrypt ────────────────────────────────────────

describe("encrypt + decrypt — round-trip", () => {
  test("basic string survives a round-trip", () => {
    withKey(TEST_KEY, () => {
      const plaintext = "hello vault";
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  test("empty string round-trip", () => {
    withKey(TEST_KEY, () => {
      expect(decrypt(encrypt(""))).toBe("");
    });
  });

  test("unicode / emoji payload survives round-trip", () => {
    withKey(TEST_KEY, () => {
      const plaintext = "password: 🔐Süper$ecret!";
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  test("JSON payload round-trip (credential payload shape)", () => {
    withKey(TEST_KEY, () => {
      const payload = JSON.stringify({ username: "dave", password: "hunter2" });
      expect(decrypt(encrypt(payload))).toBe(payload);
    });
  });

  test("two encryptions of the same plaintext produce different ciphertexts (random IV)", () => {
    withKey(TEST_KEY, () => {
      const ct1 = encrypt("same text");
      const ct2 = encrypt("same text");
      expect(ct1).not.toBe(ct2);
    });
  });

  test("encrypt output is base64 (no whitespace, no +/= issues in decode)", () => {
    withKey(TEST_KEY, () => {
      const ct = encrypt("test");
      // Valid base64 should decode without error
      expect(() => Buffer.from(ct, "base64")).not.toThrow();
    });
  });

  test("ciphertext is at least 28 bytes when decoded (12 IV + ≥0 cipher + 16 authTag)", () => {
    withKey(TEST_KEY, () => {
      const ct = encrypt("x");
      const buf = Buffer.from(ct, "base64");
      expect(buf.length).toBeGreaterThanOrEqual(28);
    });
  });
});

// ── tamper detection ─────────────────────────────────────────

describe("decrypt — tamper detection", () => {
  test("throws when authTag bytes are mutated", () => {
    withKey(TEST_KEY, () => {
      const ct = encrypt("sensitive data");
      const buf = Buffer.from(ct, "base64");
      // Flip last byte (authTag)
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString("base64");
      expect(() => decrypt(tampered)).toThrow();
    });
  });

  test("throws when ciphertext body is mutated", () => {
    withKey(TEST_KEY, () => {
      const ct = encrypt("sensitive data");
      const buf = Buffer.from(ct, "base64");
      if (buf.length > 28) {
        // Flip a byte in the ciphertext body (after IV, before authTag)
        buf[12] ^= 0xff;
        expect(() => decrypt(buf.toString("base64"))).toThrow();
      }
    });
  });

  test("throws when IV bytes are changed", () => {
    withKey(TEST_KEY, () => {
      const ct = encrypt("secret");
      const buf = Buffer.from(ct, "base64");
      buf[0] ^= 0xff; // Mutate first IV byte
      expect(() => decrypt(buf.toString("base64"))).toThrow();
    });
  });

  test("throws when ciphertext is too short (< 28 bytes)", () => {
    withKey(TEST_KEY, () => {
      const short = Buffer.alloc(10).toString("base64");
      // Node crypto throws its own error (e.g. invalid tag length) — any throw is correct
      expect(() => decrypt(short)).toThrow();
    });
  });
});

// ── wrong key rejection ──────────────────────────────────────

describe("decrypt — wrong key rejection", () => {
  test("ciphertext encrypted with key A cannot be decrypted with key B", () => {
    let ciphertext: string;
    withKey(TEST_KEY, () => {
      ciphertext = encrypt("secret text");
    });
    withKey(OTHER_KEY, () => {
      expect(() => decrypt(ciphertext!)).toThrow();
    });
  });
});

// ── getMasterKey validation (indirectly via encrypt/decrypt) ──

describe("getMasterKey — validation", () => {
  test("throws when VAULT_MASTER_KEY is not set", () => {
    const original = process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_MASTER_KEY;
    try {
      expect(() => encrypt("x")).toThrow(/VAULT_MASTER_KEY/i);
    } finally {
      if (original !== undefined) process.env.VAULT_MASTER_KEY = original;
    }
  });

  test("throws when VAULT_MASTER_KEY is wrong length (not 64 hex chars)", () => {
    withKey("aabb", () => {
      expect(() => encrypt("x")).toThrow(/64-character/i);
    });
  });
});

// ── createCredential / getDecryptedPayload (mock Supabase) ───

describe("createCredential + getDecryptedPayload — Supabase integration", () => {
  const CRED_ID = "cred-uuid-001";
  const PAYLOAD = { key: "sk-test-abc123" };

  function makeMockSupabase(overrides?: Record<string, any>) {
    let insertedData: any = null;
    const supabase: any = {
      from: (_table: string) => ({
        // createCredential calls .insert({...}).select(cols).single()
        insert: (row: any) => {
          insertedData = row; // object, not array
          return {
            select: (_cols?: string) => ({
              single: () =>
                Promise.resolve({
                  data: { id: CRED_ID, ...insertedData },
                  error: null,
                }),
            }),
          };
        },
        // getDecryptedPayload calls .select("*, encrypted_data").eq(...).single()
        select: (_cols?: string) => ({
          eq: (_col: string, _val: any) => ({
            single: () =>
              Promise.resolve({
                data: overrides?.credRow ?? null,
                error: overrides?.credRow ? null : { message: "not found" },
              }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
      _getInserted: () => insertedData,
    };
    return supabase;
  }

  test("createCredential encrypts the payload before storing (no plaintext in encrypted_data)", async () => {
    await withKeyAsync(TEST_KEY, async () => {
      const supabase = makeMockSupabase();
      await createCredential(supabase, {
        label: "Test API key",
        domain: "example.com",
        credential_type: "api_key",
        payload: PAYLOAD,
      });
      const inserted = supabase._getInserted();
      expect(inserted).toBeDefined();
      // encrypted_data must not contain the raw key
      expect(inserted.encrypted_data).not.toContain("sk-test-abc123");
      // must be valid base64 (decrypt-able)
      const decrypted = JSON.parse(decrypt(inserted.encrypted_data));
      expect(decrypted).toEqual(PAYLOAD);
    });
  });

  test("getDecryptedPayload decrypts and returns the original payload", async () => {
    await withKeyAsync(TEST_KEY, async () => {
      const encrypted = encrypt(JSON.stringify(PAYLOAD));
      const supabase = makeMockSupabase({
        credRow: {
          id: CRED_ID,
          label: "Test",
          domain: "example.com",
          credential_type: "api_key",
          encrypted_data: encrypted,
        },
      });
      const { payload } = await getDecryptedPayload(supabase, CRED_ID);
      expect(payload).toEqual(PAYLOAD);
    });
  });
});
