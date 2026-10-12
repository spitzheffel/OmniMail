import { Hono, type Context } from 'hono'
import type { AppContext } from '../../app/context'
import { clientIp } from '../../shared/http/api-helpers'
import type { Defer } from './icloud-apple-session'
import {
  sendAppleAccountLoginSms,
  startAppleAccountLogin,
  submitAppleAccountLogin2FA,
} from './icloud-account-auth'
import {
  createICloudAccount,
  createICloudAlias,
  deleteICloudAccount,
  deleteICloudAppleAccount,
  deleteICloudAlias,
  getICloudAliasQuota,
  getICloudMessage,
  listICloudAccounts,
  listICloudAliases,
  listICloudInbox,
  previewICloudAlias,
  refreshICloudAppleAccount,
  updateICloudAlias,
  updateICloudAccountName,
  updateICloudAppPassword,
  updateICloudAppleAccount,
  updateICloudCookies,
} from './icloud-api'

export const iCloudRoutes = new Hono<AppContext>()

/** Lets an Apple call finish after a disconnect: it may already have rotated the session or committed. */
function defer(context: Context<AppContext>): Defer {
  return (task) => context.executionCtx.waitUntil(task)
}

iCloudRoutes.get('/icloud/accounts', (context) => (
  listICloudAccounts(context.env, context.get('user'))
))
iCloudRoutes.post('/icloud/accounts', (context) => (
  createICloudAccount(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.patch('/icloud/accounts/:id', (context) => (
  updateICloudAccountName(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.delete('/icloud/accounts/:id', (context) => (
  deleteICloudAccount(
    context.env,
    context.get('user'),
    context.req.param('id'),
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.put('/icloud/accounts/:id/cookies', (context) => (
  updateICloudCookies(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.put('/icloud/accounts/:id/apple-account', (context) => (
  updateICloudAppleAccount(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.post('/icloud/accounts/:id/apple-account/refresh', (context) => (
  refreshICloudAppleAccount(context.env, context.get('user'), context.req.param('id'), defer(context))
))
iCloudRoutes.delete('/icloud/accounts/:id/apple-account', (context) => (
  deleteICloudAppleAccount(
    context.env,
    context.get('user'),
    context.req.param('id'),
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.post('/icloud/accounts/:id/apple-account/login/start', (context) => (
  startAppleAccountLogin(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
    defer(context),
  )
))
iCloudRoutes.post('/icloud/accounts/:id/apple-account/login/sms', (context) => (
  sendAppleAccountLoginSms(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    defer(context),
  )
))
iCloudRoutes.post('/icloud/accounts/:id/apple-account/login/2fa', (context) => (
  submitAppleAccountLogin2FA(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
    defer(context),
  )
))
iCloudRoutes.put('/icloud/accounts/:id/app-password', (context) => (
  updateICloudAppPassword(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.get('/icloud/aliases', (context) => (
  listICloudAliases(context.env, context.get('user'), context.req.raw, defer(context))
))
iCloudRoutes.post('/icloud/aliases', (context) => (
  createICloudAlias(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
    defer(context),
  )
))
iCloudRoutes.get('/icloud/aliases/quota', (context) => (
  getICloudAliasQuota(context.env, context.get('user'), context.req.raw)
))
iCloudRoutes.post('/icloud/aliases/preview', (context) => (
  previewICloudAlias(context.env, context.get('user'), context.req.raw)
))
iCloudRoutes.patch('/icloud/aliases/:anonymousId', (context) => (
  updateICloudAlias(
    context.env,
    context.get('user'),
    context.req.param('anonymousId'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.delete('/icloud/aliases/:anonymousId', (context) => (
  deleteICloudAlias(
    context.env,
    context.get('user'),
    context.req.param('anonymousId'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))
iCloudRoutes.get('/icloud/inbox', (context) => (
  listICloudInbox(context.env, context.get('user'), context.req.raw)
))
iCloudRoutes.get('/icloud/inbox/:uid', (context) => (
  getICloudMessage(
    context.env,
    context.get('user'),
    context.req.param('uid'),
    context.req.raw,
  )
))
