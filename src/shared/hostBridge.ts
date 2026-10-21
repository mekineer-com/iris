type BackgroundBridge = {
  __mentraInitCallback?: (sessionId: string) => void
  __mentraDeliverBridgeRaw?: (raw: string) => void
  __initCallback?: (sessionId: string) => void
  __deliverBridgeRaw?: (raw: string) => void
}

type UiBridge = {
  mentra?: typeof mentra
  glassly?: typeof mentra
  MentraOS?: Window["MentraOS"]
  Glassly?: Window["MentraOS"]
}

export function installBackgroundBridge(host: BackgroundBridge = globalThis as BackgroundBridge): void {
  // The SDK installs and removes its delivery callback as the transport opens/closes.
  host.__initCallback = sessionId => host.__mentraInitCallback!(sessionId)
  host.__deliverBridgeRaw = raw => host.__mentraDeliverBridgeRaw?.(raw)
}

export function installUiBridge(host: UiBridge = globalThis as UiBridge): void {
  if (!host.mentra && host.glassly) host.mentra = host.glassly
  if (!host.MentraOS && host.Glassly) host.MentraOS = host.Glassly
}
