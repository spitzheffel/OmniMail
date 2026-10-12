<!-- 此文件由 npm run docs:api 自动生成，请修改 src/features/api-guide/model/apiCatalog*.ts 后重新生成。 -->

# iCloud 隐藏邮箱

**iCloud Hide My Email**

iCloud 账号、凭据、隐藏地址和按需收件箱。

> iCloud accounts, credentials, aliases, and on-demand inbox access.

本分类共 **20** 个端点。返回 [完整 API 索引](README.md) 或 [API 架构与安全说明](../API.md)。

<!-- endpoint:GET /api/icloud/accounts catalog:82cd25d54b99 -->
## `GET /api/icloud/accounts`

**列出 iCloud 账户 / List iCloud accounts**

返回当前用户连接的 iCloud 账户，不解密或返回凭据。

> Return the current user’s connected iCloud accounts without decrypting or returning credentials.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | No parameters |
| 成功响应 | 200 · { accounts } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/icloud/accounts" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/icloud/accounts catalog:99142fefb9aa -->
## `POST /api/icloud/accounts`

**连接 iCloud 账户 / Connect an iCloud account**

通过应用专用密码连接主邮箱，或通过 Cookie 管理隐藏邮箱；两种方式可单独或同时配置。

> Connect primary mail with an app-specific password, manage aliases with cookies, or configure both.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · name, cookies?, host=icloud.com\|icloud.com.cn, icloudEmail?, appPassword?, appleAccountLogin? |
| 成功响应 | 201 · { account } |

> 注意：Cookie 属于高敏感凭据，只应提交给自己的 OmniMail 实例。
>
> Note: Cookies are highly sensitive credentials and should only be sent to your own OmniMail instance.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/accounts" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "name": "My iCloud",
  "cookies": {
    "X_APPLE_WEB_KB": "cookie-value"
  },
  "host": "icloud.com"
}'
```

<!-- endpoint:PATCH /api/icloud/accounts/:id catalog:a5d669daf183 -->
## `PATCH /api/icloud/accounts/{id}`

**修改 iCloud 账户备注 / Rename an iCloud account**

修改当前用户连接的 iCloud 账户备注名称。

> Change the display name of an iCloud account connected by the current user.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · name |
| 成功响应 | 200 · { ok: true, name } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/icloud/accounts/resource_id" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "name": "Personal iCloud"
}'
```

<!-- endpoint:DELETE /api/icloud/accounts/:id catalog:2fa96f6258b9 -->
## `DELETE /api/icloud/accounts/{id}`

**删除 iCloud 账户 / Delete an iCloud account**

删除当前用户的加密 Cookie、应用专用密码和账户记录。

> Delete the current user’s encrypted cookies, app password, and account record.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/icloud/accounts/resource_id" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:PUT /api/icloud/accounts/:id/cookies catalog:35bfd25e2478 -->
## `PUT /api/icloud/accounts/{id}/cookies`

**更新 iCloud Cookie / Update iCloud cookies**

覆盖并重新验证账户 Cookie，同时刷新别名统计。

> Replace and revalidate account cookies, then refresh alias statistics.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · cookies |
| 成功响应 | 200 · { account } |

### cURL 示例

```bash
curl --request PUT \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/cookies" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "cookies": {
    "X_APPLE_WEB_KB": "new-cookie-value"
  }
}'
```

<!-- endpoint:PUT /api/icloud/accounts/:id/app-password catalog:298fc5074c13 -->
## `PUT /api/icloud/accounts/{id}/app-password`

**设置 iCloud 应用专用密码 / Set an iCloud app-specific password**

验证 IMAP 登录后加密保存 iCloud 邮箱和应用专用密码。

> Validate IMAP login, then encrypt the iCloud email and app-specific password.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · icloudEmail, appPassword |
| 成功响应 | 200 · { ok: true, icloudEmail } |

### cURL 示例

