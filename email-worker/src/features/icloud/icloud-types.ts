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
}

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
  'cookies' | 'appPassword' | 'appleAccountState' | 'userId'
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
