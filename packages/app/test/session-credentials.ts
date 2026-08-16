import { hashPassword, generateSigningKey } from '@mailriz/shared';

/**
 * Session credentials shared by every test that signs in.
 *
 * One place, because five test files used to each carry the same hardcoded
 * SHA-256 — and when the format changed, all five broke separately.
 */
export const TEST_PASSWORD = 'hunter2';

/**
 * Deliberately few iterations. Production uses 100k, but the count is stored
 * inside the hash and read back at verify time, so a low number here exercises
 * exactly the same path without adding a second to every test run.
 */
export const TEST_PASSWORD_HASH = await hashPassword(TEST_PASSWORD, 1_000);

export const TEST_SIGNING_KEY = generateSigningKey();