```bash
curl --request PUT \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/app-password" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "icloudEmail": "owner@icloud.com",
  "appPassword": "xxxx-xxxx-xxxx-xxxx"
}'
```

<!-- endpoint:PUT /api/icloud/accounts/:id/apple-account catalog:b9295679b959 -->
## `PUT /api/icloud/accounts/{id}/apple-account`

**导入 Apple Account 管理态 / Import Apple Account management state**

验证并加密保存 Apple Account 的 Cookie、scnt 和动态 apiKey。

> Validate and encrypt Apple Account cookies, scnt, and dynamic apiKey.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · state={ cookies, scnt, apiKey, sessionId?, expiresAt?, appleId? } |
| 成功响应 | 200 · { account } |

> 注意：给出 appleId 时会核对归属：与该账号已登录或 Cookie 所属的 Apple ID 不同，或已被你的另一个 iCloud 账号使用，返回 409。
>
> Note: With appleId, ownership is checked: an Apple ID other than the one the account already signed in as or its cookies belong to, or one another of your iCloud accounts uses, answers 409.

### cURL 示例

```bash
curl --request PUT \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "state": {
    "cookies": {
      "myacinfo": "cookie-value"
    },
    "scnt": "scnt-value",
    "apiKey": "api-key-value"
  }
}'
```

<!-- endpoint:POST /api/icloud/accounts/:id/apple-account/refresh catalog:d6d1d9c00606 -->
## `POST /api/icloud/accounts/{id}/apple-account/refresh`

**刷新 Apple Account 管理态 / Refresh Apple Account management state**

按 Apple 返回的短期 TTL 刷新 scnt、Cookie 和 apiKey。

> Refresh scnt, cookies, and apiKey using Apple’s short-lived TTL.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 200 · { account } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account/refresh" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:DELETE /api/icloud/accounts/:id/apple-account catalog:fae3663092e5 -->
## `DELETE /api/icloud/accounts/{id}/apple-account`

**移除 Apple Account 管理态 / Remove Apple Account management state**

删除当前账号保存的 Apple Account 管理态，不影响 Apple 账号或已有地址。

> Delete the saved Apple Account management state without affecting the Apple account or existing aliases.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/icloud/accounts/:id/apple-account/login/start catalog:7736a6d31221 -->
## `POST /api/icloud/accounts/{id}/apple-account/login/start`

**开始 Apple Account 登录 / Start Apple Account sign-in**

使用 Apple ID（邮箱或手机号）和密码启动管理态登录；密码只用于本次请求。需要双重认证时返回验证码去向：受信任设备，或没有受信任设备、推送失败时的短信。

> Start management sign-in with an Apple ID (email or phone number) and password; the password is used only for this request. When two-factor authentication is needed, the response says where the code went: trusted devices, or SMS when there are none or the push failed.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · appleId, password, twoFactorMethod?=trusted_device\|phone |
| 成功响应 | 200 · { needs2FA: false, account } \| { needs2FA: true, challengeId, expiresAt, method=trusted_device\|phone, phones: [{ id, number }], phoneId? } |

> 注意：不要向非自有 OmniMail 实例提交 Apple ID 密码。
>
> Note: Never submit an Apple ID password to an OmniMail instance you do not control.

> 注意：同一用户每个 Apple ID 每小时 5 次、每个用户每小时 10 次，超出返回 429 和 Retry-After；Apple ID 与账号已绑定的不一致或已被另一个账号使用时返回 409。
>
> Note: Each user may try an Apple ID 5 times and sign in 10 times per hour; beyond that the answer is 429 with Retry-After. An Apple ID that differs from the one bound to the account, or that another account uses, answers 409.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account/login/start" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "appleId": "owner@example.com",
  "password": "never-log-this"
}'
```

<!-- endpoint:POST /api/icloud/accounts/:id/apple-account/login/sms catalog:acec29566b20 -->
## `POST /api/icloud/accounts/{id}/apple-account/login/sms`

**改用短信接收验证码 / Get the verification code by SMS**

把等待验证码的登录改为短信接收，或重新发送短信；phoneId 取自开始登录时返回的 phones，省略时用第一个。

> Switch a sign-in waiting for its code to SMS, or send the SMS again; phoneId comes from the phones the start returned, the first one when omitted.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · challengeId, phoneId? |
| 成功响应 | 200 · { needs2FA: true, challengeId, expiresAt, method=phone, phones, phoneId } |

> 注意：与提交验证码共用每个挑战 5 次的尝试次数。
>
> Note: Shares the 5 attempts each challenge allows with code submissions.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account/login/sms" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "challengeId": "challenge_id",
  "phoneId": 1
}'
```

