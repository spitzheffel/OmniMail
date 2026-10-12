package com.omnimail.android.ui

import com.omnimail.android.data.model.ICloudAccount
import com.omnimail.android.data.model.ICloudAlias
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ICloudAliasCreationTest {
    private val appleOnly = ICloudAccount(
        id = "apple-only",
        name = "Apple only",
        status = "pending",
        hasAppleAccount = true,
        appleAccountStatus = "active",
    )
    private val cookie = ICloudAccount(id = "cookie", name = "Cookie", hasCookies = true)

    @Test
    fun appleAccountOnlyAccountCreatesWithoutTheCookiePreview() {
        assertFalse(appleOnly.needsAliasPreview())
        assertFalse(appleOnly.copy(hasAppPassword = true).needsAliasPreview())
    }

    @Test
    fun accountsWithCookiesKeepThePreviewFlow() {
        assertTrue(cookie.needsAliasPreview())
        assertTrue(appleOnly.copy(hasCookies = true).needsAliasPreview())
    }

    @Test
    fun accountsWithoutAUsableAppleSessionStayOnThePreviewPath() {
        assertTrue(appleOnly.copy(appleAccountStatus = "expired").needsAliasPreview())
        assertTrue(ICloudAccount(id = "imap", name = "IMAP", hasAppPassword = true).needsAliasPreview())
    }

    @Test
    fun aRejectedCookieJarHandsCreationToAWorkingAppleSession() {
        val deadJar = cookie.copy(status = "error")

        assertFalse(appleOnly.copy(hasCookies = true, status = "error").needsAliasPreview())
        // Nothing else to create through: the preview's error names the cookie.
        assertTrue(deadJar.needsAliasPreview())
        assertTrue(deadJar.copy(hasAppleAccount = true, appleAccountStatus = "expired").needsAliasPreview())
    }

    @Test
    fun readsMailOnlyThroughAnAppPasswordOrCookies() {
        assertFalse(appleOnly.readsMail())
        assertTrue(appleOnly.copy(hasAppPassword = true).readsMail())
        assertTrue(cookie.readsMail())
    }

    @Test
    fun managesAliasesOnlyThroughTheCookieJarWithAnAnonymousId() {
        val listed = ICloudAlias(email = "listed@icloud.com", anonymousId = "anon-listed")
        val fromCreate = ICloudAlias(email = "created@icloud.com")

        assertTrue(cookie.managesAlias(listed))
        assertFalse(cookie.managesAlias(fromCreate))
        assertFalse(appleOnly.managesAlias(listed))
        assertFalse(cookie.copy(status = "error").managesAlias(listed))
    }

    @Test
    fun keepsCreatedAliasesThatTheListingLeftOut() {
        val listed = listOf(ICloudAlias(email = "old@icloud.com", anonymousId = "anon-old"))
        val created = listOf(ICloudAlias(email = "new@icloud.com"), ICloudAlias(email = "old@icloud.com"))

        val merged = withCreatedAliases(listed, created)

        assertEquals(listOf("new@icloud.com", "old@icloud.com"), merged.map { it.email })
        assertEquals("anon-old", merged.last().anonymousId)
        assertEquals(listOf(created.first()), withCreatedAliases(emptyList(), created.take(1)))
        assertEquals(listed, withCreatedAliases(listed, emptyList()))
    }
}
