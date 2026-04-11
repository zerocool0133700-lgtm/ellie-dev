# OS Auth Key Rotation Runbook

Ticket: ELLIE-1262

## Overview

OS auth uses RS256 (RSA-2048) keys for signing JWT access tokens. The system supports multiple active signing keys for zero-downtime rotation. The JWKS endpoint (`/.well-known/jwks.json`) advertises all active public keys so clients can verify tokens signed by any non-expired key.

## When to Rotate

| Scenario | Grace Period | Urgency |
|----------|-------------|---------|
| Routine hygiene | 24-48 hours | Low — schedule quarterly |
| Staff departure with key access | 24 hours | Medium — same day |
| Suspected key compromise | 0 hours | Critical — immediate |

## Rotation Procedure

### 1. Routine Rotation (24h grace)

```bash
bun scripts/rotate-os-auth-keys.ts
```

This:
- Generates a new RSA-2048 key pair
- Marks the current key to expire in 24 hours
- New tokens are signed with the new key immediately
- Old tokens remain valid until they naturally expire (15min access, 30d refresh) or grace ends
- JWKS endpoint serves both keys during the grace period

### 2. Custom Grace Period

```bash
bun scripts/rotate-os-auth-keys.ts --grace-hours 48
```

### 3. Dry Run (inspect current state)

```bash
bun scripts/rotate-os-auth-keys.ts --dry-run
```

Shows current key IDs and their expiry status without making changes.

### 4. Emergency Rotation (compromised key)

```bash
bun scripts/rotate-os-auth-keys.ts --grace-hours 0
```

**WARNING**: This invalidates all existing tokens immediately. All users will need to re-authenticate. Only use if a key is confirmed compromised.

## Architecture

### Key Storage

Keys are stored in the Hollow vault under keychain `os-auth-signing-keys`, key `key_store`. The store is a JSON array of key records:

```json
[
  {
    "kid": "os-auth-1711929600000",
    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    "privateKey": "-----BEGIN PRIVATE KEY-----...",
    "createdAt": 1711929600000,
    "expiresAt": null
  }
]
```

- `expiresAt: null` = active key (used for signing)
- `expiresAt: <timestamp>` = grace period key (accepted for verification only)

### Key ID Format

`os-auth-{epoch_ms}` or `os-auth-{epoch_ms}-{random}` (when rotated in same millisecond).

### Token Lifecycle

- Access tokens: 15-minute expiry, signed with RS256, include `kid` in JWT header
- Refresh tokens: 30-day expiry, opaque `osrt_` prefixed strings
- During grace period: clients can refresh using old tokens, receive new tokens signed with new key

### JWKS Endpoint

`GET /api/os-auth/jwks` returns all non-expired public keys in standard JWK format. Clients and relying parties should cache this with short TTL (5-15 minutes) and refresh on `kid` mismatch.

## Verification After Rotation

1. Run dry-run to confirm new key is active:
   ```bash
   bun scripts/rotate-os-auth-keys.ts --dry-run
   ```

2. Check JWKS endpoint serves both keys:
   ```bash
   curl -s http://localhost:3001/api/os-auth/jwks | jq '.keys | length'
   # Should show 2 during grace period
   ```

3. Test a fresh login to confirm new tokens work:
   ```bash
   curl -s -X POST http://localhost:3001/api/os-auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "test@example.com", "password": "testpass"}' | jq '.access_token'
   ```

## Legacy Format Migration

The system auto-detects legacy single-key storage (separate `private_key`, `public_key`, `kid` vault entries) and migrates to the multi-key format on first access. This fallback will be removed after **2026-07-01** (ELLIE-1263).

## Source Files

| File | Purpose |
|------|---------|
| `src/os-auth/keys.ts` | Multi-key store, rotation logic, JWKS |
| `scripts/rotate-os-auth-keys.ts` | CLI rotation script |
| `tests/os-auth-key-rotation.test.ts` | Rotation test coverage |
