export const APP_NAME = "pi-crust" as const;
export const PROTOCOL_VERSION = 1 as const;

export function getVersionSummary(): string {
  return `${APP_NAME}:protocol-${PROTOCOL_VERSION}`;
}
