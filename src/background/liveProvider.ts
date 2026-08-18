export type ToolCall = {
  id: string
  name: string
  args: unknown
}

export type LiveProviderHandlers = {
  onAudio: (pcm: Uint8Array) => void
  onAudioEnd: () => void
  onTranscript: (text: string, role: "user" | "model") => void
  onToolCall: (call: ToolCall) => void
  onError: (error: Error) => void
}

/** Narrow wire seam. One implementation at a time. No registry or factory. */
export interface LiveProvider {
  connect(handlers: LiveProviderHandlers): Promise<void>
  sendPcm(base64Pcm: string, sampleRate?: number, format?: string): void
  sendToolResponse(id: string, result: unknown): void
  interrupt(): void
  close(): void
}
