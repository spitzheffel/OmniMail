import { ICloudAliasQuotaError } from './icloud-alias-quota'
import { ICloudRemoteError } from './icloud-apple'
import { ICloudStoreError } from './icloud-store-error'

export function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The request body as a JSON object; anything else is the caller's mistake, never a server error. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json<unknown>()
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new ICloudStoreError(400, '请求体必须是 JSON 对象。')
  }
}

/**
 * The response for a failed iCloud request. `detail` stays out of `error` so
 * the client can still translate the message; anything unexpected is logged
 * under `context` and answered without blaming a channel it may not involve.
 */
export function iCloudErrorResponse(
  error: unknown,
  context: string,
  fallback = 'iCloud 暂时无法处理这个请求。',
): Response {
  if (error instanceof ICloudAliasQuotaError) {
    return Response.json(
      { error: error.message, code: error.code, channel: error.channel, retryAfter: error.retryAfter },
      { status: error.status, headers: { 'Retry-After': String(error.retryAfter) } },
    )
  }
  if (error instanceof ICloudRemoteError) {
    return Response.json(
      error.detail ? { error: error.message, detail: error.detail } : { error: error.message },
      { status: error.status },
    )
  }
  if (error instanceof ICloudStoreError) {
    return Response.json({
      error: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.code ? { code: error.code } : {}),
    }, { status: error.status })
  }
  console.error(context, error)
  return Response.json({ error: fallback }, { status: 500 })
}
