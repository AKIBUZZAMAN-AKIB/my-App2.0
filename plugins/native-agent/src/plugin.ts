import { registerPlugin, WebPlugin } from '@capacitor/core'

import type { NativeAgentPlugin } from './definitions'

const ERR = 'NativeAgent is only available on native platforms.'

class NativeAgentWeb extends WebPlugin implements NativeAgentPlugin {
  async checkAvailability(): Promise<any> {
    // Web target: there is no native library, but the probe contract is
    // "resolve, never reject" so UI code can branch on `available`.
    return { abi: 'web', is64Bit: false, available: false, reason: ERR, engineGeneration: 'web' }
  }
  async getEngineFeatures(): Promise<any> {
    // Resolve (not reject) like checkAvailability: the web target simply has
    // no native features, which is what callers feature-detect against.
    return { engineVersion: 'web', features: [] }
  }
  async initWorkspace(): Promise<void> { throw this.unavailable(ERR) }
  async initialize(): Promise<void> { throw this.unavailable(ERR) }
  async getRuntimeConfig(): Promise<any> { throw this.unavailable(ERR) }
  async setRuntimeConfig(): Promise<any> { throw this.unavailable(ERR) }
  async sendMessage(): Promise<any> { throw this.unavailable(ERR) }
  async followUp(): Promise<void> { throw this.unavailable(ERR) }
  async followUpWithAttachments(): Promise<void> { throw this.unavailable(ERR) }
  async abort(): Promise<void> { throw this.unavailable(ERR) }
  async steer(): Promise<void> { throw this.unavailable(ERR) }
  async respondToApproval(): Promise<void> { throw this.unavailable(ERR) }
  async respondToApprovalWithArgs(): Promise<any> { throw this.unavailable(ERR) }
  async respondToMcpTool(): Promise<void> { throw this.unavailable(ERR) }
  async respondToProviderRequest(): Promise<void> { throw this.unavailable(ERR) }
  async getAuthToken(): Promise<any> { throw this.unavailable(ERR) }
  async setAuthKey(): Promise<void> { throw this.unavailable(ERR) }
  async deleteAuth(): Promise<void> { throw this.unavailable(ERR) }
  async refreshToken(): Promise<any> { throw this.unavailable(ERR) }
  async getAuthStatus(): Promise<any> { throw this.unavailable(ERR) }
  async exchangeOAuthCode(): Promise<any> { throw this.unavailable(ERR) }
  async listSessions(): Promise<any> { throw this.unavailable(ERR) }
  async loadSession(): Promise<any> { throw this.unavailable(ERR) }
  async resumeSession(): Promise<void> { throw this.unavailable(ERR) }
  async clearSession(): Promise<void> { throw this.unavailable(ERR) }
  async rewindSession(): Promise<any> { throw this.unavailable(ERR) }
  async forkSession(): Promise<any> { throw this.unavailable(ERR) }
  async countTokens(): Promise<any> { throw this.unavailable(ERR) }
  async listToolRules(): Promise<any> { throw this.unavailable(ERR) }
  async setToolRules(): Promise<any> { throw this.unavailable(ERR) }
  async purgeAttachment(): Promise<any> { throw this.unavailable(ERR) }
  async addCronJob(): Promise<any> { throw this.unavailable(ERR) }
  async updateCronJob(): Promise<void> { throw this.unavailable(ERR) }
  async removeCronJob(): Promise<void> { throw this.unavailable(ERR) }
  async listCronJobs(): Promise<any> { throw this.unavailable(ERR) }
  async runCronJob(): Promise<void> { throw this.unavailable(ERR) }
  async listCronRuns(): Promise<any> { throw this.unavailable(ERR) }
  async handleWake(): Promise<any> { throw this.unavailable(ERR) }
  async getSchedulerConfig(): Promise<any> { throw this.unavailable(ERR) }
  async setSchedulerConfig(): Promise<void> { throw this.unavailable(ERR) }
  async setHeartbeatConfig(): Promise<void> { throw this.unavailable(ERR) }
  async scheduleBackgroundWakes(): Promise<any> { throw this.unavailable(ERR) }
  async cancelBackgroundWakes(): Promise<any> { throw this.unavailable(ERR) }
  async getWakeStatus(): Promise<any> { throw this.unavailable(ERR) }
  async loadSurfacedMessages(): Promise<any> { throw this.unavailable(ERR) }
  async clearSurfacedMessages(): Promise<any> { throw this.unavailable(ERR) }
  async respondToCronApproval(): Promise<void> { throw this.unavailable(ERR) }
  async addSkill(): Promise<any> { throw this.unavailable(ERR) }
  async updateSkill(): Promise<void> { throw this.unavailable(ERR) }
  async removeSkill(): Promise<void> { throw this.unavailable(ERR) }
  async listSkills(): Promise<any> { throw this.unavailable(ERR) }
  async startSkill(): Promise<any> { throw this.unavailable(ERR) }
  async endSkill(): Promise<void> { throw this.unavailable(ERR) }
  async startMcp(): Promise<any> { throw this.unavailable(ERR) }
  async restartMcp(): Promise<any> { throw this.unavailable(ERR) }
  async removeMcpTools(): Promise<any> { throw this.unavailable(ERR) }
  async getModels(): Promise<any> { throw this.unavailable(ERR) }
  async invokeTool(): Promise<any> { throw this.unavailable(ERR) }
  async seedToolPermissions(): Promise<any> { throw this.unavailable(ERR) }
  async setToolPermission(): Promise<void> { throw this.unavailable(ERR) }
  async listToolPermissions(): Promise<any> { throw this.unavailable(ERR) }
  async resetToolPermissions(): Promise<void> { throw this.unavailable(ERR) }
}

export const NativeAgent = registerPlugin<NativeAgentPlugin>('NativeAgent', {
  web: () => Promise.resolve(new NativeAgentWeb()),
})
