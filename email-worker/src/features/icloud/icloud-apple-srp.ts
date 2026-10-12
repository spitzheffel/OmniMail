import { APPLE_ACCOUNT_ERROR_CODES, ICloudRemoteError } from './icloud-apple'

/**
 * SRP-6a as Apple's sign-in speaks it: SHA-256 over the 2048-bit RFC 5054
 * group, k and u over values padded to the group size, and
 * x = H(salt | H(":" | PBKDF2(password))) with no username in it.
 *
 * A goes out, and K, M1 and M2 hash S, A and B, in minimal big-endian form, as
 * pysrp (behind pyicloud) and the RustCrypto client behind SideStore's GSA do.
 * Padding them instead only changes the proof when one of them starts with a
 * zero byte — about one sign-in in a hundred, each failure counting toward the
 * Apple ID's lockout. icloud-apple-srp.test.ts pins these choices to vectors
 * from an independent implementation, those edge cases included.
 */
export const SRP_N = BigInt(`0x${
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050'
  + 'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50'
  + 'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8'
  + '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B'
  + 'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748'
  + '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE'
  + '6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFB'
  + 'B694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73'
}`)
const SRP_G = 2n
const SRP_BYTES = 256

function hex(value: Uint8Array): string {
  return Array.from(value).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bigint(value: Uint8Array): bigint {
  return value.length ? BigInt(`0x${hex(value)}`) : 0n
}

/** Minimal big-endian bytes, as long_to_bytes() gives them. */
function bytes(value: bigint): Uint8Array {
  let digits = value.toString(16)
  if (digits.length % 2) digits = `0${digits}`
  return Uint8Array.from(digits.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || [0])
}

/** Left-padded to the group size, as k and u take their inputs. */
function pad(value: bigint): Uint8Array {
  const minimal = bytes(value)
  const output = new Uint8Array(SRP_BYTES)
  output.set(minimal.slice(-SRP_BYTES), SRP_BYTES - Math.min(SRP_BYTES, minimal.length))
  return output
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)))
}

/** Empty for anything that is not base64, which the caller reports as an invalid challenge. */
function base64Bytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

export function srpBase64(value: Uint8Array): string {
  let text = ''
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text)
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = ((base % modulus) + modulus) % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

export function srpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

/** A = g^a mod N, sent as `a` in /signin/init. */
export function srpPublic(secret: Uint8Array): Uint8Array {
  return bytes(modPow(SRP_G, bigint(secret), SRP_N))
}

/** What /signin/init answered: the salt, B, and how the password is stretched. */
export interface SrpChallenge {
  salt: string
  b: string
  iteration: number
  protocol?: string
}

export async function srpProof(
  appleId: string,
  password: string,
  challenge: SrpChallenge,
  secret: Uint8Array,
): Promise<{ m1: string; m2: string }> {
  const salt = base64Bytes(challenge.salt)
  const serverB = bigint(base64Bytes(challenge.b))
  if (!salt.length || !serverB || serverB >= SRP_N) {
    throw new ICloudRemoteError(502, 'Apple SRP 挑战参数无效。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
  const iterations = challenge.iteration
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new ICloudRemoteError(502, 'Apple SRP 迭代参数无效。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
  const a = bigint(secret)
  const A = modPow(SRP_G, a, SRP_N)
  const nBytes = bytes(SRP_N)
  const k = bigint(await sha256(nBytes, pad(SRP_G)))
  const passHash = await sha256(new TextEncoder().encode(password))
  const passwordInput = challenge.protocol === 's2k_fo' ? new TextEncoder().encode(hex(passHash)) : passHash
  const key = await crypto.subtle.importKey('raw', passwordInput, 'PBKDF2', false, ['deriveBits'])
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  ))
  const inner = await sha256(new TextEncoder().encode(':'), derived)
  const x = bigint(await sha256(salt, inner))
  const u = bigint(await sha256(pad(A), pad(serverB)))
  const base = ((serverB - k * modPow(SRP_G, x, SRP_N)) % SRP_N + SRP_N) % SRP_N
  const shared = modPow(base, a + u * x, SRP_N)
  const sessionKey = await sha256(bytes(shared))
  const hG = await sha256(pad(SRP_G))
  const hN = await sha256(nBytes)
  const xor = hG.map((byte, index) => byte ^ hN[index])
  const m1 = await sha256(xor, await sha256(new TextEncoder().encode(appleId)), salt, bytes(A), bytes(serverB), sessionKey)
  const m2 = await sha256(bytes(A), m1, sessionKey)
  return { m1: srpBase64(m1), m2: srpBase64(m2) }
}
