package com.omnimail.android.ui

import com.omnimail.android.data.model.ICloudAccount
import com.omnimail.android.data.model.ICloudAlias

/**
 * A cookie jar Apple has not rejected. A rejected one leaves the account in
 * "error" until a listing finds it working again; the Worker stops offering it
 * as a channel, so the app does not route creates or alias changes through it.
 */
internal fun ICloudAccount.hasWorkingCookies(): Boolean = hasCookies && status != "error"

/**
 * Whether creating an alias for this account starts with the cookie-only
 * /api/icloud/aliases/preview. Accounts with a working cookie jar keep that flow
 * unchanged. Without one, an account with an Apple Account session sends a
 * plain { accountId, label } and the Worker creates through that session, as
 * long as Apple has not rejected it. An expired one stays on the old path,
 * whose error asks for a cookie.
 */
internal fun ICloudAccount.needsAliasPreview(): Boolean =
    hasWorkingCookies() || !hasAppleAccount || appleAccountStatus == "expired"

/**
 * Whether /api/icloud/inbox has anything to read this account with: IMAP through
 * an app-specific password, or the cookie jar's Web summaries. An Apple Account
 * session only manages aliases, and the inbox refuses such an account outright.
 */
internal fun ICloudAccount.readsMail(): Boolean = hasCookies || hasAppPassword

/**
 * Deactivate, reactivate and delete go through the cookie jar and address the
 * alias by Apple's anonymousId, which an alias kept from a create response lacks.
 */
internal fun ICloudAccount.managesAlias(alias: ICloudAlias): Boolean =
    hasWorkingCookies() && alias.anonymousId.isNotBlank()

/**
 * Keeps aliases that were just created visible when the fresh listing leaves
 * them out. Apple's list can lag behind a create, and regions without it list
 * nothing for an Apple-Account-only account, whose dialog never previewed the
 * address, so the user would otherwise never see what was created.
 */
internal fun withCreatedAliases(
    listed: List<ICloudAlias>,
    created: List<ICloudAlias>,
): List<ICloudAlias> = created.filter { alias -> listed.none { it.email == alias.email } } + listed
