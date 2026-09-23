import { z } from 'zod'

const hostSchema = z.string().trim().min(1).max(253)

const jumpHostSchema = z.object({
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64),
  authType: z.enum(['password', 'privateKey']),
  password: z.string().max(1024).optional(),
  privateKeyPath: z.string().max(4096).optional(),
  passphrase: z.string().max(1024).optional(),
  hostFingerprint: z.string().max(256).optional(),
  hasSecret: z.boolean().optional()
})

const accessRouteSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['direct', 'jump']),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64),
  authType: z.enum(['password', 'privateKey']),
  privateKeyPath: z.string().max(4096).optional(),
  hostFingerprint: z.string().max(256).optional(),
  jumpHost: jumpHostSchema.optional()
})

export const serverProfileInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64),
  authType: z.enum(['password', 'privateKey']),
  password: z.string().max(1024).optional(),
  privateKeyPath: z.string().max(4096).optional(),
  passphrase: z.string().max(1024).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  group: z.string().trim().max(64).optional(),
  mode: z.enum(['real', 'demo']).optional(),
  monitorPolicy: z.enum(['manual', 'onView', 'background']).optional(),
  jumpHost: jumpHostSchema.optional(),
  accessRoutes: z.array(accessRouteSchema).max(8).optional(),
  defaultAccessRouteId: z.string().trim().min(1).max(80).optional()
})

export const appSettingsSchema = z.object({
  theme: z.enum(['ocean', 'instrument', 'machineRoom']).default('ocean'),
  monitoringEnabled: z.boolean(),
  pollingIntervalSeconds: z.number().int().min(10).max(3600),
  maxConcurrentPolls: z.number().int().min(1).max(20),
  minimizeToTray: z.boolean(),
  closeBehavior: z.enum(['ask', 'tray', 'exit']).default('ask'),
  notifyOnWarning: z.boolean(),
  gpuWatches: z.array(z.object({
    serverId: z.string().uuid(),
    gpuUuid: z.string().min(1).max(160).optional()
  })).max(500).default([])
})
