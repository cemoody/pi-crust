import type { AuthProviderInfo, OAuthLoginSnapshot } from "../api/session-api.js";

export interface LoginDialogApi {
  listAuthProviders(): Promise<{ readonly providers: readonly AuthProviderInfo[] }>;
  login(provider: string, apiKey: string): Promise<unknown>;
  startOAuthLogin(provider: string): Promise<OAuthLoginSnapshot>;
  pollOAuthLogin(flowId: string, cursor: number): Promise<OAuthLoginSnapshot>;
  submitOAuthLogin(flowId: string, requestId: string, value: string): Promise<OAuthLoginSnapshot>;
  cancelOAuthLogin(flowId: string): Promise<OAuthLoginSnapshot>;
}