<!-- endpoint:POST /api/icloud/accounts/:id/apple-account/login/2fa catalog:65169f13983b -->
## `POST /api/icloud/accounts/{id}/apple-account/login/2fa`

**完成 Apple Account 二次验证 / Complete Apple Account two-factor sign-in**

提交受信任设备或短信收到的 6 位验证码并保存管理态。

> Submit the six-digit code from the trusted device or SMS and save the management state.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · id; JSON · challengeId, code |
| 成功响应 | 200 · { needs2FA: false, account } |

> 注意：验证码错误返回 422，可重试；挑战过期（410）或 5 次尝试用完（429）时响应带 code=apple_login_challenge_gone，需要重新开始登录。
>
> Note: A wrong code answers 422 and may be retried; an expired challenge (410) or one out of its 5 attempts (429) answers with code=apple_login_challenge_gone, and the sign-in has to start over.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/accounts/resource_id/apple-account/login/2fa" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "challengeId": "challenge_id",
  "code": "123456"
}'
```

<!-- endpoint:GET /api/icloud/aliases catalog:9d0e7f9d736e -->
## `GET /api/icloud/aliases`

**同步隐藏邮箱地址 / Sync Hide My Email aliases**

从 Apple 读取指定账户的全部隐藏邮箱地址并刷新 Cookie。

> Read all Hide My Email aliases for an account from Apple and refresh cookies.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Query · accountId |
| 成功响应 | 200 · { aliases, cookieError? } |

> 注意：Cookie 被 Apple 拒绝而 Apple Account 仍可用时，改经 Apple Account 列出地址，并在 cookieError 中说明 Cookie 需要更新。
>
> Note: When Apple rejects the cookies but the Apple Account session still works, the list comes through Apple Account and cookieError says the cookies need replacing.

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/icloud/aliases?accountId=icloud_account_id" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/icloud/aliases/quota catalog:b23738a78c57 -->
## `GET /api/icloud/aliases/quota`

**查询隐藏邮箱创建额度 / Read Hide My Email creation quota**

返回该账户两条创建通道本小时的额度、已用量和恢复时间。

> Return this hour's limit, usage and reset time for both creation channels of the account.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Query · accountId |
| 成功响应 | 200 · { channels: [{ channel, available, limit, used, remaining, resetsAt }] } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/icloud/aliases/quota?accountId=icloud_account_id" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:POST /api/icloud/aliases/preview catalog:5546549e780d -->
## `POST /api/icloud/aliases/preview`

**预览隐藏邮箱地址 / Preview a Hide My Email address**

让 Apple 生成一个尚未创建的候选隐藏邮箱地址。

> Ask Apple for a suggested Hide My Email address without creating it.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · accountId |
| 成功响应 | 200 · { email, previewId } |

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/aliases/preview" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "accountId": "icloud_account_id"
}'
```

<!-- endpoint:POST /api/icloud/aliases catalog:22d76b1c334a -->
## `POST /api/icloud/aliases`

**创建隐藏邮箱地址 / Create a Hide My Email alias**

在指定 iCloud 账户中创建带标签的隐藏地址。

> Create a labeled Hide My Email alias in the selected iCloud account.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | JSON · accountId, label?, channel?=apple_account\|icloud_web, email?, previewId? |
| 成功响应 | 201 · { alias, channel, remaining } |

