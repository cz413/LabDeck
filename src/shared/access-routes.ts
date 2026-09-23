import type { ServerAccessRoute, ServerProfile } from './types'

const directRoute = (profile: ServerProfile): ServerAccessRoute => ({
  id: 'direct',
  name: '默认',
  kind: 'direct',
  host: profile.host,
  port: profile.port,
  username: profile.username,
  authType: profile.authType,
  privateKeyPath: profile.privateKeyPath,
  hostFingerprint: profile.hostFingerprint
})

/**
 * Return the explicit routes when available and transparently adapt profiles
 * written by older versions.  Legacy profiles with a jumpHost expose both
 * the normal internal path and the jump path under the same server id.
 */
export function getAccessRoutes(profile: ServerProfile): ServerAccessRoute[] {
  if (profile.accessRoutes?.length) return profile.accessRoutes.map((route) => ({
    ...route,
    name: route.kind === 'jump' ? '跳板机' : route.kind === 'direct' ? '默认' : route.name,
    jumpHost: route.jumpHost ? { ...route.jumpHost } : undefined
  }))
  const routes = [directRoute(profile)]
  if (profile.jumpHost) {
    routes.push({
      ...directRoute(profile),
      id: 'jump',
      name: '跳板机',
      kind: 'jump',
      jumpHost: { ...profile.jumpHost }
    })
  }
  return routes
}

export function getDefaultAccessRouteId(profile: ServerProfile): string {
  const routes = getAccessRoutes(profile)
  if (profile.defaultAccessRouteId && routes.some((route) => route.id === profile.defaultAccessRouteId)) return profile.defaultAccessRouteId
  return routes[0]?.id ?? 'direct'
}

export function getAccessRoute(profile: ServerProfile, accessRouteId?: string): ServerAccessRoute {
  const routes = getAccessRoutes(profile)
  return routes.find((route) => route.id === accessRouteId) ?? routes.find((route) => route.id === getDefaultAccessRouteId(profile)) ?? routes[0] ?? directRoute(profile)
}

/** Apply a route while keeping the stable server id/name used by snapshots. */
export function applyAccessRoute(profile: ServerProfile, accessRouteId?: string): ServerProfile {
  const route = getAccessRoute(profile, accessRouteId)
  return {
    ...profile,
    host: route.host,
    port: route.port,
    username: route.username,
    authType: route.authType,
    privateKeyPath: route.privateKeyPath,
    hostFingerprint: route.hostFingerprint,
    jumpHost: route.kind === 'jump' ? (route.jumpHost ? { ...route.jumpHost } : undefined) : undefined
  }
}

export function routeLabel(profile: ServerProfile, accessRouteId?: string): string {
  return getAccessRoute(profile, accessRouteId).name
}
