import { describe, expect, it } from 'vitest'
import { appSettingsSchema } from './schemas'

const settings = {
  monitoringEnabled: false, pollingIntervalSeconds: 120, maxConcurrentPolls: 2,
  minimizeToTray: false, closeBehavior: 'exit', notifyOnWarning: false,
  serverOrder: ['saved-server'], gpuWatches: []
}

describe('theme settings compatibility', () => {
  it('migrates the removed theme while preserving other preferences', () => {
    expect(appSettingsSchema.parse({ ...settings, theme: 'machineRoom' })).toEqual({ ...settings, theme: 'ocean' })
  })

  it('keeps the light theme and supplies a default for older settings', () => {
    expect(appSettingsSchema.parse({ ...settings, theme: 'instrument' }).theme).toBe('instrument')
    expect(appSettingsSchema.parse(settings).theme).toBe('ocean')
  })
})
