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
  // Keep older settings readable without discarding the rest of the user's data.
  theme: z.enum(['ocean', 'instrument', 'machineRoom']).default('ocean')
    .transform((theme) => theme === 'machineRoom' ? 'ocean' : theme),
  monitoringEnabled: z.boolean(),
  pollingIntervalSeconds: z.number().int().min(10).max(3600),
  maxConcurrentPolls: z.number().int().min(1).max(20),
  minimizeToTray: z.boolean(),
  closeBehavior: z.enum(['ask', 'tray', 'exit']).default('ask'),
  notifyOnWarning: z.boolean(),
  serverOrder: z.array(z.string().trim().min(1).max(80)).max(1000).default([]),
  gpuWatches: z.array(z.object({
    serverId: z.string().uuid(),
    gpuUuid: z.string().min(1).max(160).optional()
  })).max(500).default([])
})

export const condaEnvironmentConfigSchema = z.object({
  manager: z.enum(['conda', 'mamba', 'micromamba']),
  managerPath: z.string().trim().max(4096).optional(),
  environmentName: z.string().trim().max(160).optional(),
  environmentPrefix: z.string().trim().max(4096).optional(),
  environmentFilePath: z.string().trim().max(4096).optional(),
  pythonInterpreterPath: z.string().trim().max(4096).optional(),
  pythonVersion: z.string().trim().max(80).optional(),
  lastCheckStatus: z.enum(['found', 'missing', 'unknown']).optional(),
  lastCheckedAt: z.string().datetime().optional()
}).superRefine((value, context) => {
  if (value.environmentName && value.environmentPrefix) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Conda 环境名和前缀路径只能填写一项' })
  }
  if (value.environmentPrefix && (!value.environmentPrefix.startsWith('/') || value.environmentPrefix.includes('\0'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['environmentPrefix'], message: 'Conda 环境前缀必须是服务器上的绝对路径' })
  }
  if (value.environmentFilePath && (!value.environmentFilePath.startsWith('/') || value.environmentFilePath.includes('\0'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['environmentFilePath'], message: 'environment.yml 必须是服务器上的绝对路径' })
  }
  for (const key of ['managerPath', 'environmentName', 'pythonInterpreterPath'] as const) {
    if (value[key]?.includes('\0')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Conda 配置不能包含空字符' })
    }
  }
  if (value.pythonInterpreterPath && !value.pythonInterpreterPath.startsWith('/')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pythonInterpreterPath'], message: 'Python 解释器必须是服务器上的绝对路径' })
  }
})

const experimentRunSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().min(1),
  status: z.enum(['queued', 'preparing', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  queuedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  serverId: z.string().uuid().optional(),
  serverNameSnapshot: z.string().max(160).optional(),
  accessRouteId: z.string().max(80).optional(),
  gpuUuid: z.string().max(160).optional(),
  gpuIndex: z.number().int().min(0).optional(),
  gpuNameSnapshot: z.string().max(160).optional(),
  codePath: z.string().max(4096).optional(),
  dataPath: z.string().max(4096).optional(),
  launchCommand: z.string().max(20_000).optional(),
  condaEnvironment: condaEnvironmentConfigSchema.optional(),
  artifactPath: z.string().max(4096).optional(),
  minimumFreeVramGiB: z.number().positive().max(1024).nullable().optional(),
  maximumGpuUtilizationPercent: z.number().min(0).max(100).nullable().optional(),
  message: z.string().max(2000).optional(),
  remotePid: z.number().int().positive().optional(),
  remoteRunDir: z.string().max(4096).optional(),
  logPath: z.string().max(4096).optional(),
  resultSummary: z.string().max(4000).default(''),
  notes: z.string().max(8000).default('')
})

export const experimentTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  project: z.string().trim().max(160).default(''),
  objective: z.string().max(4000).default(''),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  status: z.enum(['planned', 'queued', 'preparing', 'running', 'paused', 'completed', 'failed', 'cancelled']).default('planned'),
  serverId: z.string().uuid().optional(),
  serverNameSnapshot: z.string().max(160).optional(),
  accessRouteId: z.string().max(80).optional(),
  gpuUuid: z.string().max(160).optional(),
  gpuIndex: z.number().int().min(0).optional(),
  gpuNameSnapshot: z.string().max(160).optional(),
  codePath: z.string().max(4096).default(''),
  dataPath: z.string().max(4096).default(''),
  launchCommand: z.string().max(20_000).default(''),
  condaEnvironment: condaEnvironmentConfigSchema.optional(),
  minimumFreeVramGiB: z.number().positive().max(1024).optional(),
  maximumGpuUtilizationPercent: z.number().min(0).max(100).optional(),
  artifactPath: z.string().max(4096).default(''),
  resultSummary: z.string().max(4000).default(''),
  notes: z.string().max(8000).default(''),
  archived: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  runs: z.array(experimentRunSchema).max(10_000).default([])
})

export const experimentTaskDraftSchema = experimentTaskSchema.omit({
  createdAt: true,
  updatedAt: true,
  archived: true,
  runs: true
}).extend({ id: z.string().uuid().optional() })

export const experimentTaskStatusSchema = z.enum(['planned', 'queued', 'preparing', 'running', 'paused', 'completed', 'failed', 'cancelled'])

export const experimentRunFinishInputSchema = z.object({
  status: z.enum(['paused', 'completed', 'failed', 'cancelled']),
  resultSummary: z.string().max(4000),
  notes: z.string().max(8000),
  artifactPath: z.string().max(4096)
})

export const experimentRunStartInputSchema = z.object({
  serverId: z.string().uuid().nullable(),
  accessRouteId: z.string().max(80).nullable(),
  gpuUuid: z.string().max(160).nullable(),
  gpuIndex: z.number().int().min(0).nullable(),
  gpuNameSnapshot: z.string().max(160).nullable(),
  codePath: z.string().max(4096),
  dataPath: z.string().max(4096),
  launchCommand: z.string().max(20_000),
  condaEnvironment: condaEnvironmentConfigSchema.nullable(),
  artifactPath: z.string().max(4096),
  minimumFreeVramGiB: z.number().positive().max(1024).nullable(),
  maximumGpuUtilizationPercent: z.number().min(0).max(100).nullable(),
  notes: z.string().max(8000)
})
