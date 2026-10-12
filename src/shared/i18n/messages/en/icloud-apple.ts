/**
 * Messages the iCloud worker sends back, keyed by their exact Chinese source:
 * the client translates `error` with t(), and an entry missing here shows
 * English users the raw Chinese. Dynamic wording travels in `detail`, never
 * inside these keys. Also the Apple Account sign-in strings added beside them.
 */
export const enICloudApple: Record<string, string> = {
  // Apple Account sign-in
  '请填写 Apple ID 和密码。': 'Enter the Apple ID and password.',
  'Apple ID 或密码错误。': 'The Apple ID or password is incorrect.',
  'Apple 登录已失效，请重新登录。': 'The Apple sign-in has expired. Sign in again.',
  'Apple 登录请求过于频繁，请稍后再试。': 'Too many Apple sign-in requests. Try again later.',
  'Apple 登录请求失败。': 'The Apple sign-in request failed.',
  'Apple Account 登录失败。': 'Apple Account sign-in failed.',
  'Apple Account 登录暂时失败。': 'Apple Account sign-in is temporarily unavailable.',
  'Apple Account 登录预热失败。': 'Could not prepare the Apple Account sign-in.',
  'Apple Account 管理态预热失败。': 'Could not prepare the Apple Account management session.',
  'Apple Account 动态验证生成失败，请稍后重试。': 'Could not solve Apple\'s sign-in challenge. Try again later.',
  'Apple SRP 挑战参数无效。': 'Apple returned an invalid sign-in challenge.',
  'Apple SRP 迭代参数无效。': 'Apple returned an invalid password-stretching setting.',
  'Apple ID 登录尝试过于频繁，请稍后再试。': 'Too many sign-in attempts for this Apple ID. Try again later.',
  '请输入 6 位验证码。': 'Enter the 6-digit code.',
  '验证码不正确，请重新输入。': 'The code is incorrect. Enter it again.',
  '验证码尝试次数过多，请重新开始登录。': 'Too many code attempts. Start the sign-in again.',
  '登录挑战已过期，请重新开始。': 'The sign-in has expired. Start again.',
  'Apple 没有返回可接收验证码的受信任手机号。': 'Apple did not return a trusted phone number that can receive the code.',
  '请选择 Apple 返回的受信任手机号。': 'Choose one of the trusted phone numbers Apple returned.',
  '连接 Apple Account 超时。': 'Connecting to Apple Account timed out.',
  '连接 Apple Account 失败。': 'Could not connect to Apple Account.',
  '短信验证码': 'SMS verification code',
  '验证码已通过短信发送到 {phone}': 'The code was sent by SMS to {phone}',
  '验证码已通过短信发送到受信任手机号': 'The code was sent by SMS to your trusted phone number',
  '接收短信的手机号': 'Phone number for the SMS',
  '手机号 {id}': 'Phone number {id}',
  '重新发送短信': 'Resend SMS',
  '改用短信接收验证码': 'Get the code by SMS instead',
  '邮箱或手机号': 'Email or phone number',

  // Apple Account session and management API
  '该账号尚未配置 Apple Account 管理态。': 'This account has no Apple Account session yet.',
  'Apple Account 管理态已失效，请重新登录。': 'The Apple Account session has expired. Sign in again.',
  'Apple Account 管理态缺少 scnt，请重新登录。': 'The Apple Account session is incomplete. Sign in again.',
  'Apple Account 管理接口未返回 apiKey，请重新登录。': 'Apple Account did not return a management key. Sign in again.',
  'Apple Account 已达到当前隐私邮箱创建上限，请稍后再试。':
    'Apple Account has reached its current Hide My Email creation limit. Try again later.',
  'Apple Account 请求过于频繁，请稍后再试。': 'Too many Apple Account requests. Try again later.',
  'Apple Account 请求失败。': 'The Apple Account request failed.',
  'Apple Account 请求路径无效。': 'Invalid Apple Account request path.',
  'Apple Account 返回了无法解析的 JSON。': 'Apple Account returned JSON that could not be read.',
  'Apple Account 返回了无效的服务地址。': 'Apple Account returned an invalid service address.',
  'Apple Account 服务地址不在允许域名内。': 'The Apple Account service address is outside the allowed domains.',
  'Apple Account 未返回候选隐私邮箱。': 'Apple Account did not return a suggested address.',
  'Apple Account 创建后未返回隐私邮箱。': 'Apple Account did not return the address it created.',
  'Apple Account 未返回可识别的隐私邮箱列表。': 'Apple Account did not return an address list that could be read.',
  'Apple Account 新接口创建不接受旧接口预览地址。':
    'Creating through Apple Account does not take an address previewed through the cookie channel.',
  'Apple Account 登录态已损坏。': 'The stored Apple Account session is damaged.',
  'Apple Account sessionId 无效。': 'Invalid Apple Account session ID.',
  'Apple Account 服务地址无效。': 'Invalid Apple Account service address.',
  'Apple ID 无效。': 'Invalid Apple ID.',
  '这个 iCloud 账号已登录另一个 Apple ID；如需更换，请先移除 Apple Account 登录态：':
    'This iCloud account is signed in to another Apple ID. To switch, remove the Apple Account session first:',
  '这个 iCloud 账号的 Cookie 属于另一个 Apple ID，请用它登录：':
    'This iCloud account\'s cookies belong to another Apple ID. Sign in with it:',
  '这个 Apple ID 已在另一个 iCloud 账号中使用：': 'This Apple ID is already used by another iCloud account:',
  '这些 Cookie 属于另一个 Apple ID，与这个账号的 Apple Account 登录不一致：':
    'These cookies belong to a different Apple ID from this account\'s Apple Account sign-in:',
  '该账号尚未配置可创建隐藏邮箱的登录态。': 'This account has no credential that can create Hide My Email addresses.',

  // iCloud web and IMAP
  'iCloud 账号不存在。': 'The iCloud account does not exist.',
  'iCloud 验证失败。': 'iCloud validation failed.',
  'iCloud 暂时无法处理这个请求。': 'iCloud cannot handle this request right now.',
  'iCloud 功能尚未配置 MAIL_CREDENTIALS_KEY 或 ICLOUD_CREDENTIALS_KEY。':
    'iCloud is not configured: set MAIL_CREDENTIALS_KEY or ICLOUD_CREDENTIALS_KEY.',
  'iCloud 账号凭据已损坏。': 'The stored iCloud credentials are damaged.',
  'iCloud 返回了无效的服务地址。': 'iCloud returned an invalid service address.',
  'iCloud 返回的服务地址不在允许域名内。': 'The iCloud service address is outside the allowed domains.',
  'iCloud 返回了无法解析的 JSON。': 'iCloud returned JSON that could not be read.',
  'iCloud 未返回可识别的隐藏邮箱列表。': 'iCloud did not return an address list that could be read.',
  'iCloud 响应中没有隐藏邮箱地址。': 'The iCloud response has no Hide My Email address.',
  'iCloud 响应中没有邮件服务地址。': 'The iCloud response has no mail service address.',
  'iCloud Web 邮件接口返回失败。': 'The iCloud web mail service returned an error.',
  '请求体必须是 JSON 对象。': 'The request body must be a JSON object.',
  '缺少 accountId。': 'accountId is missing.',
  '隐藏邮箱参数无效。': 'Invalid Hide My Email parameters.',
  '隐藏邮箱操作参数无效。': 'Invalid Hide My Email action.',
  '账号名称需要在 1–80 个字符之间。': 'The account name must be 1–80 characters.',
  '请至少配置 iCloud Cookie，或填写主邮箱和应用专用密码。':
    'Configure iCloud cookies, or enter the primary address and an app-specific password.',
  '该账号尚未配置 Cookie。': 'This account has no cookies yet.',
  '同步失败。': 'Sync failed.',
  '按隐藏邮箱筛选需要先配置应用专用密码。': 'Filtering by Hide My Email address needs an app-specific password.',
  '需要先配置 Cookie 或应用专用密码。': 'Configure cookies or an app-specific password first.',
  '读取完整邮件需要先配置应用专用密码。': 'Reading full messages needs an app-specific password.',
  'Cookie 中没有可用值。': 'The cookies contain no usable values.',
  '请填写 iCloud Cookie。': 'Enter the iCloud cookies.',
  'Cookie JSON 格式无效。': 'Invalid cookie JSON.',
  '无法解析 iCloud Cookie。': 'Could not read the iCloud cookies.',
  'IMAP 登录信息包含非法换行。': 'The IMAP sign-in details contain a line break.',
  '邮件 UID 无效。': 'Invalid message UID.',
  '邮件不存在或已被移动。': 'The message does not exist or was moved.',

  // Audit log
  '已更新 Apple Account 登录态': 'Apple Account session updated',
  '已移除 Apple Account 登录态': 'Apple Account session removed',
  '经 Apple Account 创建': 'Created through Apple Account',
  '经 iCloud 网页 Cookie 创建': 'Created through iCloud web cookies',
  '密码登录': 'Password sign-in',
  '双重认证登录': 'Two-factor sign-in',
  'Apple Account 服务：{host}': 'Apple Account service: {host}',
}
