package com.omnimail.android.data.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ICloudAliasRequestTest {
    @Test
    fun appleAccountCreateSendsNoPreviewFields() {
        assertEquals(
            """{"accountId":"apple-only","label":"Shopping"}""",
            Json.encodeToString(CreateICloudAliasRequest("apple-only", "Shopping")),
        )
    }

    @Test
    fun cookieCreateStillReservesThePreviewedAddress() {
        assertEquals(
            """{"accountId":"cookie","label":"Shopping","email":"shop@icloud.com","previewId":"preview-1"}""",
            Json.encodeToString(
                CreateICloudAliasRequest("cookie", "Shopping", "shop@icloud.com", "preview-1"),
            ),
        )
    }

    @Test
    fun readsTheAppleAccountStateAndDefaultsItForOlderServers() {
        val json = Json { ignoreUnknownKeys = true }
        val apple = json.decodeFromString<ICloudAccount>(
            """{"id":"a","name":"A","realEmail":"","hasAppleAccount":true,"appleAccountStatus":"active"}""",
        )
        val legacy = json.decodeFromString<ICloudAccount>(
            """{"id":"b","name":"B","hasCookies":true}""",
        )

        assertTrue(apple.hasAppleAccount)
        assertEquals("active", apple.appleAccountStatus)
        assertFalse(legacy.hasAppleAccount)
        assertEquals("none", legacy.appleAccountStatus)
    }
}