> 注意：每个账号每条通道按整点小时计额（Apple Account 20、Cookie 5）；用完返回 429 与 Retry-After，正文为 { error, code=icloud_alias_hourly_quota, channel, retryAfter }。
>
> Note: Each channel of each account has an hourly budget (Apple Account 20, cookies 5) that resets on the hour; once spent the answer is 429 with Retry-After and the body { error, code=icloud_alias_hourly_quota, channel, retryAfter }.

> 注意：指定 channel 时只走该通道；省略时优先 Apple Account，仅在其达到 Apple 上限时改用 Cookie。已失效的 Apple Account 直接返回 422，不再请求 Apple。
>
> Note: With channel set, only that channel is used; without it Apple Account goes first and cookies take over only when Apple caps it. An expired Apple Account answers 422 without calling Apple.

### cURL 示例

```bash
curl --request POST \
  --url "https://mail.example.com/api/icloud/aliases" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "accountId": "icloud_account_id",
  "label": "Shopping",
  "channel": "apple_account"
}'
```

<!-- endpoint:PATCH /api/icloud/aliases/:anonymousId catalog:fd74e6b4847c -->
## `PATCH /api/icloud/aliases/{anonymousId}`

**停用或恢复隐藏地址 / Deactivate or reactivate an alias**

对指定 Apple anonymousId 执行停用或恢复。

> Deactivate or reactivate the selected Apple anonymousId.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · anonymousId; JSON · accountId, action=deactivate\|reactivate |
| 成功响应 | 200 · { ok: true, action } |

### cURL 示例

```bash
curl --request PATCH \
  --url "https://mail.example.com/api/icloud/aliases/alias_id" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "accountId": "icloud_account_id",
  "action": "deactivate"
}'
```

<!-- endpoint:DELETE /api/icloud/aliases/:anonymousId catalog:762654e2793c -->
## `DELETE /api/icloud/aliases/{anonymousId}`

**永久删除隐藏地址 / Permanently delete an alias**

从 Apple 永久删除指定隐藏地址并刷新账户统计。

> Permanently delete the alias from Apple and refresh account statistics.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · anonymousId; JSON · accountId |
| 成功响应 | 200 · { ok: true } |

### cURL 示例

```bash
curl --request DELETE \
  --url "https://mail.example.com/api/icloud/aliases/alias_id" \
  --header "Authorization: Bearer om_at_..." \
  --header "Content-Type: application/json" \
  --data '{
  "accountId": "icloud_account_id"
}'
```

<!-- endpoint:GET /api/icloud/inbox catalog:5b5583941f1f -->
## `GET /api/icloud/inbox`

**读取 iCloud 最近来信 / List recent iCloud mail**

通过 IMAP 读取或搜索最近邮件摘要；Web 回退仅过滤当前摘要。

> Read or search recent IMAP message summaries; Web fallback filters current summaries only.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Query · accountId, alias?, q?, limit=1..50?, days=0..365? |
| 成功响应 | 200 · { messages, method=imap\|web } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/icloud/inbox?accountId=icloud_account_id&limit=20&days=7" \
  --header "Authorization: Bearer om_at_..."
```

<!-- endpoint:GET /api/icloud/inbox/:uid catalog:03d3ee97229b -->
## `GET /api/icloud/inbox/{uid}`

**读取 iCloud 邮件正文 / Read an iCloud message**

通过 IMAP UID 读取完整正文，并将未读邮件同步标记为 Seen。

> Read full content by IMAP UID and synchronize unread mail to Seen.

| 项目 | 内容 |
| --- | --- |
| 认证 | 登录用户；支持 Session Cookie 或 Access Token |
| 请求 | Path · uid; Query · accountId |
| 成功响应 | 200 · { message: { …, isRead=true } } |

### cURL 示例

```bash
curl --request GET \
  --url "https://mail.example.com/api/icloud/inbox/123?accountId=icloud_account_id" \
  --header "Authorization: Bearer om_at_..."
```
