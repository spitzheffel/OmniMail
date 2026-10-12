export type ICloudHost = 'icloud.com' | 'icloud.com.cn'
export type ICloudAccountStatus = 'active' | 'pending' | 'error'
export type AppleAccountStatus = 'none' | 'active' | 'expired' | 'error'

export interface AppleAccountState {
  cookies: Record<string, string>
  scnt: string
  sessionId: string
  apiKey: string
  expiresAt: string
  lastCheckedAt: string
  userAgent: string
  host: string
  origin: string
  /** The Apple ID the session signed in as; absent on sessions imported or saved before it was kept. */
  appleId?: string
}

/**
 * A secret as a request read it. The ciphertext doubles as a version because
 * every encryption draws a fresh IV; the plaintext tells a pure re-encryption
 * (a key migration) apart from a newer value.
 */
export interface SecretRead {
  cipher: string
  plaintext: string
}

export type AppleAccountRead = SecretRead

export interface ICloudAccount {
  id: string
  userId: string
  name: string
  realEmail: string
  icloudEmail: string
  cookies: Record<string, string>
  host: ICloudHost
  appPassword: string
  status: ICloudAccountStatus
  aliasTotal: number
  aliasActive: number
  lastValidated: string
  lastError: string
  appleAccountState?: AppleAccountState | null
  appleAccountStatus?: AppleAccountStatus
  appleAccountExpiresAt?: string
  appleAccountError?: string
  /** How the session above was stored when read. Server-only; never part of a response. */
  appleAccountRead?: AppleAccountRead
  /** How the cookie jar was stored when read. Server-only; never part of a response. */
  cookiesRead?: SecretRead
  createdAt: string
}

export interface ICloudAccountRow {
  id: string
  user_id: string
  name: string
  real_email: string
  icloud_email: string
  cookies_cipher: string
  host: ICloudHost
  app_password_cipher: string
  status: ICloudAccountStatus
  alias_total: number
  alias_active: number
  last_validated: string
  last_error: string
  apple_account_state_cipher: string
  apple_account_expires_at: string
  apple_account_status: AppleAccountStatus
  apple_account_error: string
  created_at: string
}

export type PublicICloudAccount = Omit<
  ICloudAccount,
  'cookies' | 'appPassword' | 'appleAccountState' | 'appleAccountRead' | 'cookiesRead' | 'userId'
> & {
  hasCookies: boolean
  hasAppPassword: boolean
  hasAppleAccount: boolean
  appleAccountStatus: AppleAccountStatus
  appleAccountExpiresAt: string
}

export interface ICloudAlias {
  email: string
  anonymousId: string
  label: string
  active: boolean
  createdAt?: string
}

export interface ICloudMessage {
  id: string
  from: string
  to: string
  subject: string
  date: string
  preview: string
  body: string
  html: string
  isRead?: boolean
}

export interface ICloudAccountInfo {
  dsid: string
  appleId: string
  primaryEmail: string
}
